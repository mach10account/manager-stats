// ms-assistente — assistente AI del team Salone Vincente.
//
// Risponde su due basi:
//   1. le procedure operative (tabella kb_documenti, sincronizzata dal Drive da WF-KB);
//   2. i dati della piattaforma, interrogati SEMPRE con il JWT di chi sta scrivendo.
//
// Il punto chiave della sicurezza: non esiste un modello di permessi separato.
// Ogni query dati passa dal token dell'utente, quindi la RLS gia' in produzione
// (ms_puo / ms_centri_scope) decide cosa e' visibile. Un consulente vede i suoi
// centri, un admin vede tutto: identico a cio' che gia' vedono nella dashboard.

import Anthropic from "npm:@anthropic-ai/sdk";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON =
  Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
  "";
const MODELLO = Deno.env.get("ASSISTENTE_MODELLO") ?? "claude-opus-5";
const EFFORT = Deno.env.get("ASSISTENTE_EFFORT") ?? "medium";
const MAX_GIRI = 8;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Fonti dati interrogabili. La RLS resta l'unico vero controllo: questa lista
// serve a evitare che il modello tiri a indovinare nomi di tabelle.
const FONTI: Record<string, string> = {
  v_panoramica_centro:
    "KPI marketing per centro e giorno. Colonne: centro_id, giorno (date), centro, consulente, stato_attivita, spesa, impression, lead_fb, lead_reali, appuntamenti, presenze, non_presentati, pacchetti, ricavo, potenziale.",
  v_mkt_leads:
    "Un record per lead. Colonne: notion_id, centro_id, centro, consulente, creazione, giorno (date), mese_coorte, esito, esito_class, is_appuntamento (bool), setter, fonte_ingresso, campaign_name, adset_name, ad_name.",
  v_appuntamenti:
    "Un record per appuntamento. Colonne: centro_id, centro, data_appuntamento, giorno_appuntamento (date), giorno_presa (date), esito_prenotazione, show_status, is_show, is_no_show, is_vendita, is_svolto, pacchetto, ammontare_oggi, valore_pacchetto, campaign_name, ad_name.",
  v_calls:
    "Chiamate CRM4 ai lead dei centri. Colonne: deal_id, giorno (date), centro, setter, esito, esito_class, is_answered, is_appointment, duration_sec, conversation_sec, operator_notes.",
  v_notion_contratti:
    "Contratti firmati (fonte di verita' sui contratti). Colonne: id_contratto, nome_centro, creazione_contratto (date), inizio_servizio, fine_servizio, stato[], agenzia[], servizio[], durata[], valore, incassato, venditore[], setter[].",
  v_notion_incassi:
    "Rate incassate e da incassare. Colonne: id_incasso, nome_centro, id_contratto, importo, rata_numero, pagato (bool), data_incasso (date), data_scadenza (date), venditore[], setter[], consulente.",
  v_notion_clienti:
    "Anagrafica clienti. Colonne: nome_centro, id_cliente, referente, stato_attivita[], consulente[], media_buyer[], beauty[], inizio_servizio, fine_servizio, data_rinnovo, active_days, valore_totale, incassi_totali.",
  v_set_opportunita:
    "Opportunita' commerciali B2B (GHL). Colonne: id, nome, stage, bucket, status, valore, creata_a, cambio_stage_a, assegnato_a, conta_show, conta_appuntamento. ATTENZIONE: conserva solo l'ULTIMO cambio stage, quindi i mesi passati cambiano nel tempo.",
  v_set_chiamate:
    "Chiamate dei setter B2B. Vedi le colonne con una query esplorativa (limite 1) prima di usarla.",
  centri:
    "Anagrafica centri. Colonne: notion_id, nome, consulente, media_buyer, beauty, stato_attivita[], inizio_servizio, fine_servizio, data_rinnovo, agenzia[].",
  ms_task:
    "Task del team. Vedi le colonne con una query esplorativa (limite 1) prima di usarla.",
  fin_pnl: "Conto economico dei mesi chiusi. SOLO ADMIN.",
  fin_costi: "Registro costi: e' lo stato di OGGI, inaffidabile sul passato. SOLO ADMIN.",
  fin_marketing: "KPI marketing mensili dal foglio KPI ALL 3. SOLO ADMIN.",
  fin_vendita: "Dati vendita mensili. SOLO ADMIN.",
};

