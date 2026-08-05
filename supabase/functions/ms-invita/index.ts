// manager-stats · invito di un membro del team  (v2: il WhatsApp lo manda n8n)
//
// Crea (o ritrova) l'utente su Supabase Auth, gli prepara il link di accesso, gli
// dà le sezioni iniziali e lo collega alla persona in anagrafica. Poi consegna il
// link — e comunque lo restituisce, così l'admin può sempre copiarlo e mandarlo a
// mano se un canale non consegna.
//
// Sicurezza: verify_jwt = true, e in più si controlla che CHI CHIAMA sia admin di
// manager-stats (rpc ms_puo('admin') col suo token). Il sito è pubblico, quindi
// nessun segreto condiviso può stare nel browser: l'unica credenziale che viaggia
// da lì è il JWT dell'utente.
//
// WhatsApp: il token Wassenger vive in una credenziale n8n e le credenziali n8n non
// sono leggibili via API — quindi non si sposta. Manda n8n, e questa funzione gli
// dice cosa scrivere e a chi. Il webhook n8n è protetto da un header segreto che
// sta nel database (leggibile solo da service_role, come academy_secret): così non
// serve nessun secret sulla funzione e il segreto non passa mai dal browser.
// NON si inoltra il JWT dell'admin a n8n: darebbe a un terzo sistema un token che
// per la sua durata residua può agire come lui.
import { createClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("MS_APP_URL") ?? "https://mach10account.github.io/manager-stats/";
const WA_WEBHOOK = Deno.env.get("MS_WA_WEBHOOK") ?? "https://n8n.srv1035791.hstgr.cloud/webhook/ms-invito-wa-7c1e94";

const admin = createClient(URL, SERVICE);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

// il numero come lo vuole Wassenger: solo cifre, prefisso 39 se manca
function numeroWa(tel: string): string {
  const n = String(tel).replace(/[^0-9]/g, "").replace(/^00/, "");
  return n.startsWith("39") ? n : "39" + n.replace(/^0+/, "");
}

let segretoWa: string | null = null;
async function segretoWebhook(): Promise<string> {
  if (segretoWa) return segretoWa;
  const { data, error } = await admin.rpc("ms_segreto", { p_nome: "wa_webhook" });
  if (error || !data) throw new Error("segreto del webhook non leggibile: " + (error?.message ?? "vuoto"));
  segretoWa = data as string;
  return segretoWa;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type, apikey",
        "access-control-allow-methods": "POST, OPTIONS",
      },
    });
  }
  try {
    if (req.method !== "POST") return json({ error: "solo POST" }, 405);

    // 1. chi chiama è admin di manager-stats? Si chiede al DB col SUO token,
    //    così la risposta è la stessa che vale per le policy RLS.
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth) return json({ error: "non autenticato" }, 401);
    const comeUtente = createClient(URL, ANON, { global: { headers: { Authorization: auth } } });
    const { data: puo, error: errPuo } = await comeUtente.rpc("ms_puo", { p_area: "admin" });
    if (errPuo) return json({ error: "controllo permessi fallito: " + errPuo.message }, 401);
    if (puo !== true) return json({ error: "serve essere amministratore" }, 403);

    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    const nome = body.nome ? String(body.nome).trim() : null;
    const personaId = body.persona_id ? String(body.persona_id) : null;
    const canale = body.canale === "whatsapp" ? "whatsapp" : (body.canale === "email" ? "email" : "link");
    const telefono = body.telefono ? String(body.telefono).trim() : "";
    const sezioni: string[] = Array.isArray(body.sezioni) ? body.sezioni : [];
    if (!email || !email.includes("@")) return json({ error: "email non valida" }, 400);
    if (canale === "whatsapp" && !telefono) return json({ error: "serve il numero di telefono" }, 400);

    // 2. utente: si crea se non c'è, altrimenti si riusa (l'invito diventa un
    //    "rientra da qui", che è quello che serve quando uno ha perso la password)
    let userId: string | null = null;
    let creato = false;
    const { data: fatto } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      password: crypto.randomUUID() + "aA1!",   // usa e getta: si entra dal link
      user_metadata: nome ? { full_name: nome } : {},
    });
    if (fatto?.user) {
      userId = fatto.user.id;
      creato = true;
    } else {
      const { data: lista } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const trovato = lista?.users?.find((u) => (u.email ?? "").toLowerCase() === email);
      if (!trovato) return json({ error: "non sono riuscito a creare l'utente" }, 400);
      userId = trovato.id;
    }

    // 3. il link di accesso. 'recovery' vale anche per un utente appena creato e
    //    lo porta a impostare la password.
    const { data: link, error: errLink } = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: APP_URL },
    });
    if (errLink) return json({ error: "link non generato: " + errLink.message }, 500);
    const url = link?.properties?.action_link ?? "";

    // 4. riga in ms_accessi (le sezioni si affinano poi dal pannello) e
    //    collegamento alla persona in anagrafica
    await admin.from("ms_accessi").upsert(
      { user_id: userId, email, sezioni, attivo: true, aggiornato_a: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (personaId) {
      await admin.from("ms_persona").update({ user_id: null }).eq("user_id", userId);
      await admin.from("ms_persona").update({ user_id: userId, agg_a: new Date().toISOString() })
        .eq("id", personaId);
    }

    // 5. consegna
    let inviato: string | null = null;
    let avviso: string | null = null;

    if (canale === "email") {
      // l'invito integrato di Supabase: se il progetto non ha un SMTP proprio parte
      // dal mittente di default, con limiti bassi e alto rischio spam → si dichiara
      const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: APP_URL });
      if (error) avviso = "email non partita (" + error.message + "): usa il link qui sotto";
      else inviato = "email";
    }

    if (canale === "whatsapp") {
      const testo = `Ciao${nome ? " " + nome : ""}! Ecco il tuo accesso a Manager Stats.\n\n` +
        `Apri questo link e imposta la password:\n${url}\n\nÈ personale, non girarlo.`;
      try {
        const r = await fetch(WA_WEBHOOK, {
          method: "POST",
          headers: { "content-type": "application/json", "x-ms-token": await segretoWebhook() },
          body: JSON.stringify({ telefono: "+" + numeroWa(telefono), testo }),
        });
        const risposta = await r.text();
        // n8n risponde 200 anche quando Wassenger rifiuta (il nodo continua
        // sull'errore per poterlo raccontare): la verità sta nel campo ok.
        let esito: { ok?: boolean; errore?: string } = {};
        try { esito = JSON.parse(risposta); } catch { /* risposta non JSON */ }
        if (!r.ok || esito.ok === false) {
          avviso = "WhatsApp non partito (" + (esito.errore || (r.status + " " + risposta.slice(0, 120))) +
            "): usa il link qui sotto";
        } else {
          inviato = "whatsapp";
        }
      } catch (e) {
        avviso = "WhatsApp non partito (" + String(e instanceof Error ? e.message : e) + "): usa il link qui sotto";
      }
    }

    return json({ ok: true, user_id: userId, creato, url, inviato, avviso });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
