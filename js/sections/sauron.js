// manager-stats · Sezione Sauron (ex Finance, solo admin) — porting del prototipo CFO Cockpit
//
// Fonti: fin_incassi (1 riga = 1 rata, da Notion 🏦 DATABASE INCASSI),
// v_notion_contratti (mirror del DATABASE CONTRATTI: 1 riga = 1 contratto vero),
// fin_costi (voci di costo, EDITABILI qui), fin_pnl (conto economico DICHIARATO
// dei mesi chiusi, dal foglio "PL Database Input"), centri (anagrafica clienti:
// churn, ciclo di vita, PM e beauty). Sync WF-M7/WF-M1; RLS solo admin.
//
// Tab: Dashboard · Costi · P&L · Delivery · Clienti & LTV · Report.
// La barra filtri globale è nascosta (app.js); qui c'è il selettore mese.
//
// Definizioni (dal Cockpit, adattate ai dati Notion):
// · Incassato del mese  = somma IMPORTO RATA con DATA INCASSO nel mese
// · 1ª rata pagata     = rate con RATA NUMERO 1 e DATA INCASSO nel mese, che non
//                         siano RINNOVO/UPSELL: i clienti che partono davvero
// · Rinnovi / Upsell    = tag esatto 'RINNOVO' / 'UPSELL' (match sull'elemento:
//                         "CONTRATTO TERMINATO CON RINNOVO" NON è un rinnovo)
// · Contrattualizzato   = somma VALORE CONTRATTO dei contratti creati nel mese
// · Insolute (>7gg)     = rate scadute da oltre 7 giorni e mai incassate
// · Scadenza mancante    = vale la DATA INCASSO (rate pagate alla firma: su Notion
//                         la scadenza resta vuota, vedi normalizzazione in buildData)
// · Commissioni (auto)  = formule commissione Notion sugli incassi del mese
//                         (venditore 10% · setter 5% · PM/MB/BS sui rinnovi)
// · Ricorrenza costi    = mensile (da `data` in poi, fino a `fine`), annua
//                         (stesso mese dell'anno), una tantum (solo quel mese)
// · EBITDA              = ricavi netti − costi correnti − commissioni, ESCLUSI
//                         investimenti e asset · Cash flow = EBITDA − capex
import { supabase } from '../supabase.js';
import { fetchAll, nomeDi, personaDi, chiavePersona, personaAttiva, personaHaRuolo } from '../data.js';
import { renderTable, renderKpiGroups, renderKpiRow } from '../tables.js';
import { renderLineChart } from '../charts.js';
import { fmt, fmt1, eur, eur2, pct, fmtPct, pctFrac, ratio, safeDiv, fmtCompact, dstr, todayRome, esc } from '../format.js';

let DATA = null;          // { incassi, contratti, centri, costi }
let _mount = null;
let _renderId = 0;

const MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
              'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const ymLabel = m => { const [y, mm] = m.split('-'); return MESI[+mm - 1] + ' ' + y; };