const REGOLE_DATI = `CONVENZIONI DI CALCOLO — sbagliarle produce numeri falsi:
- I rapporti si calcolano SEMPRE dai totali del periodo, mai come media dei rapporti riga per riga.
- CPL = spesa / lead_fb · % show = presenze / (presenze + non_presentati) · % chiusura = pacchetti / presenze.
- Campo vuoto non e' zero. Se manca il numeratore, dillo invece di scrivere 0.
- "Appuntamento fissato" per i centri = esito del lead con esito_class 'appuntamento' in v_mkt_leads, MAI il numero di righe in v_appuntamenti (che include i disdetti).
- Le risposte alle chiamate sono is_answered sull'ultima chiamata CRM4, non si deducono dall'esito Notion.
- Coorte = mese di CREAZIONE del lead (mese_coorte).
- I contratti si leggono da v_notion_contratti, mai da fin_contratti.
- Nel P&L i mesi chiusi vengono dal foglio (fin_pnl); il mese in corso e' parziale.
- Churn di un mese = dei contratti (v_notion_contratti) con fine_servizio in quel mese, quanti NON hanno un contratto successivo per lo stesso nome_centro creato entro fine_servizio + 60 giorni. NON e' "persi del mese / clienti in gestione" e non si calcola su centri.fine_servizio, che al rinnovo non viene aggiornata. Gli ultimi 2 mesi sono provvisori (la tolleranza non e' ancora scaduta) e va detto.
- "Clienti persi nel mese" (tile Sauron) = DATA CLIENTE PERSO in quel mese: e' la data in cui li abbiamo SEGNATI persi, non quella in cui se ne sono andati. Meta' dei persi non ha quella data compilata.`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** GET su PostgREST con il token dell'utente: la RLS fa il filtro. */
async function pg(path: string, jwt: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      // se l'env var non e' iniettata, il JWT dell'utente vale anche come apikey
      apikey: ANON || jwt,
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json",
    },
  });
  const testo = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${testo.slice(0, 300)}`);
  return testo ? JSON.parse(testo) : [];
}

async function rpc(nome: string, args: unknown, jwt: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nome}`, {
    method: "POST",
    headers: {
      // se l'env var non e' iniettata, il JWT dell'utente vale anche come apikey
      apikey: ANON || jwt,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(args),
  });
  const testo = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${testo.slice(0, 300)}`);
  return testo ? JSON.parse(testo) : [];
}

/** INSERT su PostgREST con il token dell'utente (la RLS lega la riga a lui). */
async function pgInsert(tabella: string, righe: unknown, jwt: string, ritorna = false) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabella}`, {
    method: "POST",
    headers: {
      apikey: ANON || jwt,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      Prefer: ritorna ? "return=representation" : "return=minimal",
    },
    body: JSON.stringify(righe),
  });
  const testo = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${testo.slice(0, 300)}`);
  return testo ? JSON.parse(testo) : [];
}

/** Titolo leggibile per lo storico, ricavato dalla prima domanda. */
function titoloDa(testo: string) {
  const t = String(testo).replace(/\s+/g, " ").trim();
  if (t.length <= 60) return t || "Nuova conversazione";
  const taglio = t.slice(0, 60);
  const spazio = taglio.lastIndexOf(" ");
  return (spazio > 30 ? taglio.slice(0, spazio) : taglio) + "…";
}

const STRUMENTI = [
  {
    name: "leggi_procedura",
    description:
      "Restituisce il testo integrale di una procedura. Usa il codice quando esiste (es. 'F1.P03'), altrimenti il titolo esatto dall'indice. Leggi la procedura prima di descriverne i passaggi: non ricostruirla dal sommario dell'indice.",
    input_schema: {
      type: "object",
      properties: {
        codice: {
          type: "string",
          description: "Codice della procedura, es. F4.P02.",
        },
        titolo: {
          type: "string",
          description:
            "Titolo esatto come compare nell'indice, se la procedura non ha codice.",
        },
      },
    },
  },
  {
    name: "cerca_procedure",
    description:
      "Ricerca full-text nel testo di tutte le procedure. Usala quando l'indice non basta a capire dove sta la risposta: restituisce gli estratti piu' rilevanti con il codice del documento.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Parole chiave in italiano, es. 'acconto non versato'.",
        },
        quanti: { type: "integer", description: "Da 1 a 10, default 5." },
      },
      required: ["query"],
    },
  },
  {
    name: "interroga_dati",
    description:
      "Interroga i dati della piattaforma via PostgREST. Restituisce SOLO cio' che l'utente collegato ha diritto di vedere: non serve (e non funziona) filtrare a mano per centro o per consulente per motivi di permessi. Per capire le colonne di una fonte che non conosci, fai prima una query con limite 1.",
    input_schema: {
      type: "object",
      properties: {
        fonte: {
          type: "string",
          description: "Nome della vista o tabella, dall'elenco delle fonti.",
        },
        colonne: {
          type: "string",
          description:
            "Sintassi select di PostgREST. Per aggregare usa la forma 'col.sum(),col2.avg()' insieme a raggruppa. Default '*'.",
        },
        filtri: {
          type: "array",
          items: { type: "string" },
          description:
            "Filtri PostgREST, uno per elemento, es. ['giorno=gte.2026-07-01','giorno=lte.2026-07-31','centro=eq.Arcadia']. Operatori: eq, neq, gt, gte, lt, lte, like, ilike, in, is.",
        },
        raggruppa: {
          type: "string",
          description:
            "Colonne di raggruppamento separate da virgola, da usare insieme alle aggregazioni in 'colonne'.",
        },
        ordine: {
          type: "string",
          description: "Es. 'giorno.desc' oppure 'ricavo.desc.nullslast'.",
        },
        limite: { type: "integer", description: "Default 100, massimo 1000." },
      },
      required: ["fonte"],
    },
  },
];

async function eseguiStrumento(
  nome: string,
  input: Record<string, unknown>,
  jwt: string,
  fonti: string[],
) {
  if (nome === "leggi_procedura") {
    const codice = String(input.codice ?? "").trim();
    const titolo = String(input.titolo ?? "").trim();
    let q = "";
    if (codice) q = `codice=eq.${encodeURIComponent(codice)}`;
    else if (titolo) q = `titolo=eq.${encodeURIComponent(titolo)}`;
    else return "Serve il codice o il titolo della procedura.";
    const righe = await pg(
      `kb_documenti?${q}&attivo=is.true&select=codice,titolo,flusso,percorso,tipo,testo,drive_id&limit=1`,
      jwt,
    );
    if (!righe.length) {
      return `Nessuna procedura trovata per ${codice || titolo}. Controlla l'indice o usa cerca_procedure.`;
    }
    const d = righe[0];
    fonti.push(`${d.codice ? d.codice + " — " : ""}${d.titolo}`);
    return `# ${d.codice ? d.codice + " — " : ""}${d.titolo}\n(cartella: ${d.percorso})\n\n${d.testo}`;
  }

  if (nome === "cerca_procedure") {
    const righe = await rpc(
      "kb_cerca",
      { q: String(input.query ?? ""), n: Number(input.quanti ?? 5) },
      jwt,
    );
    if (!righe.length) return "Nessun riscontro nelle procedure.";
    return righe
      .map(
        (r: Record<string, unknown>) =>
          `[${r.codice ?? "—"}] ${r.titolo} (${r.flusso})\n${r.estratto}`,
      )
      .join("\n\n");
  }

  if (nome === "interroga_dati") {
    const fonte = String(input.fonte ?? "");
    if (!Object.prototype.hasOwnProperty.call(FONTI, fonte)) {
      return `Fonte "${fonte}" non disponibile. Fonti ammesse: ${Object.keys(FONTI).join(", ")}.`;
    }
    const parti: string[] = [];
    const colonne = String(input.colonne ?? "*").trim() || "*";
    parti.push(`select=${encodeURIComponent(colonne)}`);
    for (const f of (input.filtri as string[] | undefined) ?? []) {
      const s = String(f).trim();
      if (!s) continue;
      const i = s.indexOf("=");
      if (i < 1) continue;
      parti.push(
        `${encodeURIComponent(s.slice(0, i))}=${encodeURIComponent(s.slice(i + 1))}`,
      );
    }
    if (input.ordine) parti.push(`order=${encodeURIComponent(String(input.ordine))}`);
    const limite = Math.min(Math.max(Number(input.limite ?? 100), 1), 1000);
    parti.push(`limit=${limite}`);
    const url = `${fonte}?${parti.join("&")}`;
    try {
      const dati = await pg(url, jwt);
      const testo = JSON.stringify(dati);
      // Un risultato enorme non aiuta il modello e costa: taglialo dicendolo.
      if (testo.length > 60000) {
        return `Risultato troppo grande (${dati.length} righe). Rifai la query aggregando o restringendo il periodo.\nPrime righe: ${JSON.stringify(dati.slice(0, 20))}`;
      }
      if (!dati.length) {
        return "Nessuna riga. Puo' voler dire che non ci sono dati per quel filtro, oppure che l'utente non ha visibilita' su quei centri.";
      }
      return testo;
    } catch (e) {
      return `Query fallita: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return `Strumento sconosciuto: ${nome}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ errore: "Usa POST." }, 405);

  const chiave = Deno.env.get("ANTHROPIC_API_KEY");

  const auth = req.headers.get("Authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ errore: "Sessione assente." }, 401);

  let corpo: Record<string, unknown> = {};
  try {
    corpo = await req.json();
  } catch {
    return json({ errore: "Corpo non valido." }, 400);
  }

  // Controllo di salute: dice cosa e' configurato senza rivelare nulla.
  // Con {diagnostica: "completa"} prova davvero il modello: e' l'unico modo di
  // sapere che la chiave e' valida e che l'account arriva a Opus 5 senza dover
  // fare una domanda vera da un account del team.
  if (corpo.diagnostica) {
    let lettura = "ok";
    try {
      await pg("kb_documenti?select=drive_id&limit=1", jwt);
    } catch (e) {
      lettura = e instanceof Error ? e.message : String(e);
    }
    let modelloRisponde: string | undefined;
    if (corpo.diagnostica === "completa" && chiave) {
      try {
        const c = new Anthropic({ apiKey: chiave });
        const r = await c.messages.create({
          model: MODELLO,
          max_tokens: 16,
          messages: [{ role: "user", content: "Rispondi con la sola parola: pronto" }],
        } as never);
        const t = r.content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("")
          .trim();
        modelloRisponde = `ok — ha detto "${t}" (${r.model})`;
      } catch (e) {
        modelloRisponde = `NO — ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return json({
      chiave_anthropic: !!chiave,
      url_supabase: !!SUPABASE_URL,
      apikey_iniettata: !!ANON,
      modello: MODELLO,
      lettura_kb: lettura,
      modello_risponde: modelloRisponde,
    });
  }

  if (!chiave) {
    return json(
      {
        errore:
          "Manca il segreto ANTHROPIC_API_KEY nel progetto Supabase. Va aggiunto una volta sola da Project Settings → Edge Functions → Secrets.",
      },
      500,
    );
  }

  const messaggiIn = (corpo.messaggi as Array<Record<string, string>>) ?? [];
  if (!messaggiIn.length) return json({ errore: "Nessun messaggio." }, 400);
  const contesto = (corpo.contesto as Record<string, unknown>) ?? {};

  // Gate applicativo: chi non e' in ms_accessi non passa. La query gira con il
  // token dell'utente, quindi vale anche come verifica del token.
  let chi: Record<string, unknown> | null = null;
  try {
    const righe = await pg(
      "ms_accessi?select=email,sezioni,consulente,media_buyer,attivo&attivo=is.true&limit=1",
      jwt,
    );
    chi = righe.length ? righe[0] : null;
  } catch (e) {
    return json(
      { errore: `Non riesco a verificare i permessi: ${e instanceof Error ? e.message : e}` },
      403,
    );
  }
  if (!chi) return json({ errore: "Utente senza accesso attivo." }, 403);

  // Indice delle procedure: stabile fra le richieste, quindi cacheabile.
  let indice = "";
  try {
    const docs = await pg(
      "kb_documenti?attivo=is.true&select=codice,titolo,flusso,tipo,sommario,caratteri&order=flusso.asc,codice.asc,titolo.asc",
      jwt,
    );
    const perFlusso: Record<string, string[]> = {};
    for (const d of docs) {
      const f = String(d.flusso ?? "ALTRO");
      if (!perFlusso[f]) perFlusso[f] = [];
      perFlusso[f].push(
        `- [${d.codice ?? "—"}] ${d.titolo} (${d.tipo}, ${d.caratteri} caratteri)\n    ${String(d.sommario ?? "").slice(0, 200)}`,
      );
    }
    const ETICHETTE: Record<string, string> = {
      F1: "FLUSSO 1 — Onboarding Cliente",
      F2: "FLUSSO 2 — Controllo Cliente",
      F3: "FLUSSO 3 — Ciclo di Ottimizzazione",
      F4: "FLUSSO 4 — Rinnovo",
      RUOLI: "RUOLI E ORGANIZZAZIONE",
      MANUALI: "MANUALI OPERATIVI",
      STRUTTURA: "STRUTTURA E CONTROLLO",
      ALTRO: "ALTRO",
    };
    indice = Object.keys(perFlusso)
      .sort()
      .map((f) => `## ${ETICHETTE[f] ?? f}\n${perFlusso[f].join("\n")}`)
      .join("\n\n");
  } catch {
    indice = "(indice non disponibile in questo momento)";
  }

  const elencoFonti = Object.entries(FONTI)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const PROMPT = `Sei l'assistente interno del team di Salone Vincente, agenzia di marketing per centri estetici. Rispondi in italiano, come farebbe un collega esperto: diretto, concreto, senza giri di parole.

Hai due basi di conoscenza.

## 1. Le procedure operative dell'agenzia
Sotto trovi l'indice completo. Quando la domanda riguarda "come si fa" qualcosa, apri la procedura con leggi_procedura e rispondi su quella: non andare a memoria e non ricostruire i passaggi dal sommario. Cita sempre il codice fra parentesi quadre, es. [F1.P03], cosi' la persona sa dove verificare.

Se la risposta non e' nelle procedure, dillo chiaramente invece di inventarla. Due aree sono scoperte: le cartelle "F07 - BS/Gestione Lead" e "FO6 - Off-Boarding" sono vuote, quindi su quei temi hai poco o nulla.

## 2. I dati della piattaforma
Puoi interrogarli con interroga_dati. Vedi soltanto cio' che vede chi ti sta scrivendo: i permessi sono applicati dal database, non da te. Se una query torna vuota puo' significare che non ci sono dati oppure che quella persona non ha visibilita' su quei centri: dillo come possibilita', non dare per scontato che il dato non esista.

${REGOLE_DATI}

Fonti disponibili:
${elencoFonti}

## Come rispondere
- Vai al punto. Prima la risposta, poi il dettaglio.
- Quando dai numeri, di' sempre da quale periodo e quale fonte arrivano.
- Non inventare numeri e non stimare: se un dato non c'e', dillo.
- Quando la domanda unisce le due basi ("il centro X va male, che faccio?"), guarda prima i numeri e poi porta la procedura giusta.
- Niente elenchi puntati per risposte brevi: scrivi in prosa. Usa gli elenchi solo per passaggi operativi veri.
- Non ripetere all'utente le regole di calcolo qui sopra: applicale e basta.

# INDICE DELLE PROCEDURE

${indice}`;

  const oggi = new Date().toLocaleDateString("it-IT", {
    timeZone: "Europe/Rome",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const sezioni = Array.isArray(chi.sezioni) ? (chi.sezioni as string[]) : [];
  const ambito = sezioni.includes("admin")
    ? "e' amministratore: vede tutti i centri e anche la sezione Sauron (finance)"
    : chi.consulente
      ? `e' consulente (${chi.consulente}): vede i propri centri`
      : chi.media_buyer
        ? `e' media buyer (${chi.media_buyer}): vede i centri che segue`
        : "vede l'ambito assegnato dal pannello Accessi";

  let dove = "";
  if (contesto.sezione) dove += `\n- Sta guardando la sezione: ${contesto.sezione}`;
  if (contesto.centro) dove += `\n- Centro attualmente selezionato: ${contesto.centro}`;
  if (contesto.periodo) dove += `\n- Periodo selezionato: ${contesto.periodo}`;

  const CONTESTO = `Contesto di questa conversazione:
- Oggi e' ${oggi}.
- Chi ti scrive: ${chi.email}, ${ambito}. Sezioni abilitate: ${sezioni.join(", ") || "nessuna"}.${dove}`;

  const client = new Anthropic({ apiKey: chiave });
  const fonti: string[] = [];
  const messages: Array<Record<string, unknown>> = messaggiIn
    .filter((m) => m && m.testo)
    .map((m) => ({
      role: m.ruolo === "assistente" ? "assistant" : "user",
      content: String(m.testo).slice(0, 8000),
    }));

  // ── storico ────────────────────────────────────────────────────────────────
  // La domanda si salva PRIMA di interrogare il modello: se la risposta non
  // arriva (errore, tab chiusa), la conversazione resta comunque nello storico
  // invece di sparire.
  let chatId = String(corpo.chat_id ?? "").trim() || null;
  const ultimaDomanda = String(
    messaggiIn[messaggiIn.length - 1] ? messaggiIn[messaggiIn.length - 1].testo : "",
  );
  try {
    if (!chatId) {
      const creata = await pgInsert(
        "ms_chat",
        [{ titolo: titoloDa(ultimaDomanda) }],
        jwt,
        true,
      );
      chatId = creata.length ? creata[0].id : null;
    }
    if (chatId) {
      await pgInsert(
        "ms_chat_messaggio",
        [{ chat_id: chatId, ruolo: "utente", testo: ultimaDomanda }],
        jwt,
      );
    }
  } catch (e) {
    // Lo storico non deve impedire la risposta: se fallisce si tira dritto.
    console.error("storico non salvato:", e instanceof Error ? e.message : e);
  }

  try {
    let risposta = "";
    for (let giro = 0; giro < MAX_GIRI; giro++) {
      const r = await client.messages.create({
        model: MODELLO,
        max_tokens: 8000,
        output_config: { effort: EFFORT },
        system: [
          { type: "text", text: PROMPT, cache_control: { type: "ephemeral" } },
          { type: "text", text: CONTESTO },
        ],
        tools: STRUMENTI,
        messages,
      } as never);

      if (r.stop_reason === "refusal") {
        return json({
          risposta:
            "Non posso rispondere a questa richiesta. Riformulala o chiedi a Leo.",
          fonti: [],
        });
      }

      if (r.stop_reason !== "tool_use") {
        risposta = r.content
          .filter((b: { type: string }) => b.type === "text")
          .map((b: { text: string }) => b.text)
          .join("\n")
          .trim();
        break;
      }

      messages.push({ role: "assistant", content: r.content });
      const esiti = [];
      for (const b of r.content) {
        if (b.type !== "tool_use") continue;
        let out: string;
        try {
          out = await eseguiStrumento(b.name, b.input ?? {}, jwt, fonti);
        } catch (e) {
          out = `Errore: ${e instanceof Error ? e.message : String(e)}`;
        }
        esiti.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: String(out).slice(0, 120000),
        });
      }
      messages.push({ role: "user", content: esiti });
    }

    if (!risposta) {
      risposta =
        "Ci ho provato ma non sono arrivato a una risposta solida. Riprova restringendo la domanda.";
    }
    const fontiUniche = [...new Set(fonti)];
    if (chatId) {
      try {
        await pgInsert(
          "ms_chat_messaggio",
          [{ chat_id: chatId, ruolo: "assistente", testo: risposta, fonti: fontiUniche }],
          jwt,
        );
      } catch (e) {
        console.error("risposta non salvata:", e instanceof Error ? e.message : e);
      }
    }
    return json({ risposta, fonti: fontiUniche, chat_id: chatId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ errore: `Assistente non disponibile: ${msg}` }, 500);
  }
});