const ymShort = m => m.slice(5, 7) + '/' + m.slice(2, 4);
const addYm = (m, n) => {
  const d = new Date(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
};
const fineMese = m => dstr(new Date(+m.slice(0, 4), +m.slice(5, 7), 0));
const dtIt = v => v ? v.split('-').reverse().join('/') : '—';
// giorno in cui l'insoluto del mese m è completo: 7 giorni dopo l'ultima scadenza
// (prima di allora la coda del mese è ancora dentro la tolleranza bonifici)
const meseCompletoIl = m => {
  const f = fineMese(m);
  return dstr(new Date(+f.slice(0, 4), +f.slice(5, 7) - 1, +f.slice(8, 10) + 7));
};
// mesi pieni fra due date ISO (per durata cliente e LTV)
const mesiTra = (a, b) => {
  if (!a || !b) return null;
  const d = (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
  return d + (+b.slice(8, 10) >= +a.slice(8, 10) ? 0 : -1);
};

let MESE = dstr(todayRome()).slice(0, 7);   // default: mese corrente (Europe/Rome)
let AGENZIA = '';                            // '' = tutte
let TAB = 'dash';
const TABS = [
  ['dash', 'Dashboard'], ['costi', 'Costi'], ['pnl', 'P&L'], ['marketing', 'Marketing'],
  ['delivery', 'Delivery'], ['clienti', 'Clienti & LTV'], ['report', 'Report'],
];
let mktSort = { key: 'mese', dir: -1 };
// Delivery: di default fuori dall'elenco chi non ha nessun cliente gestito e
// nessuna capienza impostata — quasi sempre assegnazioni rimaste su clienti persi.
// Il bottone qui sopra le tabelle li rimette, senza dover togliere nessuno dal team.
let mostraSenzaCarico = false;
let ruoloSort = { PM: { key: 'gestiti', dir: -1 }, BEAUTY: { key: 'gestiti', dir: -1 }, MEDIA_BUYER: { key: 'gestiti', dir: -1 } };
const costiSort = {};                        // per reparto

// ── caricamento ──────────────────────────────────────────────────────────────
async function buildData() {
  const [incassi, contratti, centri, costi, capacita, mktMese, pnlFoglio] = await Promise.all([
    fetchAll((lo, hi) => supabase.from('fin_incassi')
      .select('id_incasso,id_contratto,centro,consulente,agenzia,tipo_contratto,venditore,data_incasso,data_scadenza,importo,rata_numero,pagato,metodo,comm_venditore,comm_setter,comm_pm,comm_mb,comm_bs')
      .range(lo, hi)),
    // mirror del DATABASE CONTRATTI di Notion: 1 riga = 1 contratto vero.
    // (fin_contratti nasceva da VALORE CONTRATTI e contava anche righe senza contratto)
    fetchAll((lo, hi) => supabase.from('v_notion_contratti')
      .select('nome_centro,id_contratto,valore,stato,durata,agenzia,venditore,creazione_contratto')
      .range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('centri')
      .select('nome,agenzia,stato_attivita,consulente,beauty,media_buyer,data_cliente_perso,inizio_servizio,fine_servizio,data_rinnovo')
      .range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('fin_costi').select('*').range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('fin_capacita').select('*').range(lo, hi)),
    // tab Marketing: i dati del mese, scritti a mano da lì (1 riga = 1 mese)
    supabase.from('fin_mkt_mese').select('*').then(r => r.data || []).catch(() => []),
    // conto economico DICHIARATO dei mesi chiusi (foglio "PL Database Input")
    fetchAll((lo, hi) => supabase.from('fin_pnl').select('*').range(lo, hi)),
  ]);
  // dal mirror il venditore arriva come array e il valore come numeric (stringa via
  // PostgREST): qui li riporto alle forme che il resto della sezione si aspetta.
  const contrattiNorm = contratti.map(c => ({
    ...c,
    valore: (c.valore === null || c.valore === undefined) ? null : Number(c.valore),
    venditore: Array.isArray(c.venditore) ? c.venditore.join(', ') : c.venditore,
  }));
  // Su Notion la DATA SCADENZA resta vuota quando la rata si paga alla firma
  // (prima rata / acconto: la riga nasce già incassata e nessuno compila la
  // scadenza). Senza data quelle righe sparivano da ogni conto di scaduto —
  // stavano nell'incassato ma non nel denominatore dell'insoluto. Regola di Leo:
  // se la scadenza manca vale la data di incasso. Le righe senza NESSUNA delle
  // due (mai incassate e senza scadenza) restano fuori: non c'è niente da dedurre.
  const incassiNorm = incassi.map(r => (r.data_scadenza || !r.data_incasso)
    ? r
    : { ...r, data_scadenza: r.data_incasso, scadenza_da_incasso: true });
  return { incassi: incassiNorm, contratti: contrattiNorm, centri, costi, capacita, mktMese, pnlFoglio };
}

async function ricaricaCosti() {
  DATA.costi = await fetchAll((lo, hi) => supabase.from('fin_costi').select('*').range(lo, hi));
}

// ── filtri e definizioni ─────────────────────────────────────────────────────
const hasTag = (arr, tag) => Array.isArray(arr) && arr.indexOf(tag) !== -1;
const inAg = r => !AGENZIA || hasTag(r.agenzia, AGENZIA);
const incassi = () => DATA.incassi.filter(inAg);
const contratti = () => DATA.contratti.filter(inAg);
const centriRows = () => (DATA.centri || []).filter(inAg);
const costi = () => DATA.costi || [];        // i costi sono aziendali, niente filtro agenzia
const PERSO_TAG = 'CLIENTE PERSO/SPARITO';
const isGestito = c => !hasTag(c.stato_attivita, PERSO_TAG);   // come il Cockpit: tutto tranne i persi
const incassata = r => r.pagato || !!r.data_incasso;   // su Notion coincidono quasi sempre
const ymOf = d => d ? d.slice(0, 7) : null;
// i nomi centro arrivano da due fonti diverse (incassi/contratti vs anagrafica):
// il join è per nome normalizzato, l'unica chiave in comune.
const chiave = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function agenzie() {
  const s = new Set();
  for (const r of DATA.incassi) for (const a of (r.agenzia || [])) s.add(a);
  for (const r of DATA.contratti) for (const a of (r.agenzia || [])) s.add(a);
  return [...s].sort();
}

function centriByNome() {
  const m = new Map();
  for (const c of centriRows()) if (c.nome) m.set(chiave(c.nome), c);
  return m;
}

// incassato del mese, spezzato in prime rate / rate successive / rinnovi / upsell.
// "prima rata" = RATA NUMERO 1 incassata nel mese (su Notion e' la riga con
// NUMERO RATA INCASSATA = 1): e' il cliente che parte davvero, a prescindere da
// quando ha firmato. Rinnovi e upsell restano fuori: non sono clienti nuovi.
// maxDay ('03'…'31'): considera solo i giorni 1..maxDay — serve per confrontare
// un mese in corso con la STESSA porzione del mese precedente.
function splitIncassato(m, maxDay) {
  const t = { tot: 0, n: 0, nuovi: 0, rate: 0, rinnovi: 0, upsell: 0, nuoviIds: new Set() };
  for (const r of incassi()) {
    if (ymOf(r.data_incasso) !== m) continue;
    if (maxDay && r.data_incasso.slice(8, 10) > maxDay) continue;
    const imp = +r.importo || 0;
    t.tot += imp; t.n += 1;
    if (hasTag(r.tipo_contratto, 'RINNOVO')) t.rinnovi += imp;
    else if (hasTag(r.tipo_contratto, 'UPSELL')) t.upsell += imp;
    else if (+r.rata_numero === 1) {
      t.nuovi += imp;
      t.nuoviIds.add(r.id_contratto || r.centro || r.id_incasso);
    }
    else t.rate += imp;
  }
  return t;
}

function contrattualizzato(m, maxDay) {
  const t = { tot: 0, n: 0, rinnovi: 0, rinnoviVal: 0, upsell: 0, upsellVal: 0, nuovi: 0, nuoviVal: 0 };
  for (const c of contratti()) {
    if (ymOf(c.creazione_contratto) !== m) continue;
    if (maxDay && c.creazione_contratto.slice(8, 10) > maxDay) continue;
    const v = +c.valore || 0;
    t.tot += v; t.n += 1;
    if (hasTag(c.stato, 'RINNOVO')) { t.rinnovi += 1; t.rinnoviVal += v; }
    else if (hasTag(c.stato, 'UPSELL')) { t.upsell += 1; t.upsellVal += v; }
    else { t.nuovi += 1; t.nuoviVal += v; }
  }
  return t;
}

function scadenze(m) {
  const t = { previsto: 0, incassato: 0, daIncassare: 0, nRate: 0 };
  for (const r of incassi()) {
    if (ymOf(r.data_scadenza) !== m) continue;
    const imp = +r.importo || 0;
    t.previsto += imp;
    if (incassata(r)) t.incassato += imp;
    else { t.daIncassare += imp; t.nRate += 1; }
  }
  return t;
}

// rate scadute da oltre 7 giorni e mai incassate.
// soloMese = true  → solo le scadenze DEL mese m: com'è andato quel mese.
// soloMese = false → tutto lo storico fino a fine mese m: l'esposizione accumulata.
// Il taglio è il minore fra oggi-7 e la fine del mese: i 7 giorni sono la
// tolleranza per i bonifici in viaggio, e valgono solo sul mese in corso.
function insolute(m, soloMese) {
  const oggi = todayRome();
  oggi.setDate(oggi.getDate() - 7);
  const cut = dstr(oggi) < fineMese(m) ? dstr(oggi) : fineMese(m);
  // cut e parziale servono a raccontarlo nella ⓘ: finché il mese non è tutto
  // "scaduto da 7 giorni" il totale è per forza più basso di Previsto nel mese.
  const t = { cut, parziale: cut < fineMese(m), scadute: 0, nonIncassate: 0, nScadute: 0, nNonIncassate: 0, righe: [] };
  for (const r of incassi()) {
    if (!r.data_scadenza || r.data_scadenza > cut) continue;
    if (soloMese && ymOf(r.data_scadenza) !== m) continue;
    const imp = +r.importo || 0;
    t.scadute += imp; t.nScadute += 1;
    if (!incassata(r)) { t.nonIncassate += imp; t.nNonIncassate += 1; t.righe.push(r); }
  }
  return t;
}

// ── costi: ricorrenza, commissioni, conto economico ──────────────────────────
const REPARTI = ['Fissi', 'Commerciale', 'Marketing', 'Delivery', 'Extra'];
const REPARTO_LABEL = { Fissi: 'Costi Fissi', Commerciale: 'Reparto Commerciale', Marketing: 'Marketing', Delivery: 'Delivery', Extra: 'Costi Straordinari' };
const CAT_COSTI = ['Diretti', 'Operativi', 'Strutturali', 'Asset', 'Investimenti'];
const CATEGORIE_EXTRA = ['Software', 'Consulenze', 'Viaggi', 'Formazione', 'Marketing', 'Attrezzature', 'Rimborsi', 'Altro'];
const RUOLI_DELIVERY = ['Project Manager', 'Beauty Specialist', 'Media Buyer', 'Manager / Direzione', 'Social Media Manager', 'Altri ruoli'];
const FREQ_LABEL = { mensile: 'Mensile', annua: 'Annua', 'una-tantum': 'Una tantum' };

// la voce conta nel mese m? (stessa logica del Cockpit)
function costOccurs(c, m) {
  if (!c.attivo) return false;
  if (c.fine && m > c.fine.slice(0, 7)) return false;
  const start = (c.data || '').slice(0, 7);
  if (!start) return false;
  if (c.frequenza === 'mensile') return start <= m;
  if (c.frequenza === 'annua') return start <= m && start.slice(5) === m.slice(5);
  return start === m;   // una tantum
}

// commissioni reali del mese (formule Notion sugli incassi con DATA INCASSO nel mese)
function commissioniMese(m) {
  const t = { vend: 0, sett: 0, mgr: 0, tot: 0 };
  for (const r of incassi()) {
    if (ymOf(r.data_incasso) !== m) continue;
    t.vend += +r.comm_venditore || 0;
    t.sett += +r.comm_setter || 0;
    t.mgr += (+r.comm_pm || 0) + (+r.comm_mb || 0) + (+r.comm_bs || 0);
  }
  t.tot = t.vend + t.sett + t.mgr;
  return t;
}

const sumImporti = list => list.reduce((a, c) => a + (+c.importo || 0), 0);

// totale costi del mese: voci ricorrenti/una-tantum + commissioni auto.
// capex = voci con categoria P&L Asset/Investimenti: contano nel totale costi
// (e nel cash flow) ma NON nell'EBITDA.
function costiMese(m) {
  const occ = costi().filter(c => costOccurs(c, m));
  const rimborsi = sumImporti(occ.filter(c => (c.sottocategoria || '') === 'Rimborsi'));
  const voci = occ.filter(c => (c.sottocategoria || '') !== 'Rimborsi');
  const manuali = sumImporti(voci);
  const cat = {};
  for (const k of CAT_COSTI) cat[k] = sumImporti(voci.filter(c => c.categoria === k));
  const capex = cat.Asset + cat.Investimenti;
  const comm = commissioniMese(m);
  return { occ, voci, manuali, cat, capex, rimborsi, comm, tot: manuali + rimborsi + comm.tot };
}

// ── conto economico DICHIARATO (foglio "PL Database Input") ──────────────────
// Il registro costi fotografa lo stato di OGGI: tutte voci mensili che partono
// dal 2026-01-01, senza storico. Applicato a un mese chiuso produce numeri che
// non sono mai esistiti (manca l'ad spend, la parte fissa dei setter, i compensi
// amministratori, i costi straordinari). Il conto economico vero dei mesi chiusi
// sta sul foglio, e per quei mesi e' quello che vale — stessa scelta gia' fatta
// per il Marketing: mese chiuso = foglio, mese in corso = calcolato dal vivo.
// Riga assente = casella vuota sul foglio; importo 0 = il foglio dice "-".
const SEZ_PNL = ['ricavi', 'rimborsi', 'diretti', 'operativi', 'strutturali'];
const vociFoglio = m => (DATA.pnlFoglio || [])
  .filter(r => r.mese === m).sort((a, b) => a.ordine - b.ordine);
const sommaSez = (righe, sez) => righe
  .filter(r => r.sezione === sez && r.tipo === 'voce')
  .reduce((a, r) => a + (+r.importo || 0), 0);

function foglioPnl(m) {
  const righe = vociFoglio(m);
  if (!righe.length) return null;
  const t = {};
  for (const s of SEZ_PNL) t[s] = sommaSez(righe, s);
  const ricaviNetti = t.ricavi - t.rimborsi;
  const margineLordo = ricaviNetti - t.diretti;
  const margineOp = margineLordo - t.operativi;
  return { righe, sez: t, lordi: t.ricavi, rimborsi: t.rimborsi, costiDiretti: t.diretti,
    operativi: t.operativi, strutturali: t.strutturali, ricaviNetti, margineLordo, margineOp,
    ebitda: margineOp - t.strutturali, capex: 0, cashFlow: margineOp - t.strutturali,
    // sul foglio non c'e' una riga capex: cash flow ed EBITDA coincidono
    costiTot: t.diretti + t.operativi + t.strutturali + t.rimborsi };
}

// conto economico per cassa del mese.
// forza = 'calcolato' → ignora il foglio anche dove c'e' (chip nel tab P&L).
function pnl(m, forza) {
  const s = splitIncassato(m);
  const cm = costiMese(m);
  const ricaviNetti = s.tot - cm.rimborsi;
  const costiDiretti = cm.comm.tot + cm.cat.Diretti;
  const margineLordo = ricaviNetti - costiDiretti;
  const margineOp = margineLordo - cm.cat.Operativi;
  const ebitda = margineOp - cm.cat.Strutturali;
  const calcolato = {
    lordi: s.tot, rimborsi: cm.rimborsi, ricaviNetti, costiDiretti, margineLordo,
    operativi: cm.cat.Operativi, margineOp, strutturali: cm.cat.Strutturali,
    ebitda, capex: cm.capex, cashFlow: ebitda - cm.capex, costiTot: cm.tot,
  };
  const fg = foglioPnl(m);
  const daFoglio = !!fg && forza !== 'calcolato';
  const b = daFoglio ? fg : calcolato;
  const rn = b.ricaviNetti;
  return {
    m, s, cm, fg, calcolato, fonte: daFoglio ? 'foglio' : 'calcolato',
    lordi: b.lordi, rimborsi: b.rimborsi, ricaviNetti: rn, costiDiretti: b.costiDiretti,
    margineLordo: b.margineLordo, operativi: b.operativi, margineOp: b.margineOp,
    strutturali: b.strutturali, ebitda: b.ebitda, capex: b.capex, cashFlow: b.cashFlow,
    costiTot: b.costiTot, contrattualizzato: contrattualizzato(m).tot,
    pctLordo: rn > 0 ? b.margineLordo / rn : null,
    pctOp: rn > 0 ? b.margineOp / rn : null,
    pctEbitda: rn > 0 ? b.ebitda / rn : null,
  };
}

// "Dove vanno i soldi": una riga per RUOLO, non per persona. Con una riga a testa
// i 5 project manager e i 3 media buyer si prendevano 8 delle 12 posizioni con
// importi piccoli, e il costo vero del reparto non si vedeva. Il dettaglio per
// persona resta nella tab Costi.
function costiRaggruppati(cm) {
  const gruppi = new Map();
  const somma = (chiave, etichetta, importo) => {
    let g = gruppi.get(chiave);
    if (!g) { g = { etichetta, importo: 0, n: 0 }; gruppi.set(chiave, g); }
    g.importo += importo;
    g.n += 1;
  };
  if (cm.comm.tot > 0.5) somma('comm', 'Commissioni vendita (auto)', cm.comm.tot);
  for (const c of cm.occ) {
    const imp = +c.importo || 0;
    if (imp <= 0.5) continue;
    const sotto = String(c.sottocategoria || '');
    if (c.reparto === 'Delivery') {
      const ruolo = c.ruolo || 'Altri ruoli';
      somma('ruolo:' + ruolo, ruolo, imp);
    } else if (sotto.toLowerCase().indexOf('personale') === 0) {
      // il personale fuori dal Delivery sta nella sottocategoria: "Personale: Admin / HR"
      somma('pers:' + sotto, sotto.replace(/^Personale:\s*/i, '') || 'Personale', imp);
    } else {
      somma('voce:' + (c.id || c.descrizione), c.descrizione + (sotto ? ' · ' + sotto : ''), imp);
    }
  }
  return [...gruppi.values()].sort((a, b) => b.importo - a.importo);
}

// ── KPI dashboard ────────────────────────────────────────────────────────────
function renderKPI() {
  // mese in corso = confronto ad armi pari: il mese prima viene tagliato allo
  // stesso giorno (1–3 ago vs 1–3 lug). Mesi chiusi = mese pieno vs mese pieno.
  const oggi = dstr(todayRome());
  const maxDay = MESE === oggi.slice(0, 7) ? oggi.slice(8, 10) : null;
  const s = splitIncassato(MESE);
  const sPrev = splitIncassato(addYm(MESE, -1), maxDay);
  const c = contrattualizzato(MESE);
  const cPrev = contrattualizzato(addYm(MESE, -1), maxDay);
  const sc = scadenze(MESE);
  const ins = insolute(MESE, true);            // solo le scadenze del mese
  const insTot = insolute(MESE);               // esposizione accumulata, per il sottotitolo
  const insPct = pct(ins.nonIncassate, ins.scadute);
  const rif = maxDay ? 'sui giorni 1–' + (+maxDay) + ' del mese prima' : 'sul mese prima';
  const delta = (cur, prev) => prev > 0
    ? (cur >= prev ? '+' : '') + fmt(100 * (cur - prev) / prev) + '% ' + rif + ' (' + eur(prev) + ')'
    : null;

  // commerciale: churn da DATA CLIENTE PERSO · azienda: riempimento sulle capienze
  // impostate persona per persona nella tab Delivery (fin_capacita)
  const persiMese = centriRows().filter(x => x.data_cliente_perso && ymOf(x.data_cliente_perso) === MESE).length;
  const gestiti = centriRows().filter(isGestito);
  const riempR = {};
  RUOLI_CAP.forEach(R => { riempR[R.key] = riempimentoRuolo(R.key); });
  // riempimento complessivo: posti occupati su posti totali dei tre reparti
  const riempTot = RUOLI_CAP.reduce((a, R) => {
    const x = riempR[R.key];
    return { assegnati: a.assegnati + x.assegnati, posti: a.posti + x.posti, persone: a.persone + x.persone };
  }, { assegnati: 0, posti: 0, persone: 0 });
  riempTot.quota = riempTot.posti > 0 ? riempTot.assegnati / riempTot.posti : null;
  const conPosti = RUOLI_CAP.filter(R => riempR[R.key].quota !== null);
  riempTot.media = conPosti.length
    ? conPosti.reduce((a, R) => a + riempR[R.key].quota, 0) / conPosti.length : null;

  const tileRiemp = R => {
    const x = riempR[R.key];
    return { label: 'Riempimento ' + R.plur, value: x.quota === null ? '—' : pctFrac(x.quota),
      tone: x.quota === null ? undefined : (x.quota >= 0.95 ? 'bad' : (x.quota >= 0.75 ? undefined : 'good')),
      info: x.posti === 0
        ? 'nessuna capienza impostata: falla nella tab Delivery'
        : fmt(x.assegnati) + ' ' + x.baseTxt + ' ÷ ' + fmt(x.posti) + ' posti (' + x.persone + ' persone)'
          + (x.senza > 0 ? ' · ' + fmt(x.senza) + ' senza ' + R.plur : '') };
  };

  const p = pnl(MESE);
  const cm = p.cm;
  const roi = p.costiTot > 0 ? p.cashFlow / p.costiTot : null;
  // da dove arriva il conto economico di questo mese: il foglio se c'è, altrimenti
  // il calcolo su incassi Notion + registro costi. Lo dice ogni tile, così non
  // sembra che dashboard e tab P&L si contraddicano.
  const fonteTxt = p.fonte === 'foglio'
    ? 'dal foglio P&L del mese' : 'da incassi Notion + registro costi';

  renderKpiGroups(_mount.querySelector('#fnKpi'), [
    { step: 1, title: 'Incassato', tiles: [
      { label: 'Incassato del mese', value: eur(s.tot), hero: true, info: delta(s.tot, sPrev.tot) || (fmt(s.n) + ' rate incassate') },
      { label: 'Nuovi clienti — 1ª rata pagata', value: eur(s.nuovi),
        info: fmt(s.nuoviIds.size) + (s.nuoviIds.size === 1 ? ' cliente partito' : ' clienti partiti') + ' nel mese · esclusi rinnovi e upsell' },
      { label: 'Rate', value: eur(s.rate), info: 'rate successive di clienti attivi' },
      { label: 'Rinnovi', value: eur(s.rinnovi), info: 'tag RINNOVO sul contratto' },
      { label: 'Upsell', value: eur(s.upsell) },
    ] },
    { step: 2, title: 'Contrattualizzato', tiles: [
      { label: 'Contrattualizzato del mese', value: eur(c.tot), hero: true, info: delta(c.tot, cPrev.tot) || 'valore dei contratti creati nel mese' },
      { label: 'Contratti firmati', value: fmt(c.n), info: c.nuovi + ' nuovi · ' + c.rinnovi + ' rinnovi · ' + c.upsell + ' upsell' },
      { label: 'Ticket medio', value: eur(safeDiv(c.tot, c.n)) },
      { label: 'Valore rinnovi', value: eur(c.rinnoviVal) },
    ] },
    { step: 3, title: 'Da incassare', tiles: [
      { label: 'Rate da incassare nel mese', value: eur(sc.daIncassare), hero: true,
        info: fmt(sc.nRate) + ' rate in scadenza a ' + ymLabel(MESE) + ' non ancora incassate' },
      { label: 'Previsto nel mese', value: eur(sc.previsto), info: 'tutte le rate in scadenza nel mese' },
      { label: 'Già incassato sulle scadenze', value: eur(sc.incassato),
        info: fmtPct(pct(sc.incassato, sc.previsto)) + ' del previsto. Sono le rate che SCADEVANO a '
          + ymLabel(MESE) + ' e risultano pagate, in qualunque momento siano entrate — anche in anticipo o '
          + 'in ritardo. È un altro conto rispetto a "Incassato del mese", che è la cassa arrivata a '
          + ymLabel(MESE) + ' da qualsiasi scadenza, arretrato compreso: i due numeri non coincidono mai.' },
      { label: 'Insolute del mese (>7gg)', value: fmtPct(insPct), tone: ins.nonIncassate > 0 ? 'bad' : 'good',
        info: ins.nScadute === 0
          ? 'nessuna rata di ' + ymLabel(MESE) + ' è ancora scaduta da oltre 7 giorni'
          : eur(ins.nonIncassate) + ' mai incassati su ' + eur(ins.scadute)
            + (ins.parziale
              ? ' di scadenze dall\'1 al ' + dtIt(ins.cut) + '. Contano solo le rate scadute da più di 7 giorni: '
                + 'le ultime di ' + ymLabel(MESE) + ' entrano nel conto il ' + dtIt(meseCompletoIl(MESE))
                + ', per questo il totale è più basso di "Previsto nel mese".'
              : ' di scadenze di ' + ymLabel(MESE) + '.')
            + ' Arretrato: ' + eur(insTot.nonIncassate) + ', tutte le rate scadute fino al ' + dtIt(ins.cut)
            + ' e mai incassate.' },
    ] },
    { step: 4, title: 'Commerciale', tiles: [
      { label: 'Nuovi clienti', value: fmt(c.nuovi), hero: true, info: 'contratti nuovi creati nel mese' },
      { label: 'Clienti rinnovati', value: fmt(c.rinnovi), info: 'contratti di rinnovo creati nel mese' },
      { label: 'Upsell effettuati', value: fmt(c.upsell) },
      { label: 'Clienti persi', value: fmt(persiMese), tone: persiMese > 0 ? 'bad' : 'good',
        info: 'segnati persi su Notion nel mese (churn)' },
      { label: 'Ticket medio nuovi', value: eur(safeDiv(c.nuoviVal, c.nuovi)), info: 'valore medio dei contratti nuovi' },
      { label: 'Incassato medio alla 1ª rata', value: eur(safeDiv(s.nuovi, s.nuoviIds.size)),
        info: s.nuoviIds.size + ' nuovi clienti hanno pagato la 1ª rata nel mese' },
    ] },
    { step: 5, title: 'Azienda', wide: true, tiles: [
      { label: 'Riempimento team', value: riempTot.quota === null ? '—' : pctFrac(riempTot.quota), hero: true,
        tone: riempTot.quota === null ? undefined
          : (riempTot.quota >= 0.95 ? 'bad' : (riempTot.quota >= 0.75 ? undefined : 'good')),
        info: riempTot.posti === 0
          ? 'nessuna capienza impostata: falle nella tab Delivery'
          : fmt(riempTot.assegnati) + ' posti occupati su ' + fmt(riempTot.posti)
            + ' (' + riempTot.persone + ' persone nei tre reparti) · media dei reparti '
            + pctFrac(riempTot.media) },
      tileRiemp(RUOLI_CAP[0]),
      tileRiemp(RUOLI_CAP[1]),
      tileRiemp(RUOLI_CAP[2]),
      { label: 'Aziende gestite', value: fmt(gestiti.length), info: 'tutti gli stati tranne CLIENTE PERSO/SPARITO' },
      { label: 'Costi del mese', value: eur(p.costiTot),
        info: p.fonte === 'foglio'
          ? 'diretti ' + eur(p.costiDiretti) + ' + operativi ' + eur(p.operativi)
            + ' + strutturali ' + eur(p.strutturali) + ' · ' + fonteTxt
          : 'voci ' + eur(cm.manuali) + ' + commissioni ' + eur(cm.comm.tot) + (cm.rimborsi > 0 ? ' + rimborsi ' + eur(cm.rimborsi) : '') },
      { label: 'EBITDA', value: eur(p.ebitda), tone: p.ebitda >= 0 ? 'good' : 'bad',
        info: (p.pctEbitda !== null ? pctFrac(p.pctEbitda) + " dell'incassato netto · " : '')
          + (p.fonte === 'foglio' ? fonteTxt
            : 'esclusi investimenti e asset' + (cm.capex > 0 ? ' (' + eur(cm.capex) + ')' : '')) },
      { label: 'Margine netto', value: eur(p.cashFlow), tone: p.cashFlow >= 0 ? 'good' : 'bad',
        info: p.fonte === 'foglio'
          ? 'sul foglio non c\'è una riga investimenti: coincide con l\'EBITDA'
          : 'incassato − tutti i costi del mese, capex e rimborsi inclusi' },
      { label: 'ROI', value: roi === null ? '—' : pctFrac(roi), tone: roi === null ? undefined : (roi >= 0 ? 'good' : 'bad'),
        info: 'margine netto ÷ costi del mese' },
    ] },
  ], { righe: true });
}

// ── trend mensile ────────────────────────────────────────────────────────────
function trendRows() {
  const months = [];
  for (let i = 11; i >= 0; i--) months.push(addYm(MESE, -i));
  const inc = new Map(months.map(m => [m, 0]));
  const con = new Map(months.map(m => [m, 0]));
  const nCon = new Map(months.map(m => [m, 0]));
  for (const r of incassi()) {
    const m = ymOf(r.data_incasso);
    if (m !== null && inc.has(m)) inc.set(m, inc.get(m) + (+r.importo || 0));
  }
  for (const c of contratti()) {
    const m = ymOf(c.creazione_contratto);
    if (m !== null && con.has(m)) { con.set(m, con.get(m) + (+c.valore || 0)); nCon.set(m, nCon.get(m) + 1); }
  }
  return { months, rows: months.map(m => {
    const p = pnl(m);                      // EBITDA del mese: stesso calcolo del P&L
    return { incassato: inc.get(m), contrattualizzato: con.get(m), n: nCon.get(m),
             ebitda: p.ebitda, costi: p.costiTot, rimborsi: p.rimborsi, fonte: p.fonte };
  }) };
}

function renderTrend() {
  const el = _mount.querySelector('#fnTrend');
  if (!el) return;
  const { months, rows } = trendRows();
  renderLineChart(el, months, rows, [
    { key: 'incassato', color: '--series-1', name: 'Incassato' },
    { key: 'contrattualizzato', color: '--series-2', name: 'Contrattualizzato' },
    { key: 'ebitda', color: '--series-3', name: 'EBITDA' },
  ], {
    xlab: ymShort, yfmt: eur, axisFmt: fmtCompact, height: 280,
    tip: (r, m) => `<div class="t-date">${ymLabel(m)}</div>
      <div class="t-row"><span>Incassato</span><b>${eur(r.incassato)}</b></div>
      <div class="t-row"><span>Contrattualizzato</span><b>${eur(r.contrattualizzato)}</b></div>
      <div class="t-row"><span>EBITDA</span><b>${eur(r.ebitda)}</b></div>
      <div class="t-row"><span>Costi del mese</span><b>${eur(r.costi)}</b></div>
      <div class="t-row"><span>Contratti firmati</span><b>${fmt(r.n)}</b></div>
      <div class="t-row"><span>P&L</span><b>${r.fonte === 'foglio' ? 'dal foglio' : 'calcolato'}</b></div>`,
  });
}

// giorni di ritardo di una rata scaduta: serve all'export CSV della lista di recupero
const giorniRitardo = iso => Math.floor((todayRome() - new Date(iso + 'T00:00:00')) / 86400000);

// ── tab Dashboard ────────────────────────────────────────────────────────────
const DASH_HTML = `
  <div class="kpi-groups kpi-auto" id="fnKpi"></div>

  <div class="card">
    <h2>Andamento mensile</h2>
    <div class="subtitle">Ultimi 12 mesi fino a <span id="fnMeseLabel"></span>: incassato (per data incasso),
      contrattualizzato (per data di creazione del contratto) ed EBITDA (incassato netto − costi correnti −
      commissioni, esclusi investimenti e asset). Se l'EBITDA va sotto zero la scala scende con lui e compare
      la linea tratteggiata dello zero.</div>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--series-1)"></span>Incassato</span>
      <span class="key"><span class="swatch" style="background:var(--series-2)"></span>Contrattualizzato</span>
      <span class="key"><span class="swatch" style="background:var(--series-3)"></span>EBITDA</span>
    </div>
    <div class="chart-wrap"><svg id="fnTrend" width="100%" height="280"></svg></div>
  </div>`;

function renderDash() {
  _mount.querySelector('#fnContent').innerHTML = DASH_HTML;
  const lab = _mount.querySelector('#fnMeseLabel');
  if (lab) lab.textContent = ymLabel(MESE);
  renderKPI();
  renderTrend();
}

// ── tab Costi ────────────────────────────────────────────────────────────────
const costoCols = rep => {
  const cols = [{ key: 'descrizione', label: 'Voce' }];
  if (rep === 'Delivery') cols.push({ key: 'ruolo', label: 'Ruolo', fmt: v => esc(v || 'Altri ruoli') });
  else cols.push({ key: 'sottocategoria', label: rep === 'Extra' ? 'Categoria' : 'Sottocategoria', fmt: v => esc(v || '—') });
  if (rep === 'Extra') cols.push({ key: 'data', label: 'Data', fmt: dtIt });
  cols.push(
    { key: 'importo', label: rep === 'Extra' ? 'Importo' : '€/mese', fmt: eur },
    { key: 'frequenza', label: 'Frequenza', fmt: v => FREQ_LABEL[v] || v },
    { key: 'note', label: 'Note', fmt: v => esc(v || '') },
  );
  return cols;
};

function renderCostiPage() {
  const content = _mount.querySelector('#fnContent');
  const cm = costiMese(MESE);
  const byRep = r => cm.occ.filter(x => (x.reparto || 'Fissi') === r);
  const totRep = {};
  for (const r of REPARTI) totRep[r] = sumImporti(byRep(r));
  totRep.Commerciale += cm.comm.tot;
  const totale = REPARTI.reduce((a, r) => a + totRep[r], 0);
  const spente = costi().filter(x => !x.attivo);

  const subRep = {
    Fissi: byRep('Fissi').length + ' voci ricorrenti (software, uffici, struttura)',
    Commerciale: byRep('Commerciale').length + ' voci + commissioni automatiche dal venduto',
    Marketing: 'campagne e spese marketing (l’ad spend di SV non è ancora collegato)',
    Delivery: 'il team che eroga il servizio, per funzione',
    Extra: 'spese una tantum del mese (consulenze, viaggi, formazione, rimborsi…)',
  };

  content.innerHTML = `
    <div class="kpi-row" id="fnCostiKpi"></div>
    <div class="card" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div style="margin-right:auto">
        <h2 style="margin-bottom:2px">Totale costi — ${ymLabel(MESE)}</h2>
        <div class="subtitle" style="margin-bottom:0">fissi + commerciale (commissioni incluse) + marketing + delivery + straordinari${cm.rimborsi > 0 ? ' — inclusi ' + eur(cm.rimborsi) + ' di rimborsi' : ''}</div>
      </div>
      <div style="font-size:28px;font-weight:700">${eur(totale)}</div>
    </div>
    ${REPARTI.map(r => `
    <div class="card">
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
        <h2 style="margin-right:auto">${REPARTO_LABEL[r]} · ${eur(totRep[r])}</h2>
        <button class="tk-btn tk-btn-pri" data-nuovo="${r}">+ Voce</button>
      </div>
      <div class="subtitle">${subRep[r]}</div>
      ${r === 'Commerciale' ? `<div class="subtitle" id="fnCommAuto"></div>` : ''}
      <div class="table-scroll"><table id="fnRep${r}"></table></div>
    </div>`).join('')}
    <div class="card">
      <h2>Voci disattivate</h2>
      <div class="subtitle">Storicizzate o da attivare (le voci DEMO del prototipo nascono qui):
        clicca per modificarle e rimetterle in gioco.</div>
      <div class="table-scroll"><table id="fnRepSpente"></table></div>
    </div>`;

  renderKpiRow(_mount.querySelector('#fnCostiKpi'), [
    { label: 'Costi fissi', value: eur(totRep.Fissi) },
    { label: 'Reparto commerciale', value: eur(totRep.Commerciale), sub: 'di cui commissioni ' + eur(cm.comm.tot) },
    { label: 'Marketing', value: eur(totRep.Marketing) },
    { label: 'Delivery', value: eur(totRep.Delivery) },
    { label: 'Costi straordinari', value: eur(totRep.Extra), sub: 'una tantum del mese' },
  ]);

  const commEl = _mount.querySelector('#fnCommAuto');
  if (commEl) commEl.innerHTML = `<strong>Commissioni vendita (auto)</strong>: ${eur(cm.comm.tot)}
    — venditori ${eur(cm.comm.vend)} · setter ${eur(cm.comm.sett)} · PM/MB/BS ${eur(cm.comm.mgr)}
    · calcolate dalle formule Notion sugli incassi del mese`;

  for (const r of REPARTI) {
    const el = _mount.querySelector('#fnRep' + r);
    const rows = byRep(r);
    if (!rows.length) { el.innerHTML = '<div class="status">Nessuna voce' + (r === 'Extra' ? ' nel mese ✓' : '') + '</div>'; continue; }
    if (!costiSort[r]) costiSort[r] = { key: 'importo', dir: -1 };
    renderTable(el, costoCols(r), rows, costiSort[r],
      k => { costiSort[r] = { key: k, dir: costiSort[r].key === k ? -costiSort[r].dir : -1 }; renderCostiPage(); },
      { onRowClick: row => apriFormCosto(row), rowLink: () => true });
  }

  const elSp = _mount.querySelector('#fnRepSpente');
  if (!spente.length) elSp.innerHTML = '<div class="status">Nessuna voce disattivata.</div>';
  else {
    renderTable(elSp, [
      { key: 'descrizione', label: 'Voce' },
      { key: 'reparto', label: 'Reparto' },
      { key: 'importo', label: 'Importo', fmt: eur },
      { key: 'frequenza', label: 'Frequenza', fmt: v => FREQ_LABEL[v] || v },
      { key: 'note', label: 'Note', fmt: v => esc(v || '') },
    ], spente, { key: 'importo', dir: -1 }, () => {},
      { onRowClick: row => apriFormCosto(row), rowLink: () => true });
  }

  content.querySelectorAll('button[data-nuovo]').forEach(b =>
    b.onclick = () => apriFormCosto(null, b.dataset.nuovo));
}

// ── form voce di costo ───────────────────────────────────────────────────────
function apriFormCosto(c, repartoDefault) {
  const box = _mount.querySelector('#fnModal');
  const rep0 = c ? (c.reparto || 'Fissi') : (repartoDefault || 'Fissi');
  const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(l)}</option>`;

  box.innerHTML = `<div class="modal-card tk-form-card">
    <div class="modal-head"><h3>${c ? 'Modifica voce di costo' : 'Nuova voce di costo'}</h3>
      <button class="modal-close" id="fcX" title="Chiudi">✕</button></div>
    <div class="modal-sub">Mensile = conta ogni mese dalla data di inizio (fino all'eventuale fine) ·
      Una tantum = solo nel mese della data.</div>
    <div class="tk-campi">
      <label class="tk-campo tk-largo">Descrizione
        <input type="text" id="fcDescr" maxlength="200" value="${c ? esc(c.descrizione) : ''}" placeholder="Es. Ufficio, Notion, Consulenza legale"></label>
      <label class="tk-campo">Reparto<select id="fcRep">${REPARTI.map(r => opt(r, r, r === rep0)).join('')}</select></label>
      <label class="tk-campo" id="fcRuoloWrap">Ruolo / funzione<select id="fcRuolo">${RUOLI_DELIVERY.map(r => opt(r, r, c && c.ruolo === r)).join('')}</select></label>
      <label class="tk-campo" id="fcSottoSelWrap">Categoria spesa<select id="fcSottoSel">${CATEGORIE_EXTRA.map(x => opt(x, x, c && c.sottocategoria === x)).join('')}</select></label>
      <label class="tk-campo" id="fcSottoWrap">Sottocategoria<input type="text" id="fcSotto" value="${c ? esc(c.sottocategoria || '') : ''}" placeholder="Software, Personale…"></label>
      <label class="tk-campo">Importo €<input type="number" id="fcImp" step="0.01" value="${c ? +c.importo : ''}"></label>
      <label class="tk-campo">Data inizio<input type="date" id="fcData" value="${c ? c.data : dstr(todayRome())}"></label>
      <label class="tk-campo">Frequenza<select id="fcFreq">${['mensile', 'annua', 'una-tantum'].map(f => opt(f, FREQ_LABEL[f], c ? c.frequenza === f : f === 'mensile')).join('')}</select></label>
      <label class="tk-campo">Fine (facoltativa)<input type="month" id="fcFine" value="${c && c.fine ? c.fine.slice(0, 7) : ''}"></label>
      <label class="tk-campo">Categoria P&amp;L<select id="fcCat">${CAT_COSTI.map(x => opt(x, x, c ? c.categoria === x : x === 'Operativi')).join('')}</select></label>
      <label class="tk-campo">Responsabile<input type="text" id="fcResp" value="${c ? esc(c.responsabile || '') : ''}"></label>
      <label class="tk-campo tk-largo">Note<input type="text" id="fcNote" value="${c ? esc(c.note || '') : ''}"></label>
      <label class="tk-campo tk-largo" style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" id="fcAttivo" style="width:16px;height:16px" ${!c || c.attivo ? 'checked' : ''}>
        Attiva (deseleziona per storicizzare senza cancellare)</label>
    </div>
    <div class="tk-azioni tk-azioni-form">
      <span class="tk-msg" id="fcMsg"></span>
      ${c ? '<button class="tk-btn tk-btn-danger" id="fcElimina">Elimina</button>' : ''}
      <button class="tk-btn tk-btn-ghost" id="fcAnnulla">Annulla</button>
      <button class="tk-btn tk-btn-pri" id="fcSalva">Salva</button>
    </div>
  </div>`;
  box.classList.remove('hidden');

  const q = id => box.querySelector('#' + id);
  const aggiornaCampi = () => {
    const rep = q('fcRep').value;
    q('fcRuoloWrap').style.display = rep === 'Delivery' ? '' : 'none';
    q('fcSottoSelWrap').style.display = rep === 'Extra' ? '' : 'none';
    q('fcSottoWrap').style.display = (rep === 'Delivery' || rep === 'Extra') ? 'none' : '';
  };
  aggiornaCampi();
  q('fcRep').onchange = aggiornaCampi;
  q('fcDescr').focus();

  const chiudi = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  q('fcX').onclick = chiudi;
  q('fcAnnulla').onclick = chiudi;
  box.onclick = e => { if (e.target === box) chiudi(); };

  q('fcSalva').onclick = async () => {
    const descr = q('fcDescr').value.trim();
    if (!descr) { q('fcMsg').textContent = 'Serve una descrizione.'; return; }
    if (!q('fcData').value) { q('fcMsg').textContent = 'Serve la data di inizio.'; return; }
    const rep = q('fcRep').value;
    const riga = {
      descrizione: descr,
      reparto: rep,
      ruolo: rep === 'Delivery' ? q('fcRuolo').value : null,
      sottocategoria: rep === 'Extra' ? q('fcSottoSel').value : (rep === 'Delivery' ? ('Personale: ' + q('fcRuolo').value) : (q('fcSotto').value.trim() || null)),
      categoria: q('fcCat').value,
      importo: +q('fcImp').value || 0,
      data: q('fcData').value,
      fine: q('fcFine').value ? q('fcFine').value + '-01' : null,
      frequenza: q('fcFreq').value,
      responsabile: q('fcResp').value.trim() || null,
      note: q('fcNote').value.trim() || null,
      attivo: q('fcAttivo').checked,
      aggiornato_a: new Date().toISOString(),
    };
    q('fcSalva').disabled = true;
    const { error } = c
      ? await supabase.from('fin_costi').update(riga).eq('id', c.id)
      : await supabase.from('fin_costi').insert(riga);
    q('fcSalva').disabled = false;
    if (error) { q('fcMsg').textContent = error.message; return; }
    chiudi();
    await ricaricaCosti();
    renderAll();
  };

  const del = q('fcElimina');
  if (del) del.onclick = async () => {
    if (!confirm('Eliminare definitivamente questa voce? Consiglio: disattivala invece, per mantenere lo storico.')) return;
    const { error } = await supabase.from('fin_costi').delete().eq('id', c.id);
    if (error) { q('fcMsg').textContent = error.message; return; }
    chiudi();
    await ricaricaCosti();
    renderAll();
  };
}

// ── tab P&L (conto economico per cassa) ──────────────────────────────────────
// Due viste della stessa scala:
//  · FOGLIO — il conto economico dichiarato in "PL Database Input", voce per voce
//    come lo scrive Leo. E' il dato ufficiale dei mesi chiusi.
//  · CALCOLATO — ricavi da fin_incassi (Notion) e costi da fin_costi. E' l'unico
//    possibile sul mese in corso, ma sui mesi chiusi vale poco: il registro costi
//    non ha storico (tutte voci mensili dal 2026-01-01) e non conosce l'ad spend.
// In automatico vince il foglio dove c'e'; i chip permettono di forzare l'altra.
let PNL_VISTA = null;

// quanto pesa la voce `voce` nel mese x (null = riga assente = casella vuota)
const importoVoce = (x, voce) => {
  if (!x.fg) return null;
  const r = x.fg.righe.find(y => y.voce === voce);
  return r ? (+r.importo || 0) : null;
};
// somma delle voci del foglio la cui etichetta combacia con re (per le incidenze)
const sommaSe = (fg, re) => !fg ? 0 : fg.righe
  .filter(r => r.tipo === 'voce' && re.test(r.voce))
  .reduce((a, r) => a + (+r.importo || 0), 0);
const RE_PERSONALE = /^(Personale:|Commissioni |Bonus pagati)/i;
const RE_MARKETING = /^(Ad spend|Costo team marketing|Marketing brand)/i;

function renderPnl() {
  const forza = PNL_VISTA === 'calcolato' ? 'calcolato' : undefined;
  const d = pnl(MESE, forza);
  const p = pnl(addYm(MESE, -1), forza);
  const rn = d.ricaviNetti;
  const foglio = d.fonte === 'foglio';

  // riga: etichetta | mese | % ricavi netti | mese prima | Δ
  // costo = true → si mostra in negativo e il Δ va letto al contrario
  // valore null (voce non compilata sul foglio) → "—", senza quota né Δ
  const riga = (label, get, opt = {}) => {
    const v = get(d), vp = get(p);
    const f = opt.pct ? (x => x === null ? '—' : pctFrac(x)) : eur;
    const quota = (!opt.pct && !opt.noQuota && rn > 0 && v !== null) ? pctFrac(Math.abs(v) / rn) : '';
    let delta = '';
    if (!opt.noDelta && v !== null && vp !== null && vp !== 0 && !opt.pct) {
      const dl = 100 * (v - vp) / Math.abs(vp);
      const buono = opt.costo ? dl <= 0 : dl >= 0;
      delta = `<span class="${buono ? 'val-good' : 'val-bad'}">${dl >= 0 ? '+' : ''}${fmt(dl)}%</span>`;
    }
    return `<tr class="${opt.cls || ''}">
      <td class="name"${opt.indent ? ' style="padding-left:26px;color:var(--muted)"' : ''}>${esc(label)}</td>
      <td>${opt.costo && v > 0 ? '−' : ''}${f(v)}</td>
      <td class="fn-quota">${quota}</td>
      <td class="fn-quota">${opt.costo && vp > 0 ? '−' : ''}${f(vp)}</td>
      <td>${delta}</td></tr>`;
  };
  const testa = t => `<tr class="fn-head"><td colspan="5">${t}</td></tr>`;

  // voci del foglio da stampare: unione dei due mesi, nell'ordine del foglio —
  // così una riga che c'è solo nel mese prima resta comunque confrontabile
  const unione = new Map();
  for (const r of [...(d.fg ? d.fg.righe : []), ...(p.fg ? p.fg.righe : [])])
    if (!unione.has(r.voce)) unione.set(r.voce, r);
  const vociSez = sez => [...unione.values()]
    .filter(r => r.sezione === sez).sort((a, b) => a.ordine - b.ordine);
  const bloccoSez = (titolo, sez, opt) =>
    testa(titolo) + vociSez(sez)
      .map(r => riga(r.voce, x => importoVoce(x, r.voce),
                     r.tipo === 'dettaglio' ? { indent: true } : opt)).join('');

  const cm = d.cm;
  const persCost = foglio
    ? sommaSe(d.fg, RE_PERSONALE)
    : sumImporti(cm.voci.filter(c =>
        (c.reparto === 'Delivery' || c.reparto === 'Commerciale' ||
         String(c.sottocategoria || '').toLowerCase().indexOf('personale') !== -1))) + cm.comm.tot;
  const costoMkt = foglio ? sommaSe(d.fg, RE_MARKETING)
                          : sumImporti(cm.voci.filter(c => c.reparto === 'Marketing'));
  const fissi = d.operativi + d.strutturali;
  const breakEven = d.pctLordo > 0.05 ? (fissi + d.rimborsi) / d.pctLordo : null;

  // "Dove vanno i soldi": dal foglio sono le sue stesse voci di costo,
  // altrimenti il registro raggruppato per ruolo
  const topCosti = (foglio
    ? ['diretti', 'operativi', 'strutturali']
        .flatMap(s => d.fg.righe.filter(r => r.sezione === s && r.tipo === 'voce'))
        .map(r => ({ etichetta: r.voce, importo: +r.importo || 0, n: 1 }))
        .filter(x => x.importo > 0.5).sort((a, b) => b.importo - a.importo)
    : costiRaggruppati(cm)).slice(0, 12);
  const maxCosto = topCosti.length ? topCosti[0].importo : 1;

  // crediti fuori P&L: le righe informative in fondo al foglio
  const info = d.fg ? d.fg.righe.filter(r => r.sezione === 'info' && (+r.importo || 0) > 0) : [];

  // riconciliazione foglio ↔ app: sono due fonti diverse, le differenze contano
  const commFoglio = sommaSe(d.fg, /^Commissioni /i);
  const conf = !d.fg ? [] : [
    ['Cash incassato', d.fg.lordi, d.calcolato.lordi, 'foglio vs somma delle rate con data incasso nel mese (Notion)'],
    ['Rimborsi e storni', d.fg.rimborsi, d.calcolato.rimborsi, 'sul registro costi sono le voci con sottocategoria "Rimborsi"'],
    ['Commissioni', commFoglio, cm.comm.tot, 'foglio vs formule commissione di Notion (venditore + setter + PM/MB/BS)'],
    ['Costi totali', d.fg.costiTot, d.calcolato.costiTot, 'tutto quello che esce nel mese, rimborsi inclusi'],
    ['EBITDA', d.fg.ebitda, d.calcolato.ebitda, 'il numero che finisce in Dashboard e nel grafico 12 mesi'],
  ];

  _mount.querySelector('#fnContent').innerHTML = `
    <div class="kpi-row" id="fnPnlKpi"></div>

    <div class="card">
      <h2>Conto economico (per cassa) — ${ymLabel(MESE)}</h2>
      <div class="lead-tabs" id="fnPnlFonte">
        <button data-v="foglio">Foglio P&L</button>
        <button data-v="calcolato">Calcolato (Notion + registro costi)</button>
      </div>
      <div class="subtitle">${foglio
        ? `Numeri <strong>dichiarati</strong> sul foglio "PL Database Input", voce per voce come stanno lì.
           Sui mesi chiusi è il dato ufficiale: il registro costi dell'app non ha storico
           (nessuna riga per l'ad spend, la parte fissa dei setter, i compensi amministratori)
           e da solo darebbe un margine gonfiato.`
        : `Ricavi = incassi realmente entrati nel mese (non il fatturato contrattualizzato); costi dal registro.
           ${d.fg ? 'Vista forzata: per questo mese <strong>esiste</strong> anche il conto economico del foglio.'
                  : 'Per questo mese <strong>non c\'è ancora</strong> una colonna sul foglio P&L.'}`}
        La colonna <strong>% ricavi</strong> è sull'incassato netto; il <strong>Δ</strong> confronta col mese
        precedente (verde = va nella direzione giusta, anche quando è un costo che scende).</div>
      <div class="table-scroll"><table class="fn-pnl">
        <thead><tr><th>Voce</th><th>${ymLabel(MESE)}</th><th>% ricavi</th><th>${ymLabel(addYm(MESE, -1))}</th><th>Δ</th></tr></thead>
        <tbody>
          ${foglio ? `
          ${bloccoSez('Ricavi — cash incassato', 'ricavi')}
          ${bloccoSez('Storni e rimborsi', 'rimborsi', { costo: true })}
          ${riga('RICAVI NETTI', x => x.ricaviNetti, { cls: 'fn-tot' })}
          ${bloccoSez('Costi diretti (variabili con il fatturato)', 'diretti', { costo: true })}
          ${riga('MARGINE LORDO', x => x.margineLordo, { cls: 'fn-tot' })}
          ${riga('% Margine lordo', x => x.pctLordo, { pct: true, noDelta: true })}
          ${bloccoSez('Costi operativi (struttura — fissi)', 'operativi', { costo: true })}
          ${riga('MARGINE OPERATIVO', x => x.margineOp, { cls: 'fn-tot' })}
          ${riga('% Margine operativo', x => x.pctOp, { pct: true, noDelta: true })}
          ${bloccoSez('Costi strutturali (azienda, soci)', 'strutturali', { costo: true })}
          ${riga('MARGINE NETTO (EBITDA)', x => x.ebitda, { cls: 'fn-tot' })}
          ${riga('% Margine netto', x => x.pctEbitda, { pct: true, noDelta: true })}
          ` : `
          ${testa('Ricavi — cash incassato')}
          ${riga('Cash incassato (totale)', x => x.lordi, { cls: 'fn-tot' })}
          ${riga('di cui: prime rate (nuovi clienti)', x => x.s.nuovi, { indent: true })}
          ${riga('di cui: rate successive', x => x.s.rate, { indent: true })}
          ${riga('di cui: rinnovi', x => x.s.rinnovi, { indent: true })}
          ${riga('di cui: upsell', x => x.s.upsell, { indent: true })}
          ${testa('Storni e rimborsi')}
          ${riga('Rimborsi e storni', x => x.rimborsi, { costo: true })}
          ${riga('RICAVI NETTI', x => x.ricaviNetti, { cls: 'fn-tot' })}
          ${testa('Costi diretti (variabili)')}
          ${riga('Commissioni venditori', x => x.cm.comm.vend, { costo: true })}
          ${riga('Commissioni setter', x => x.cm.comm.sett, { costo: true })}
          ${riga('Commissioni PM / MB / BS', x => x.cm.comm.mgr, { costo: true })}
          ${riga('Altri costi diretti (registro)', x => x.cm.cat.Diretti, { costo: true })}
          ${riga('MARGINE LORDO', x => x.margineLordo, { cls: 'fn-tot' })}
          ${riga('% Margine lordo', x => x.pctLordo, { pct: true, noDelta: true })}
          ${testa('Costi operativi (struttura)')}
          ${riga('Costi operativi', x => x.cm.cat.Operativi, { costo: true })}
          ${riga('MARGINE OPERATIVO', x => x.margineOp, { cls: 'fn-tot' })}
          ${riga('% Margine operativo', x => x.pctOp, { pct: true, noDelta: true })}
          ${testa('Costi strutturali (azienda, soci)')}
          ${riga('Costi strutturali', x => x.cm.cat.Strutturali, { costo: true })}
          ${riga('EBITDA', x => x.ebitda, { cls: 'fn-tot' })}
          ${riga('% EBITDA', x => x.pctEbitda, { pct: true, noDelta: true })}
          ${testa('Investimenti e asset')}
          ${riga('Investimenti + asset', x => x.cm.capex, { costo: true })}
          ${riga('CASH FLOW (margine netto)', x => x.cashFlow, { cls: 'fn-tot' })}
          `}
        </tbody>
      </table></div>
      ${info.length ? `<div class="subtitle" style="margin-top:10px">Fuori dal P&L, dal foglio:
        ${info.map(r => esc(r.voce) + ' <strong>' + eur(+r.importo) + '</strong>').join(' · ')}.</div>` : ''}
    </div>

    <div class="kpi-row" id="fnPnlInc"></div>

    ${conf.length ? `
    <div class="card">
      <h2>Foglio e app a confronto — ${ymLabel(MESE)}</h2>
      <div class="subtitle">Le due fonti non devono per forza coincidere: il foglio è la cassa come la vede
        l'amministrazione, l'app somma il registro rate di Notion e il registro costi. Le differenze grosse
        sono un buon posto dove cercare rate mancanti o costi mai registrati.</div>
      <div class="table-scroll"><table class="fn-pnl">
        <thead><tr><th>Voce</th><th>Foglio</th><th>Calcolato dall'app</th><th>Δ</th><th>Come leggerla</th></tr></thead>
        <tbody>${conf.map(([lab, a, b, nota]) => `
          <tr><td class="name">${esc(lab)}</td><td>${eur(a)}</td><td>${eur(b)}</td>
            <td><span class="${Math.abs(a - b) < 1 ? '' : (a - b >= 0 ? 'val-good' : 'val-bad')}">${
              (a - b >= 0 ? '+' : '−') + eur(Math.abs(a - b))}</span></td>
            <td class="fn-nota">${esc(nota)}</td></tr>`).join('')}
        </tbody>
      </table></div>
    </div>` : ''}

    <div class="card">
      <h2>Dove vanno i soldi — ${ymLabel(MESE)}</h2>
      <div class="subtitle">${foglio
        ? 'Le 12 voci di costo più pesanti del foglio, così come sono scritte lì.'
        : `Le 12 voci più pesanti del mese, commissioni incluse.
           Il personale è unito per ruolo: una riga per i project manager, una per i media buyer e così via
           (il dettaglio persona per persona è nella tab Costi).`}</div>
      ${topCosti.length ? topCosti.map(x => `
        <div class="esito-row">
          <div class="esito-top"><span class="lbl">${esc(x.etichetta)}${x.n > 1 ? ` <span style="color:var(--muted);font-weight:400">· ${x.n} persone</span>` : ''}</span>
            <span class="val"><b>${eur(x.importo)}</b> · ${fmtPct(pct(x.importo, d.costiTot))}</span></div>
          <div class="esito-track"><div class="esito-fill" style="width:${Math.max(2, Math.round(100 * x.importo / maxCosto))}%;background:var(--series-1)"></div></div>
        </div>`).join('') : '<div class="status">Nessun costo nel mese.</div>'}
    </div>`;

  _mount.querySelectorAll('#fnPnlFonte button').forEach(b => {
    b.classList.toggle('active', b.dataset.v === d.fonte);
    b.onclick = () => { PNL_VISTA = b.dataset.v; renderPnl(); };
  });

  renderKpiRow(_mount.querySelector('#fnPnlKpi'), [
    { label: 'Fatturato contrattualizzato', value: eur(d.contrattualizzato), sub: 'valore dei contratti firmati nel mese (Notion)' },
    { label: 'Ricavi netti (cassa)', value: eur(rn), sub: 'incassato − rimborsi' },
    { label: 'Margine lordo', value: eur(d.margineLordo), sub: d.pctLordo === null ? '' : pctFrac(d.pctLordo) + ' dei ricavi netti' },
    { label: 'Margine operativo', value: eur(d.margineOp), sub: d.pctOp === null ? '' : pctFrac(d.pctOp) + ' dei ricavi netti' },
    { label: foglio ? 'Margine netto (EBITDA)' : 'EBITDA', value: eur(d.ebitda),
      tone: d.ebitda >= 0 ? 'good' : 'bad',
      sub: d.pctEbitda === null ? '' : pctFrac(d.pctEbitda) + ' dei ricavi netti' },
  ]);

  renderKpiRow(_mount.querySelector('#fnPnlInc'), [
    { label: 'Incidenza personale', value: rn > 0 ? pctFrac(persCost / rn) : '—',
      sub: eur(persCost) + ' fra team e commissioni' },
    { label: 'Incidenza costi fissi', value: rn > 0 ? pctFrac(fissi / rn) : '—',
      sub: 'operativi + strutturali sui ricavi netti' },
    { label: 'Incidenza marketing', value: rn > 0 ? pctFrac(costoMkt / rn) : '—',
      sub: eur(costoMkt) + (foglio ? ' fra ad spend e team marketing' : ' di spese marketing registrate') },
    { label: 'Break even incassi', value: breakEven === null ? '—' : eur(breakEven),
      sub: 'incasso che copre i costi fissi, al margine lordo del mese' },
    { label: 'Costi totali', value: eur(d.costiTot), sub: 'tutto quello che è uscito nel mese' },
  ]);
}

// ── tab Marketing ────────────────────────────────────────────────────────────
// Una sola cosa si scrive a mano: i dati del mese. Tutto il resto della pagina
// (KPI, funnel, grafico, tabella) si calcola da lì e non si salva da nessuna
// parte, così non può mai raccontare qualcosa di diverso da ciò che è inserito.
// Fonte unica: fin_mkt_mese, 1 riga = 1 mese.
const MKT_CAMPI = [
  { k: 'budget_meta',    l: 'Budget Meta €' },
  { k: 'budget_google',  l: 'Budget Google €' },
  { k: 'impressioni',    l: 'Impressioni' },
  { k: 'click',          l: 'Click' },
  { k: 'lead',           l: 'Lead' },
  { k: 'contatti',       l: 'Contatti' },
  { k: 'app_fissati',    l: 'Appuntamenti fissati' },
  { k: 'show_up',        l: 'Show up' },
  { k: 'trial',          l: 'Trial' },
  { k: 'clienti_chiusi', l: 'Clienti chiusi' },
  { k: 'fatturato',      l: 'Fatturato generato €' },
  { k: 'incasso',        l: 'Incasso generato €' },
];
const TARGET_CAC = 800;                       // costo per cliente oltre il quale la tile diventa rossa

const rigaMkt = m => (DATA.mktMese || []).find(r => r.mese === m) || null;
// numeri del mese: solo divisioni sui campi inseriti, mai valori inventati.
// Se manca il numeratore o il denominatore il KPI resta null → "—", non zero.
function mktKpi(m) {
  const r = rigaMkt(m);
  const n = k => (r && r[k] !== null && r[k] !== undefined && r[k] !== '') ? +r[k] : null;
  const k = { mese: m, vuoto: !r };
  MKT_CAMPI.forEach(c => { k[c.k] = n(c.k); });
  k.budget = (k.budget_meta === null && k.budget_google === null)
    ? null : (k.budget_meta || 0) + (k.budget_google || 0);
  const q = (a, b) => (a === null || b === null || !(b > 0)) ? null : a / b;
  k.cpl      = q(k.budget, k.lead);
  k.cpm      = k.impressioni > 0 && k.budget !== null ? k.budget / k.impressioni * 1000 : null;
  k.ctr      = q(k.click, k.impressioni);
  k.cac      = q(k.budget, k.clienti_chiusi);
  k.risposta = q(k.contatti, k.lead);
  k.roas     = q(k.fatturato, k.budget);
  k.roi      = (k.incasso === null || !(k.budget > 0)) ? null : (k.incasso - k.budget) / k.budget;
  k.booking  = q(k.app_fissati, k.contatti);
  k.showRate = q(k.show_up, k.app_fissati);
  k.trialRate = q(k.trial, k.show_up);
  k.closing  = q(k.clienti_chiusi, k.trial);
  k.ticket   = q(k.fatturato, k.clienti_chiusi);
  return k;
}
const mesiMkt = () => (DATA.mktMese || []).map(r => r.mese).sort();

const MKT_HTML = `
  <div class="sm-head">
    <div>
      <h2 class="sm-title">Marketing — <span id="mkMese"></span></h2>
      <div class="sm-sub">Scrivi i dati del mese qui sotto: KPI, funnel, grafico e tabella
        si riempiono da soli con quello che inserisci.</div>
    </div>
  </div>

  <div class="card">
    <h2>Inserimento dati mese</h2>
    <div class="subtitle">Si salva da solo appena esci da una casella. Lascia vuoto ciò che non hai:
      un campo vuoto non vale zero, i KPI che dipendono da lui restano "—".</div>
    <div class="mm-grid" id="mkForm"></div>
  </div>

  <div class="kpi-row kpi-4" id="mkKpi"></div>

  <div class="card">
    <h2>Funnel</h2>
    <div class="subtitle">Dal lead al cliente, con la percentuale che passa da un gradino all'altro.</div>
    <div class="funnel" id="mkFunnel"></div>
    <div class="funnel-kpis" id="mkFunnelKpi"></div>
  </div>

  <div class="card">
    <h2>Andamento 12 mesi</h2>
    <div class="subtitle">Budget speso e fatturato generato, mese per mese.</div>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--series-1)"></span>Budget</span>
      <span class="key"><span class="swatch" style="background:var(--series-2)"></span>Fatturato generato</span>
    </div>
    <div class="chart-wrap"><svg id="mkTrend" width="100%" height="280"></svg></div>
  </div>

  <div class="card">
    <h2>Mese per mese</h2>
    <div class="subtitle">Tutti i mesi inseriti, con i KPI ricalcolati riga per riga.</div>
    <div class="table-scroll"><table id="mkTabella"></table></div>
  </div>`;

function renderMarketing() {
  _mount.querySelector('#fnContent').innerHTML = MKT_HTML;
  _mount.querySelector('#mkMese').textContent = ymLabel(MESE);
  renderMktForm();
  renderMktKpi();
  renderMktFunnel();
  renderMktTrend();
  renderMktTabella();
}

function renderMktForm() {
  const el = _mount.querySelector('#mkForm');
  if (!el) return;
  const r = rigaMkt(MESE) || {};
  el.innerHTML = MKT_CAMPI.map(c => `
    <label class="mm-campo">
      <span>${c.l}</span>
      <input class="mm-inp" data-k="${c.k}" inputmode="decimal" placeholder="0"
        value="${r[c.k] === null || r[c.k] === undefined ? '' : r[c.k]}">
    </label>`).join('');
  el.querySelectorAll('.mm-inp').forEach(inp => {
    inp.onchange = () => salvaMkt(inp.dataset.k, inp.value);
  });
}

function renderMktKpi() {
  const el = _mount.querySelector('#mkKpi');
  if (!el) return;
  const k = mktKpi(MESE);
  const cacTono = k.cac === null ? undefined : (k.cac <= TARGET_CAC ? 'good' : 'bad');
  renderKpiRow(el, [
    { label: 'Budget totale', value: eur(k.budget), info: 'Budget Meta + Budget Google del mese.' },
    { label: 'CPL', value: k.cpl === null ? '—' : eur2(k.cpl), info: 'Budget totale ÷ lead: quanto costa un lead.' },
    { label: 'CPM', value: k.cpm === null ? '—' : eur2(k.cpm), info: 'Costo di mille impressioni: budget ÷ impressioni × 1.000.' },
    { label: 'CTR', value: k.ctr === null ? '—' : pctFrac(k.ctr), info: 'Click ÷ impressioni: quanta parte di chi vede l\'annuncio ci clicca.' },
    { label: 'CAC', value: k.cac === null ? '—' : eur(k.cac), tone: cacTono,
      sub: 'target ' + eur(TARGET_CAC),
      info: 'Budget totale ÷ clienti chiusi. Diventa rosso sopra il target di ' + eur(TARGET_CAC) + '.' },
    { label: 'Tasso risposta', value: k.risposta === null ? '—' : pctFrac(k.risposta),
      info: 'Contatti ÷ lead: quanti lead si riescono a raggiungere davvero.' },
    { label: 'ROAS', value: k.roas === null ? '—' : ratio(k.roas),
      info: 'Fatturato generato (' + eur(k.fatturato) + ') ÷ budget: quante volte torna indietro quello che si spende.' },
    { label: 'ROI', value: k.roi === null ? '—' : pctFrac(k.roi),
      tone: k.roi === null ? undefined : (k.roi >= 0 ? 'good' : 'bad'),
      info: 'Sul CASSA, non sul contrattualizzato: (incasso generato − budget) ÷ budget.' },
  ]);
}

function renderMktFunnel() {
  const el = _mount.querySelector('#mkFunnel');
  const elK = _mount.querySelector('#mkFunnelKpi');
  if (!el) return;
  const k = mktKpi(MESE);
  const stadi = [
    { nome: 'Lead', val: k.lead },
    { nome: 'Contatti', val: k.contatti },
    { nome: 'Appuntamenti fissati', val: k.app_fissati },
    { nome: 'Show up', val: k.show_up },
    { nome: 'Trial', val: k.trial },
    { nome: 'Clienti chiusi', val: k.clienti_chiusi },
  ];
  if (!stadi.some(s => s.val !== null)) {
    el.innerHTML = '<div class="status">Inserisci i dati del mese.</div>';
    elK.innerHTML = '';
    return;
  }
  const base = k.lead;
  const q = (a, b) => (a === null || b === null || !(b > 0)) ? null : a / b;
  el.innerHTML = stadi.map((s, i) => {
    const step = i > 0 ? `<div class="f-step">↓ ${pctFrac(q(s.val, stadi[i - 1].val))}</div>` : '';
    const w = base > 0 ? Math.max((s.val || 0) / base * 100, 2.5) : 2.5;
    return `${step}
      <div class="f-label"><span class="f-name">${s.nome}</span>
        <span class="f-val">${fmt(s.val)}</span>
        <span class="f-share">${pctFrac(q(s.val, base))}</span></div>
      <div class="f-bar f-bar-${Math.min(i + 1, 5)}" style="width:${w}%"></div>`;
  }).join('');
  const box = (l, v, s) => `<div class="f-kpi"><span class="f-kpi-label">${l}</span>
    <span class="f-kpi-val">${v}</span><span class="f-kpi-sub">${s}</span></div>`;
  elK.innerHTML =
    box('Da contatto ad appuntamento', pctFrac(k.booking), 'appuntamenti ÷ contatti') +
    box('Show up', pctFrac(k.showRate), 'presentati ÷ appuntamenti') +
    box('Da show up a trial', pctFrac(k.trialRate), 'trial ÷ presentati') +
    box('Closing', pctFrac(k.closing), 'clienti ÷ trial') +
    box('Ticket medio', eur(k.ticket), 'fatturato ÷ clienti') +
    box('Costo per cliente', k.cac === null ? '—' : eur(k.cac), 'budget ÷ clienti');
}

function renderMktTrend() {
  const el = _mount.querySelector('#mkTrend');
  if (!el) return;
  const primo = mesiMkt()[0];
  const months = [];
  for (let i = 11; i >= 0; i--) { const m = addYm(MESE, -i); if (!primo || m >= primo) months.push(m); }
  if (!months.length) { el.innerHTML = ''; return; }
  const rows = months.map(m => {
    const k = mktKpi(m);
    return { ...k, bud: k.budget || 0, fat: k.fatturato || 0 };
  });
  renderLineChart(el, months, rows, [
    { key: 'bud', color: '--series-1', name: 'Budget' },
    { key: 'fat', color: '--series-2', name: 'Fatturato generato' },
  ], {
    xlab: ymShort, yfmt: eur, axisFmt: fmtCompact, height: 280,
    tip: (r, m) => `<div class="t-date">${ymLabel(m)}</div>
      <div class="t-row"><span>Budget</span><b>${eur(r.budget)}</b></div>
      <div class="t-row"><span>Fatturato</span><b>${eur(r.fatturato)}</b></div>
      <div class="t-row"><span>Lead</span><b>${fmt(r.lead)}</b></div>
      <div class="t-row"><span>CPL</span><b>${r.cpl === null ? '—' : eur2(r.cpl)}</b></div>
      <div class="t-row"><span>Clienti chiusi</span><b>${fmt(r.clienti_chiusi)}</b></div>
      <div class="t-row"><span>ROAS</span><b>${r.roas === null ? '—' : ratio(r.roas)}</b></div>`,
  });
}

const mktCols = [
  { key: 'mese', label: 'Mese', fmt: v => ymLabel(v) },
  { key: 'budget', label: 'Budget', fmt: eur },
  { key: 'impressioni', label: 'Impressioni', fmt },
  { key: 'ctr', label: 'CTR', fmt: pctFrac },
  { key: 'lead', label: 'Lead', fmt },
  { key: 'cpl', label: 'CPL', fmt: v => v === null ? '—' : eur2(v) },
  { key: 'contatti', label: 'Contatti', fmt },
  { key: 'app_fissati', label: 'App. fissati', fmt },
  { key: 'show_up', label: 'Show up', fmt },
  { key: 'trial', label: 'Trial', fmt },
  { key: 'clienti_chiusi', label: 'Clienti', fmt },
  { key: 'cac', label: 'CAC', fmt: eur },
  { key: 'fatturato', label: 'Fatturato', fmt: eur },
  { key: 'incasso', label: 'Incasso', fmt: eur },
  { key: 'roas', label: 'ROAS', fmt: ratio },
  { key: 'roi', label: 'ROI', fmt: pctFrac },
];

function renderMktTabella() {
  const el = _mount.querySelector('#mkTabella');
  if (!el) return;
  const rows = mesiMkt().map(mktKpi).reverse();
  if (!rows.length) {
    el.innerHTML = '<div class="status">Ancora nessun mese inserito.</div>';
    return;
  }
  renderTable(el, mktCols, rows, mktSort,
    k => { mktSort = { key: k, dir: mktSort.key === k ? -mktSort.dir : -1 }; renderMktTabella(); },
    { barKey: 'budget' });
}

// scrittura: upsert della riga del mese, poi si ridisegna tutto quello che
// dipende da lei (stesso schema di fin_costi/fin_capacita, niente refetch)
async function salvaMkt(campo, valore) {
  const v = String(valore).trim() === '' ? null : Math.max(0, +String(valore).replace(',', '.') || 0);
  const riga = { ...(rigaMkt(MESE) || {}), mese: MESE, [campo]: v, agg_at: new Date().toISOString() };
  const { error } = await supabase.from('fin_mkt_mese').upsert(riga, { onConflict: 'mese' });
  if (error) { alert('Non sono riuscito a salvare: ' + error.message); return; }
  DATA.mktMese = (DATA.mktMese || []).filter(r => r.mese !== MESE).concat([riga]);
  renderMktKpi();
  renderMktFunnel();
  renderMktTrend();
  renderMktTabella();
}


// ── tab Delivery ─────────────────────────────────────────────────────────────
// La capienza NON è più un 35 fisso: si imposta persona per persona nelle tabelle
// qui sotto (tabella fin_capacita) e da lì escono saturazione e riempimento team.
// base = su cosa si misura il carico di quel ruolo:
//   'operativo' → portafoglio operativo: i clienti su cui si lavora davvero adesso
//                 (esclude spostati a estetista indipendente, riparte a settembre,
//                  standby e quelli senza stato: sono parcheggiati, non carico)
//   'attive'    → solo le aziende con ADS ATTIVE (le beauty lavorano solo quelle)
//   'gestiti'   → tutti i clienti non persi (portafoglio assegnato, non carico)
const STATO_ATTIVE = 'ADS ATTIVE';
const STATI_OPERATIVI = ['ADS ATTIVE', 'ADS DA LANCIARE', 'ONBOARDING', 'IN ATTESA DI RINNOVO',
                         'OPEN DAY', 'GESTIONE SOCIAL'];
const RUOLI_CAP = [
  { key: 'PM',          campo: 'consulente',  label: 'Project manager',   plur: 'project manager',
    base: 'operativo', def: 35, baseTxt: 'clienti nel portafoglio operativo' },
  { key: 'BEAUTY',      campo: 'beauty',      label: 'Beauty specialist', plur: 'beauty specialist',
    base: 'attive',    def: 12, baseTxt: 'aziende con ADS ATTIVE' },
  { key: 'MEDIA_BUYER', campo: 'media_buyer', label: 'Media buyer',       plur: 'media buyer',
    base: 'operativo', def: 35, baseTxt: 'clienti nel portafoglio operativo' },
];
const RUOLO = k => RUOLI_CAP.find(x => x.key === k);
const NON_ASSEGNATO = '(non assegnato)';
// chi è stato tolto dal team in Accessi → Team non deve restare in elenco come se
// lavorasse ancora, ma i suoi clienti non spariscono: finiscono tutti in una riga
// sola, altrimenti il carico del reparto sembrerebbe più basso di quello che è.
const USCITI = '(non più nel team)';

let CAP = new Map();                          // "RUOLO|persona_id" → capienza
function rebuildCap() {
  CAP = new Map();
  for (const c of (DATA && DATA.capacita ? DATA.capacita : [])) {
    CAP.set(c.ruolo + '|' + c.persona_id, +c.capacita || 0);
  }
}
const capDi = (ruolo, pid) => {
  const v = CAP.get(ruolo + '|' + pid);
  return v === undefined ? RUOLO(ruolo).def : v;
};
const capImpostata = (ruolo, pid) => CAP.has(ruolo + '|' + pid);

// una riga per persona del ruolo, col suo carico, i suoi rinnovi e la sua capienza
function caricoPerRuolo(ruolo) {
  const R = RUOLO(ruolo);
  const campo = R.campo;
  const perNome = centriByNome();
  const m = new Map();
  // ⚠️ la chiave è la PERSONA, non il valore grezzo: le due email di Guido devono
  // fare una riga sola, e "Simone Alessandrini" (che entra dal ripiego sugli
  // incassi, più sotto) non deve litigare con smnalessandrini@gmail.com.
  const get = raw => {
    const pid = raw === NON_ASSEGNATO ? null : personaDi(raw);
    const fuori = pid !== null && !personaAttiva(pid);
    const k = raw === NON_ASSEGNATO ? NON_ASSEGNATO : (fuori ? USCITI : chiavePersona(raw));
    let a = m.get(k);
    if (!a) {
      a = { chiave: k, persona_id: fuori ? null : pid,
            pm: k === NON_ASSEGNATO ? NON_ASSEGNATO : (fuori ? USCITI : nomeDi(raw)),
            ruoloOk: k === NON_ASSEGNATO || fuori || personaHaRuolo(raw, ruolo),
            usciti: new Set(), ruolo,
            gestiti: 0, attive: 0, operativi: 0, onboarding: 0, attesaRinnovo: 0,
            persi12m: 0, rinnovi: 0, incassato: 0 };
      m.set(k, a);
    }
    if (fuori) a.usciti.add(pid);
    return a;
  };
  const limite12m = addYm(dstr(todayRome()).slice(0, 7), -11) + '-01';

  for (const c of centriRows()) {
    const a = get(c[campo] || NON_ASSEGNATO);
    if (isGestito(c)) {
      a.gestiti += 1;
      if (hasTag(c.stato_attivita, STATO_ATTIVE)) a.attive += 1;
      if (STATI_OPERATIVI.some(s => hasTag(c.stato_attivita, s))) a.operativi += 1;
      if (hasTag(c.stato_attivita, 'ONBOARDING')) a.onboarding += 1;
      if (hasTag(c.stato_attivita, 'IN ATTESA DI RINNOVO')) a.attesaRinnovo += 1;
    }
    if (c.data_cliente_perso && c.data_cliente_perso >= limite12m) a.persi12m += 1;
  }
  // rinnovi e incassato si attribuiscono alla persona del centro (join per nome)
  for (const c of contratti()) {
    if (!hasTag(c.stato, 'RINNOVO')) continue;
    const an = perNome.get(chiave(c.nome_centro));
    get((an && an[campo]) || NON_ASSEGNATO).rinnovi += 1;
  }
  for (const r of incassi()) {
    if (ymOf(r.data_incasso) !== MESE) continue;
    const an = perNome.get(chiave(r.centro));
    get((an && an[campo]) || (campo === 'consulente' && r.consulente) || NON_ASSEGNATO).incassato += (+r.importo || 0);
  }
  return [...m.values()].map(a => {
    // su cosa si misura la capienza di questo ruolo
    a.carico = R.base === 'attive' ? a.attive : (R.base === 'operativo' ? a.operativi : a.gestiti);
    a.capacita = a.persona_id === null ? null : capDi(ruolo, a.persona_id);
    a.saturazione = a.capacita > 0 ? a.carico / a.capacita * 100 : null;
    a.perCliente = a.gestiti > 0 ? a.incassato / a.gestiti : null;
    if (a.chiave === USCITI && a.usciti.size) {
      a.pm = USCITI + ' — ' + a.usciti.size + (a.usciti.size === 1 ? ' persona' : ' persone');
    }
    return a;
  });
}

// riempimento del ruolo = carico assegnato ÷ somma delle capienze delle persone
function riempimentoRuolo(ruolo) {
  const R = RUOLO(ruolo);
  const righe = caricoPerRuolo(ruolo);
  const persone = righe.filter(r => r.persona_id !== null && personaAttiva(r.persona_id)
                                    && (r.gestiti > 0 || capImpostata(ruolo, r.persona_id)));
  const posti = persone.reduce((a, r) => a + (r.capacita || 0), 0);
  const assegnati = persone.reduce((a, r) => a + r.carico, 0);
  const senza = righe.filter(r => r.persona_id === null).reduce((a, r) => a + r.carico, 0);
  return { ruolo, base: R.base, baseTxt: R.baseTxt, persone: persone.length, posti, assegnati, senza,
           quota: posti > 0 ? assegnati / posti : null };
}

const capCol = {
  key: 'capacita', label: 'Capienza (modificabile)',
  fmt: (v, r) => r.persona_id === null ? '—'
    : `<input type="number" class="cap-inp" min="0" max="1000" step="1" value="${v}"
        data-ruolo="${esc(r.ruolo)}" data-persona="${esc(r.persona_id)}"
        title="Quante ${esc(RUOLO(r.ruolo).baseTxt)} può seguire ${esc(r.pm)}">`,
};
const colsRuolo = ruolo => {
  const R = RUOLO(ruolo);
  const cols = [
    { key: 'pm', label: R.label, fmt: (v, r) => esc(v) + (
        r.chiave === USCITI
          ? ' <span class="badge-nota" title="Tolti dal team in Accessi → Team: i loro clienti restano contati qui">fuori dal team</span>'
          : (r.persona_id === null && v !== NON_ASSEGNATO
            ? ' <span class="badge-nota" title="Non è ancora in anagrafica: aggiungila in Accessi → Team">non in anagrafica</span>'
            : (r.ruoloOk === false
              ? ' <span class="badge-nota" title="Su Notion ha clienti in questo ruolo, ma in anagrafica il ruolo non ce l\'ha: o si aggiunge il ruolo in Team, o si cambia l\'assegnazione su Notion">ruolo non suo</span>' : ''))) },
    { key: 'gestiti', label: 'Clienti gestiti', fmt },
    { key: 'operativi', label: 'Portafoglio operativo', fmt },
    { key: 'attive', label: 'Con ADS attive', fmt },
    capCol,
    { key: 'saturazione', label: R.base === 'attive' ? 'Saturazione (su ADS attive)'
        : (R.base === 'operativo' ? 'Saturazione (su portafoglio operativo)' : 'Saturazione'),
      fmt: v => v === null ? '—'
        : `<span class="${v >= 95 ? 'val-bad' : (v >= 75 ? '' : 'val-good')}">${fmtPct(v)}</span>` },
    { key: 'onboarding', label: 'In onboarding', fmt },
    { key: 'attesaRinnovo', label: 'In attesa rinnovo', fmt },
    { key: 'rinnovi', label: 'Rinnovi firmati', fmt },
    { key: 'persi12m', label: 'Persi (12 mesi)', fmt },
  ];
  if (ruolo === 'PM') cols.push({ key: 'incassato', label: 'Incassato del mese', fmt: eur });
  return cols;
};

// salvataggio della capienza: upsert su fin_capacita e ridisegno
async function salvaCapacita(ruolo, persona_id, valore) {
  const n = Math.max(0, Math.min(1000, Math.round(+valore || 0)));
  const { error } = await supabase.from('fin_capacita')
    .upsert({ ruolo, persona_id, capacita: n, updated_at: new Date().toISOString() }, { onConflict: 'ruolo,persona_id' });
  if (error) { alert('Non sono riuscito a salvare la capienza: ' + error.message); return; }
  DATA.capacita = (DATA.capacita || []).filter(c => !(c.ruolo === ruolo && c.persona_id === persona_id))
    .concat([{ ruolo, persona_id, capacita: n }]);
  rebuildCap();
  renderDelivery();
}

// tasso di rinnovo e churn, mese per mese (ultimi 12)
// ⚠️ CHURN = coorte di FINE SERVIZIO: di quelli a cui il servizio finiva in quel
// mese, quanti oggi risultano persi. Numeratore e denominatore sono lo STESSO
// gruppo di clienti — non più "persi del mese ÷ portafoglio di oggi", che
// confrontava due insiemi diversi con un denominatore fisso per tutti i mesi.
// Il verdetto matura nel tempo: gli ultimi mesi hanno ancora molti "in sospeso"
// (il tag CLIENTE PERSO/SPARITO arriva mediamente 4 mesi dopo la fine servizio),
// quindi il churn dei mesi recenti è per forza più basso del definitivo.
function rinnoviChurn() {
  const months = [];
  for (let i = 11; i >= 0; i--) months.push(addYm(MESE, -i));
  const gestiti = centriRows().filter(isGestito).length;
  const out = months.map(m => {
    const rin = contratti().filter(c => hasTag(c.stato, 'RINNOVO') && ymOf(c.creazione_contratto) === m);
    const persi = centriRows().filter(c => ymOf(c.data_cliente_perso) === m).length;
    const val = rin.reduce((a, c) => a + (+c.valore || 0), 0);
    const cash = incassi().filter(r => ymOf(r.data_incasso) === m && hasTag(r.tipo_contratto, 'RINNOVO'))
      .reduce((a, r) => a + (+r.importo || 0), 0);
    const coorte = centriRows().filter(c => ymOf(c.fine_servizio) === m);
    const persiCoorte = coorte.filter(c => !isGestito(c)).length;
    return { mese: m, rinnovi: rin.length, persi, valore: val, cash,
             scaduti: coorte.length, persiCoorte,
             tasso: pct(rin.length, rin.length + persi),
             churn: pct(persiCoorte, coorte.length) };
  });
  return { months, righe: out, gestiti };
}

function renderDelivery() {
  const perRuoloRighe = {};
  let nascoste = 0;
  RUOLI_CAP.forEach(R => {
    const tutte = caricoPerRuolo(R.key);
    // il metro è lo stesso della colonna Saturazione: i clienti su cui si lavora
    // adesso. Una capienza a 0 non tiene in elenco: significa "non fa questo ruolo".
    const conCarico = r => r.carico > 0
      || (capImpostata(R.key, r.persona_id) && capDi(R.key, r.persona_id) > 0);
    nascoste += tutte.filter(r => !conCarico(r)).length;
    perRuoloRighe[R.key] = mostraSenzaCarico ? tutte : tutte.filter(conCarico);
  });
  const riemp = {};
  RUOLI_CAP.forEach(R => { riemp[R.key] = riempimentoRuolo(R.key); });
  const rc = rinnoviChurn();
  const cm = costiMese(MESE);
  const teamDel = cm.occ.filter(c => (c.reparto || '') === 'Delivery');
  const costoTeam = sumImporti(teamDel);
  const gestiti = rc.gestiti;
  // per PERSONA: due email dello stesso PM non sono due project manager
  const nPM = new Set(centriRows().filter(isGestito).map(x => x.consulente).filter(Boolean)
    .map(chiavePersona)).size;
  const perRuolo = RUOLI_DELIVERY.map(ru => ({
    ruolo: ru,
    voci: teamDel.filter(c => (c.ruolo || 'Altri ruoli') === ru).length,
    costo: sumImporti(teamDel.filter(c => (c.ruolo || 'Altri ruoli') === ru)),
  })).filter(x => x.voci > 0);
  const ultimi = rc.righe.slice(-12);
  const rinTot = ultimi.reduce((a, r) => a + r.rinnovi, 0);
  const persiTot = ultimi.reduce((a, r) => a + r.persi, 0);
  // ratio dai TOTALI del periodo, non media delle percentuali per riga: un mese
  // con 10 scadenze non deve pesare quanto uno con 49.
  const scadTot = ultimi.reduce((a, r) => a + r.scaduti, 0);
  const persiCoorteTot = ultimi.reduce((a, r) => a + r.persiCoorte, 0);
  const churn12 = pct(persiCoorteTot, scadTot);
  // I due KPI in cima guardano solo gli ULTIMI 4 MESI: su 12 pesano ancora
  // stagioni vecchie e il numero si muove con mesi di ritardo. La tabella qui
  // sotto resta a 12 mesi con il suo totale, per il confronto storico.
  const MESI_KPI = 4;
  const recenti = ultimi.slice(-MESI_KPI);
  const rinRec = recenti.reduce((a, r) => a + r.rinnovi, 0);
  const persiRec = recenti.reduce((a, r) => a + r.persi, 0);
  const scadRec = recenti.reduce((a, r) => a + r.scaduti, 0);
  const persiCoorteRec = recenti.reduce((a, r) => a + r.persiCoorte, 0);
  const churn4 = pct(persiCoorteRec, scadRec);

  _mount.querySelector('#fnContent').innerHTML = `
    <div class="kpi-row" id="fnDelKpi"></div>

    <div class="sm-head">
      <div>
        <h2 class="sm-title">Carico del team</h2>
        <div class="sm-sub">Chi non ha nessun cliente su cui lavorare adesso, e nessuna capienza
          impostata, resta fuori dagli elenchi: quasi sempre sono assegnazioni rimaste su clienti persi
          o parcheggiati. Se gli riassegni qualcuno torna da solo.</div>
      </div>
      <label class="tm-toggle"><input type="checkbox" id="fnMostraTutti"${mostraSenzaCarico ? ' checked' : ''}>
        Mostra tutti${nascoste ? ' (' + nascoste + ' fuori elenco)' : ''}</label>
    </div>

    ${RUOLI_CAP.map(R => `
    <div class="card">
      <h2>Carico per ${R.plur}</h2>
      <div class="subtitle">La <strong>capienza la imposti tu</strong> nella colonna a fianco: si salva da sola e vale
        anche per il riempimento team in Dashboard. Finché non la tocchi vale ${R.def}.
        La saturazione è calcolata sui <strong>${R.baseTxt}</strong>${R.base === 'attive'
          ? ' (stato ADS ATTIVE su Notion), non su tutti i clienti seguiti'
          : (R.base === 'operativo'
            ? ` — ${STATI_OPERATIVI.join(', ')} — cioè i clienti su cui si lavora adesso: restano fuori
                spostati a estetista indipendente, riparte a settembre, standby e quelli senza stato`
            : ' (tutti gli stati tranne CLIENTE PERSO/SPARITO)')}.
        ${R.key === 'PM' ? 'Rinnovi e incassato sono attribuiti al PM del centro (join per nome del centro).'
          : 'Rinnovi attribuiti alla persona assegnata al centro.'}
        ${riemp[R.key].senza > 0 ? `<strong>${fmt(riemp[R.key].senza)} ${R.baseTxt} non hanno un ${R.plur} assegnato</strong> su Notion.` : ''}</div>
      <div class="table-scroll"><table id="fnRuolo${R.key}"></table></div>
    </div>`).join('')}

    <div class="card">
      <h2>Costo del team delivery — ${ymLabel(MESE)}</h2>
      <div class="subtitle">Dalle voci del registro costi con reparto Delivery. Modificale nella tab Costi.</div>
      <div class="table-scroll"><table id="fnRuoli"></table></div>
    </div>

    <div class="card">
      <h2>Rinnovi e churn, mese per mese</h2>
      <div class="subtitle"><strong>Churn</strong> = dei clienti a cui il servizio finiva in quel mese
        ("in scadenza"), quanti oggi risultano persi. Stesso gruppo di clienti sopra e sotto la riga di frazione.
        ⚠️ Il verdetto matura: un cliente viene segnato perso in media <strong>4 mesi dopo</strong> la fine
        servizio, quindi gli ultimi mesi sono ancora in sospeso e il loro churn salirà.
        <strong>Tasso di rinnovo</strong> = rinnovi firmati ÷ (rinnovi + clienti persi) nel mese, per data del
        contratto e per DATA CLIENTE PERSO: è un altro conto, non il complemento del churn.</div>
      <div class="table-scroll"><table class="fn-pnl">
        <thead><tr><th>Mese</th><th>Rinnovi</th><th>Clienti persi</th><th>Tasso di rinnovo</th><th>In scadenza</th><th>Persi a scadenza</th><th>Churn</th><th>Valore rinnovi</th><th>Incassato su rinnovi</th></tr></thead>
        <tbody>
          ${ultimi.map(r => `<tr>
            <td class="name">${ymLabel(r.mese)}</td>
            <td>${fmt(r.rinnovi)}</td>
            <td>${fmt(r.persi)}</td>
            <td>${r.tasso === null ? '—' : `<span class="${r.tasso >= 30 ? 'val-good' : 'val-bad'}">${fmtPct(r.tasso)}</span>`}</td>
            <td>${fmt(r.scaduti)}</td>
            <td>${fmt(r.persiCoorte)}</td>
            <td>${r.churn === null ? '—' : `<span class="${r.churn >= 50 ? 'val-bad' : ''}">${fmtPct(r.churn)}</span>`}</td>
            <td>${eur(r.valore)}</td>
            <td>${eur(r.cash)}</td></tr>`).join('')}
          <tr class="fn-tot"><td class="name">Totale 12 mesi</td>
            <td>${fmt(rinTot)}</td><td>${fmt(persiTot)}</td>
            <td>${fmtPct(pct(rinTot, rinTot + persiTot))}</td>
            <td>${fmt(scadTot)}</td>
            <td>${fmt(persiCoorteTot)}</td>
            <td>${fmtPct(churn12)}</td>
            <td>${eur(ultimi.reduce((a, r) => a + r.valore, 0))}</td>
            <td>${eur(ultimi.reduce((a, r) => a + r.cash, 0))}</td></tr>
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>Classifica per rinnovi</h2>
      <div class="subtitle">Contratti di rinnovo attribuiti al project manager e alla beauty specialist del centro,
        su tutto lo storico disponibile.</div>
      <div class="fn-rank" id="fnRank"></div>
    </div>`;

  renderKpiRow(_mount.querySelector('#fnDelKpi'), [
    { label: 'Clienti in gestione', value: fmt(gestiti), sub: nPM + ' project manager attivi' },
    { label: 'Media per PM', value: fmt1(safeDiv(gestiti, nPM)),
      sub: 'posti PM impostati: ' + fmt(riemp.PM.posti) },
    { label: 'Costo team delivery', value: eur(costoTeam), sub: teamDel.length + ' persone/voci nel mese' },
    { label: 'Costo per cliente', value: eur(safeDiv(costoTeam, gestiti)), sub: 'solo team delivery' },
    { label: 'Tasso di rinnovo 4 mesi', value: fmtPct(pct(rinRec, rinRec + persiRec)),
      sub: rinRec + ' rinnovi su ' + (rinRec + persiRec) + ' esiti' },
    // ⚠️ sui 4 mesi il churn è per forza sottostimato: il tag "cliente perso"
    // arriva in media 4 mesi dopo la fine servizio. Il sub lo dice, altrimenti
    // un churn basso qui sopra si legge come un miglioramento che non c'è.
    { label: 'Churn 4 mesi', value: fmtPct(churn4),
      sub: persiCoorteRec + ' persi su ' + fmt(scadRec) + ' scadenze · ancora in maturazione'
        + (churn12 === null ? '' : ', su 12 mesi è ' + fmtPct(churn12)) },
  ]);

  RUOLI_CAP.forEach(R => {
    const el = _mount.querySelector('#fnRuolo' + R.key);
    if (!el) return;
    const righe = perRuoloRighe[R.key];
    if (!righe.length) { el.innerHTML = '<div class="status">Nessun ' + R.plur + ' assegnato sui centri.</div>'; return; }
    renderTable(el, colsRuolo(R.key), righe, ruoloSort[R.key],
      k => {
        const s = ruoloSort[R.key];
        ruoloSort[R.key] = { key: k, dir: s.key === k ? -s.dir : -1 };
        renderDelivery();
      },
      { barKey: 'gestiti' });
  });

  // le capienze si salvano appena esci dal campo (o premi Invio)
  const tutti = _mount.querySelector('#fnMostraTutti');
  if (tutti) tutti.onchange = () => { mostraSenzaCarico = tutti.checked; renderDelivery(); };

  _mount.querySelectorAll('input.cap-inp').forEach(inp => {
    inp.onchange = () => salvaCapacita(inp.dataset.ruolo, inp.dataset.persona, inp.value);
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } };
    inp.onclick = e => e.stopPropagation();     // non far partire l'ordinamento della riga
  });

  const elR = _mount.querySelector('#fnRuoli');
  if (!perRuolo.length) elR.innerHTML = '<div class="status">Nessuna voce Delivery nel registro costi.</div>';
  else renderTable(elR, [
    { key: 'ruolo', label: 'Ruolo' },
    { key: 'voci', label: 'Persone / voci', fmt },
    { key: 'costo', label: 'Costo del mese', fmt: eur },
    { key: 'quota', label: 'Quota', fmt: v => fmtPct(v) },
  ], perRuolo.map(x => ({ ...x, quota: pct(x.costo, costoTeam) })), { key: 'costo', dir: -1 }, () => {},
    { barKey: 'costo' });

  // classifica PM e beauty specialist per numero di rinnovi
  const perNome = centriByNome();
  const conta = campo => {
    const m = new Map();
    for (const c of contratti()) {
      if (!hasTag(c.stato, 'RINNOVO')) continue;
      const an = perNome.get(chiave(c.nome_centro));
      const raw = (an && an[campo]) || null;
      const k = raw ? chiavePersona(raw) : '(non assegnato)';
      const cur = m.get(k) || { nome: raw ? nomeDi(raw) : '(non assegnato)', n: 0 };
      cur.n += 1;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 10);
  };
  const lista = (titolo, rows) => {
    const max = Math.max(...rows.map(r => r.n), 1);
    return `<div class="fn-rank-card"><h3>${titolo}</h3>${rows.length ? rows.map(r => `
      <div class="esito-row">
        <div class="esito-top"><span class="lbl">${esc(r.nome)}</span><span class="val"><b>${fmt(r.n)}</b></span></div>
        <div class="esito-track"><div class="esito-fill" style="width:${Math.max(3, Math.round(100 * r.n / max))}%;background:var(--series-2)"></div></div>
      </div>`).join('') : '<div class="status">Nessun rinnovo.</div>'}</div>`;
  };
  _mount.querySelector('#fnRank').innerHTML =
    lista('Project manager', conta('consulente')) + lista('Beauty specialist', conta('beauty'));
}

// ── tab Clienti & LTV ────────────────────────────────────────────────────────
function ltvRows() {
  const perNome = centriByNome();
  const m = new Map();
  for (const r of incassi()) {
    if (!incassata(r)) continue;
    const k = r.centro || '(senza centro)';
    let a = m.get(k);
    if (!a) {
      const an = perNome.get(chiave(k));
      a = { centro: k, incassato: 0, nRate: 0, primo: null, ultimo: null,
            consulente: (an && an.consulente) || r.consulente || null,
            inizio: an ? an.inizio_servizio : null,
            fine: an ? an.fine_servizio : null,
            perso: an ? !!an.data_cliente_perso : false };
      m.set(k, a);
    }
    a.incassato += (+r.importo || 0);
    a.nRate += 1;
    const d = r.data_incasso;
    if (d && (!a.primo || d < a.primo)) a.primo = d;
    if (d && (!a.ultimo || d > a.ultimo)) a.ultimo = d;
  }
  const oggi = dstr(todayRome());
  return [...m.values()].map(a => {
    const da = a.inizio || a.primo;
    const al = a.fine && a.fine < oggi ? a.fine : (a.perso && a.ultimo ? a.ultimo : oggi);
    a.mesi = da ? Math.max(1, (mesiTra(da, al) || 0) + 1) : null;
    a.perMese = a.mesi ? a.incassato / a.mesi : null;
    a.stato = a.perso ? 'perso' : 'attivo';
    return a;
  });
}

function renderClienti() {
  const righe = ltvRows();
  const totIncassato = righe.reduce((a, r) => a + r.incassato, 0);
  const ltv = righe.length ? totIncassato / righe.length : null;
  const conMesi = righe.filter(r => r.mesi);
  const durata = conMesi.length ? conMesi.reduce((a, r) => a + r.mesi, 0) / conMesi.length : null;
  const rinnoviTot = contratti().filter(c => hasTag(c.stato, 'RINNOVO')).length;
  const persiTot = centriRows().filter(c => c.data_cliente_perso).length;
  const retention = pct(rinnoviTot, rinnoviTot + persiTot);
  const attivi = righe.filter(r => r.stato === 'attivo').length;

  // andamento per mese: nuovi, rinnovi, contrattualizzato, incassato (12 mesi)
  const months = [];
  for (let i = 11; i >= 0; i--) months.push(addYm(MESE, -i));
  const perMese = months.map(m => {
    const c = contrattualizzato(m);
    const inc = incassi().filter(r => ymOf(r.data_incasso) === m).reduce((a, r) => a + (+r.importo || 0), 0);
    const persi = centriRows().filter(x => ymOf(x.data_cliente_perso) === m).length;
    return { mese: m, nuovi: c.nuovi, rinnovi: c.rinnovi, contr: c.tot, inc, persi };
  });

  _mount.querySelector('#fnContent').innerHTML = `
    <div class="kpi-row" id="fnLtvKpi"></div>

    <div class="card">
      <h2>Andamento per mese</h2>
      <div class="subtitle">Ultimi 12 mesi: contratti nuovi e di rinnovo creati, valore contrattualizzato,
        incassato effettivo e clienti persi.</div>
      <div class="table-scroll"><table class="fn-pnl">
        <thead><tr><th>Mese</th><th>Nuovi clienti</th><th>Rinnovi</th><th>Clienti persi</th><th>Contrattualizzato</th><th>Incassato</th></tr></thead>
        <tbody>${perMese.map(r => `<tr>
          <td class="name">${ymLabel(r.mese)}</td>
          <td>${fmt(r.nuovi)}</td><td>${fmt(r.rinnovi)}</td>
          <td>${r.persi > 0 ? `<span class="val-bad">${fmt(r.persi)}</span>` : '0'}</td>
          <td>${eur(r.contr)}</td><td>${eur(r.inc)}</td></tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;

  renderKpiRow(_mount.querySelector('#fnLtvKpi'), [
    { label: 'LTV medio', value: eur(ltv), sub: 'incassato storico ÷ clienti paganti' },
    { label: 'Clienti paganti', value: fmt(righe.length), sub: attivi + ' ancora attivi' },
    { label: 'Incassato storico', value: eur(totIncassato), sub: 'tutte le rate incassate' },
    { label: 'Durata media', value: durata === null ? '—' : fmt1(durata) + ' mesi', sub: 'dal primo giorno di servizio' },
    { label: 'Retention', value: fmtPct(retention), sub: rinnoviTot + ' rinnovi su ' + (rinnoviTot + persiTot) + ' esiti storici' },
    { label: 'Incassato medio / mese cliente', value: eur(safeDiv(totIncassato, conMesi.reduce((a, r) => a + r.mesi, 0))),
      sub: 'quanto rende un cliente ogni mese' },
  ]);
}

// ── tab Report (export) ──────────────────────────────────────────────────────
// CSV per Excel italiano: separatore ';', virgola decimale, BOM UTF-8.
const csvNum = n => (n === null || n === undefined || n === '') ? '' : String(n).replace('.', ',');
function csvTesto(righe) {
  return righe.map(r => r.map(v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\n');
}
function scarica(nome, testo) {
  const blob = new Blob(['﻿' + testo], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  URL.revokeObjectURL(a.href);
}

const EXPORT = {
  incassiMese: () => ({
    nome: 'incassi_' + MESE + '.csv',
    righe: [['ID incasso', 'Centro', 'Consulente', 'Venditore', 'Data incasso', 'Scadenza', 'Importo', 'Rata n°', 'Metodo', 'Tipo contratto', 'Comm. venditore', 'Comm. setter']]
      .concat(incassi().filter(r => ymOf(r.data_incasso) === MESE).map(r => [
        r.id_incasso, r.centro, nomeDi(r.consulente), nomeDi(r.venditore), r.data_incasso, r.data_scadenza,
        csvNum(r.importo), csvNum(r.rata_numero), r.metodo, (r.tipo_contratto || []).join(' · '),
        csvNum(r.comm_venditore), csvNum(r.comm_setter)])),
  }),
  incassiTutti: () => ({
    nome: 'incassi_tutti.csv',
    righe: [['ID incasso', 'Centro', 'Consulente', 'Data incasso', 'Scadenza', 'Importo', 'Rata n°', 'Incassata', 'Metodo', 'Tipo contratto']]
      .concat(incassi().map(r => [
        r.id_incasso, r.centro, nomeDi(r.consulente), r.data_incasso, r.data_scadenza,
        csvNum(r.importo), csvNum(r.rata_numero), incassata(r) ? 'sì' : 'no', r.metodo,
        (r.tipo_contratto || []).join(' · ')])),
  }),
  insolute: () => ({
    nome: 'rate_insolute_' + MESE + '.csv',
    righe: [['Centro', 'Scadenza', 'Giorni di ritardo', 'Importo', 'Rata n°', 'Consulente', 'Venditore']]
      .concat(insolute(MESE).righe.map(r => [
        r.centro, r.data_scadenza, giorniRitardo(r.data_scadenza), csvNum(r.importo),
        csvNum(r.rata_numero), nomeDi(r.consulente), nomeDi(r.venditore)])),
  }),
  contratti: () => ({
    nome: 'contratti.csv',
    righe: [['Centro', 'ID contratto', 'Creazione', 'Valore', 'Stato', 'Durata', 'Venditore', 'Agenzia']]
      .concat(contratti().map(c => [
        c.nome_centro, c.id_contratto, c.creazione_contratto, csvNum(c.valore),
        (c.stato || []).join(' · '), (c.durata || []).join(' · '), c.venditore, (c.agenzia || []).join(' · ')])),
  }),
  costi: () => ({
    nome: 'costi.csv',
    righe: [['Descrizione', 'Reparto', 'Ruolo', 'Sottocategoria', 'Categoria P&L', 'Importo', 'Data', 'Fine', 'Frequenza', 'Attiva', 'Note']]
      .concat(costi().map(c => [
        c.descrizione, c.reparto, c.ruolo, c.sottocategoria, c.categoria, csvNum(c.importo),
        c.data, c.fine, c.frequenza, c.attivo ? 'sì' : 'no', c.note])),
  }),
  pnl12: () => {
    const ms = [];
    for (let i = 11; i >= 0; i--) ms.push(pnl(addYm(MESE, -i)));
    const riga = (label, get) => [label].concat(ms.map(d => csvNum(Math.round(get(d) * 100) / 100)));
    return {
      nome: 'pnl_12_mesi_al_' + MESE + '.csv',
      righe: [['Voce'].concat(ms.map(d => d.m)),
        ['Fonte'].concat(ms.map(d => d.fonte === 'foglio' ? 'foglio P&L' : 'Notion + registro costi')),
        riga('Cash incassato', d => d.lordi),
        // le "di cui" restano sempre lo spacchettamento Notion: sul foglio ci sono
        // solo su alcuni mesi e con un taglio diverso (prime rate / rate vecchie)
        riga('di cui prime rate (nuovi clienti) — Notion', d => d.s.nuovi),
        riga('di cui rate — Notion', d => d.s.rate),
        riga('di cui rinnovi — Notion', d => d.s.rinnovi),
        riga('di cui upsell — Notion', d => d.s.upsell),
        riga('Rimborsi', d => d.rimborsi),
        riga('Ricavi netti', d => d.ricaviNetti),
        riga('Costi diretti', d => d.costiDiretti),
        riga('Margine lordo', d => d.margineLordo),
        riga('Costi operativi', d => d.operativi),
        riga('Margine operativo', d => d.margineOp),
        riga('Costi strutturali', d => d.strutturali),
        riga('EBITDA (margine netto)', d => d.ebitda),
        riga('Investimenti e asset', d => d.capex),
        riga('Cash flow', d => d.cashFlow),
        riga('Costi totali', d => d.costiTot),
        riga('Contrattualizzato', d => d.contrattualizzato)],
    };
  },
};

function renderReport() {
  const voci = [
    ['incassiMese', 'Incassi del mese', 'Tutte le rate con data incasso in ' + ymLabel(MESE) + ', con commissioni.'],
    ['incassiTutti', 'Incassi — storico completo', 'Ogni rata del database, incassata e non.'],
    ['insolute', 'Rate scadute e non incassate', 'La lista di recupero, con i giorni di ritardo.'],
    ['contratti', 'Contratti', 'Valore, stato, durata e venditore di ogni contratto.'],
    ['costi', 'Registro costi', 'Tutte le voci, incluse quelle disattivate.'],
    ['pnl12', 'P&L — 12 mesi', 'Il conto economico mese per mese, pronto per Excel.'],
  ];
  _mount.querySelector('#fnContent').innerHTML = `
    <div class="card">
      <h2>Esportazioni</h2>
      <div class="subtitle">File CSV pronti per Excel (separatore <code>;</code>, virgola decimale).
        Rispettano il mese e l'agenzia selezionati in alto.</div>
      <div class="fn-export">
        ${voci.map(([k, t, s]) => `
          <div class="fn-export-row">
            <div><b>${t}</b><div class="subtitle" style="margin:2px 0 0">${s}</div></div>
            <button class="tk-btn tk-btn-pri" data-exp="${k}">Scarica CSV</button>
          </div>`).join('')}
      </div>
    </div>

    <div class="card">
      <h2>Come sono calcolati i numeri</h2>
      <div class="subtitle">Le definizioni che contano, per non doverle ricostruire ogni volta.</div>
      <ul class="fn-note">
        <li><b>Incassato</b>: somma di IMPORTO RATA delle righe con DATA INCASSO nel mese (Notion DATABASE INCASSI).
          Una rata conta come incassata se ha la data di incasso o la spunta PAGATO.</li>
        <li><b>Contrattualizzato</b>: somma di VALORE CONTRATTO dei contratti creati nel mese
          (Notion DATABASE CONTRATTI), per data di creazione. Una riga = un contratto.</li>
        <li><b>Nuovi clienti — 1ª rata pagata</b>: rate con RATA NUMERO 1 incassate nel mese
          (su Notion la riga ha NUMERO RATA INCASSATA = 1), <b>escluse quelle di rinnovi e upsell</b>.
          Conta quando il cliente <i>parte</i>, non quando firma: se firma a giugno e paga a luglio, sta in luglio.
          Attenzione: filtrando su Notion per DATA INCASSO + rata 1 il totale è più alto, perché lì dentro
          ci sono anche le prime rate dei rinnovi e degli upsell, che qui hanno la loro tile.
          Le <b>rate</b> sono le successive alla prima, sempre al netto di rinnovi e upsell: così le quattro
          voci del gruppo sommano esattamente all'incassato del mese.</li>
        <li><b>Insolute (&gt;7gg)</b>: due letture diverse. La <b>tile</b> guarda solo le rate con DATA SCADENZA
          <i>in quel mese</i>: quanto è scaduto e quanto di quello non è ancora entrato. L'<b>arretrato</b> nel suo
          sottotitolo — e l'export "Rate scadute e non incassate" qui sotto — è invece cumulativo, dall'inizio
          a oggi. In entrambi una rata conta come scaduta solo dopo 7 giorni (tolleranza per bonifici e addebiti in viaggio) e lo stato pagato/non
          pagato è sempre quello di <i>oggi</i>: scegliendo un mese passato non si ricostruisce la fotografia di allora.</li>
        <li><b>Rate senza DATA SCADENZA</b>: quando su Notion la scadenza è vuota vale la <b>data di incasso</b>.
          Sono quasi sempre prime rate e acconti pagati alla firma, dove la scadenza non viene compilata perché
          il soldo è già in cassa: senza questo ripiego finivano nell'incassato ma non nello scaduto, e il
          <i>% insoluto</i> del mese risultava più alto del vero. Le righe che non hanno <i>né</i> scadenza <i>né</i>
          incasso restano invece fuori da tutti i conti di scaduto e insoluto: non c'è una data da cui partire.</li>
        <li><b>Commissioni</b>: formule di Notion sulla singola rata (venditore 10%, setter 5%, PM/MB/BS sui rinnovi),
          sommate sugli incassi del mese. Non sono stime.</li>
        <li><b>Costi</b>: registro interno (tab Costi). Una voce mensile conta da <i>data inizio</i> in poi,
          una annua nello stesso mese di ogni anno, una tantum solo nel suo mese.</li>
        <li><b>P&amp;L — quale fonte</b>: per i mesi che stanno sul foglio <b>"PL Database Input"</b> il conto
          economico è quello <b>dichiarato lì</b> (aprile → luglio 2026), voce per voce: è il dato ufficiale, e
          anche EBITDA, margine netto, costi del mese e grafico 12 mesi in Dashboard leggono da lì.
          Per gli altri mesi vale il <b>calcolo</b>: incassi Notion − registro costi. La differenza non è cosmetica —
          il registro costi fotografa lo <i>stato di oggi</i> (voci mensili tutte dal 1° gennaio 2026) e non conosce
          l'ad spend Meta, la parte fissa dei setter, i compensi amministratori né i costi straordinari, quindi sui
          mesi chiusi darebbe un margine gonfiato. Nel tab P&amp;L i chip permettono di vedere l'altra versione e
          c'è la tabella di riconciliazione fra le due.</li>
        <li><b>EBITDA</b>: dal foglio è la riga MARGINE NETTO (ricavi netti − diretti − operativi − strutturali);
          calcolato è ricavi netti − costi correnti − commissioni, <b>esclusi</b> investimenti e asset.
          <b>Cash flow / margine netto</b>: EBITDA meno gli investimenti — sul foglio non c'è una riga
          investimenti, quindi coincidono.</li>
        <li><b>Clienti persi</b>: DATA CLIENTE PERSO su Notion DATABASE CLIENTI, nel mese.</li>
        <li><b>Riempimento team</b>: carico assegnato ÷ somma delle <b>capienze che imposti tu</b> nella tab Delivery,
          una per persona. Il carico cambia col ruolo: per <b>project manager</b> e <b>media buyer</b> è il
          <b>portafoglio operativo</b> (ADS ATTIVE, ADS DA LANCIARE, ONBOARDING, IN ATTESA DI RINNOVO, OPEN DAY,
          GESTIONE SOCIAL — default 35 a testa); per le <b>beauty specialist</b> sono le sole aziende con
          <b>ADS ATTIVE</b> (default 12). Restano fuori dal carico i clienti parcheggiati — spostati a estetista
          indipendente, riparte a settembre, standby, senza stato — che invece sono dentro "clienti gestiti".
          Al numeratore contano solo i clienti con quella persona assegnata su Notion: quelli senza sono
          dichiarati a parte nel sottotitolo della tile.
          La tile grande <b>Riempimento team</b> è il totale dei tre reparti — posti occupati ÷ posti disponibili —
          quindi pesa i reparti per quante persone hanno; la media semplice delle tre percentuali è nel sottotitolo.</li>
        <li><b>Confronto col mese prima</b>: se il mese è in corso, il precedente viene tagliato allo stesso giorno,
          altrimenti il confronto sarebbe sempre in perdita.</li>
      </ul>
    </div>`;

  _mount.querySelectorAll('button[data-exp]').forEach(b => b.onclick = () => {
    const { nome, righe } = EXPORT[b.dataset.exp]();
    scarica(nome, csvTesto(righe));
  });
}

// ── barra mese + agenzia + tab ───────────────────────────────────────────────
function renderBar() {
  const mi = _mount.querySelector('#fnMese');
  if (mi) mi.value = MESE;
  const chips = _mount.querySelector('#fnAgChips');
  const ags = agenzie();
  const wrap = _mount.querySelector('#fnAgWrap');
  if (wrap) wrap.classList.toggle('hidden', ags.length < 2);
  if (chips && ags.length >= 2) {
    chips.innerHTML = ['', ...ags].map(a =>
      `<button data-ag="${esc(a)}" class="${AGENZIA === a ? 'active' : ''}">${a === '' ? 'Tutte' : esc(a)}</button>`).join('');
    chips.querySelectorAll('button').forEach(b => b.onclick = () => { AGENZIA = b.dataset.ag; renderAll(); });
  }
  _mount.querySelectorAll('#fnTabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === TAB));
}

const RENDER_TAB = {
  dash: renderDash, costi: renderCostiPage, pnl: renderPnl, marketing: renderMarketing,
  delivery: renderDelivery, clienti: renderClienti, report: renderReport,
};

function renderAll() {
  renderBar();
  (RENDER_TAB[TAB] || renderDash)();
  _mount.scrollTop = 0;
}

// ── ciclo di rendering ───────────────────────────────────────────────────────
async function load() {
  const myId = _renderId;
  const status = _mount.querySelector('#fnStatus');
  const content = _mount.querySelector('#fnContent');
  status.classList.remove('hidden');
  content.classList.add('hidden');
  status.textContent = 'Caricamento dati…';
  try {
    const data = await buildData();
    if (myId !== _renderId || !_mount.querySelector('#fnContent')) return;
    DATA = data;
    rebuildCap();
    if (!data.incassi.length && !data.contratti.length) {
      status.textContent = 'Nessun dato disponibile (il sync gira ogni ora al minuto 50).';
      return;
    }
    renderAll();
    status.classList.add('hidden');
    content.classList.remove('hidden');
  } catch (e) {
    if (myId !== _renderId || !_mount.querySelector('#fnStatus')) return;
    status.textContent = 'Errore nel caricamento: ' + e.message;
    throw e;
  }
}

export async function render(mount, params) {
  _mount = mount;
  _renderId++;
  const t = params && params.get ? params.get('tab') : null;
  TAB = RENDER_TAB[t] ? t : 'dash';
  mount.innerHTML = `
    <div class="filters" style="margin-bottom:8px">
      <span class="filter-cap">Mese</span>
      <button id="fnPrev" title="Mese precedente">‹</button>
      <input type="month" id="fnMese">
      <button id="fnNext" title="Mese successivo">›</button>
      <span id="fnAgWrap" class="hidden"><span class="filter-cap">Agenzia</span><span id="fnAgChips"></span></span>
    </div>
    <div class="lead-tabs" id="fnTabs" style="margin-bottom:12px">
      ${TABS.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}
    </div>
    <div id="fnStatus" class="status loading">Caricamento dati…</div>
    <div id="fnContent" class="hidden"></div>
    <div id="fnModal" class="modal-overlay hidden"></div>`;

  mount.querySelector('#fnPrev').onclick = () => { MESE = addYm(MESE, -1); if (DATA) renderAll(); };
  mount.querySelector('#fnNext').onclick = () => { MESE = addYm(MESE, 1); if (DATA) renderAll(); };
  mount.querySelector('#fnMese').onchange = e => { if (e.target.value) { MESE = e.target.value; if (DATA) renderAll(); } };
  mount.querySelectorAll('#fnTabs button').forEach(b => b.onclick = () => {
    TAB = b.dataset.tab;
    // il tab resta nell'URL (refresh e link diretti), senza rifare la history
    history.replaceState(null, '', '#/sauron' + (TAB === 'dash' ? '' : '?tab=' + TAB));
    if (DATA) renderAll();
  });

  await load();
}

export function onResize() {
  if (!DATA || !_mount) return;
  if (_mount.querySelector('#fnTrend')) renderTrend();
  if (_mount.querySelector('#mkTrend')) renderMktTrend();
}
