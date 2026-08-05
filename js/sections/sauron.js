// manager-stats · Sezione Sauron (ex Finance, solo admin) — porting del prototipo CFO Cockpit
//
// Fonti: fin_incassi (1 riga = 1 rata, da Notion 🏦 DATABASE INCASSI),
// v_notion_contratti (mirror del DATABASE CONTRATTI: 1 riga = 1 contratto vero),
// fin_costi (voci di costo, EDITABILI qui), centri (anagrafica clienti:
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
// · Commissioni (auto)  = formule commissione Notion sugli incassi del mese
//                         (venditore 10% · setter 5% · PM/MB/BS sui rinnovi)
// · Ricorrenza costi    = mensile (da `data` in poi, fino a `fine`), annua
//                         (stesso mese dell'anno), una tantum (solo quel mese)
// · EBITDA              = ricavi netti − costi correnti − commissioni, ESCLUSI
//                         investimenti e asset · Cash flow = EBITDA − capex
import { supabase } from '../supabase.js';
import { fetchAll } from '../data.js';
import { renderTable, renderKpiGroups, renderKpiRow } from '../tables.js';
import { renderLineChart } from '../charts.js';
import { fmt, fmt1, eur, eur2, pct, fmtPct, pctFrac, ratio, safeDiv, dstr, todayRome, esc } from '../format.js';

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
// tab Marketing: quale fonte mostrare. null = automatico (mesi chiusi dal foglio
// ufficiale, mese in corso dal vivo); 'foglio'/'live' = scelta esplicita dai chip.
let MKT_VISTA = null;
let centroSort = { key: 'incassato', dir: -1 };
let contrattiSort = { key: 'valore', dir: -1 };
let insSort = { key: 'data_scadenza', dir: 1 };
let ruoloSort = { PM: { key: 'gestiti', dir: -1 }, BEAUTY: { key: 'gestiti', dir: -1 }, MEDIA_BUYER: { key: 'gestiti', dir: -1 } };
let ltvSort = { key: 'incassato', dir: -1 };
const costiSort = {};                        // per reparto

// ── caricamento ──────────────────────────────────────────────────────────────
async function buildData() {
  const [incassi, contratti, centri, costi, capacita, marketing, vendita, funnel] = await Promise.all([
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
    // tracker ufficiale del foglio KPI ALL 3 (lo scrive n8n) e KPI vendita a mano
    supabase.from('fin_marketing').select('*').then(r => r.data || []).catch(() => []),
    supabase.from('fin_vendita').select('*').then(r => r.data || []).catch(() => []),
    // funnel mensile dal vivo (opportunita' GHL + chiamate setter)
    supabase.rpc('api_fin_marketing_mesi').then(r => r.data || []).catch(() => []),
  ]);
  // dal mirror il venditore arriva come array e il valore come numeric (stringa via
  // PostgREST): qui li riporto alle forme che il resto della sezione si aspetta.
  const contrattiNorm = contratti.map(c => ({
    ...c,
    valore: (c.valore === null || c.valore === undefined) ? null : Number(c.valore),
    venditore: Array.isArray(c.venditore) ? c.venditore.join(', ') : c.venditore,
  }));
  return { incassi, contratti: contrattiNorm, centri, costi, capacita, marketing, vendita, funnel };
}

async function ricaricaCosti() {
  DATA.costi = await fetchAll((lo, hi) => supabase.from('fin_costi').select('*').range(lo, hi));
}

async function ricaricaVendita() {
  const { data } = await supabase.from('fin_vendita').select('*');
  DATA.vendita = data || [];
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
  const t = { scadute: 0, nonIncassate: 0, nScadute: 0, nNonIncassate: 0, righe: [] };
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

// conto economico per cassa del mese
function pnl(m) {
  const s = splitIncassato(m);
  const cm = costiMese(m);
  const ricaviNetti = s.tot - cm.rimborsi;
  const costiDiretti = cm.comm.tot + cm.cat.Diretti;
  const margineLordo = ricaviNetti - costiDiretti;
  const margineOp = margineLordo - cm.cat.Operativi;
  const ebitda = margineOp - cm.cat.Strutturali;
  const cashFlow = ebitda - cm.capex;
  return {
    m, s, cm, lordi: s.tot, rimborsi: cm.rimborsi, ricaviNetti, costiDiretti, margineLordo,
    margineOp, ebitda, cashFlow, contrattualizzato: contrattualizzato(m).tot,
    pctLordo: ricaviNetti > 0 ? margineLordo / ricaviNetti : null,
    pctOp: ricaviNetti > 0 ? margineOp / ricaviNetti : null,
    pctEbitda: ricaviNetti > 0 ? ebitda / ricaviNetti : null,
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
      sub: x.posti === 0
        ? 'nessuna capienza impostata: falla nella tab Delivery'
        : fmt(x.assegnati) + ' ' + x.baseTxt + ' ÷ ' + fmt(x.posti) + ' posti (' + x.persone + ' persone)'
          + (x.senza > 0 ? ' · ' + fmt(x.senza) + ' senza ' + R.plur : '') };
  };

  const p = pnl(MESE);
  const cm = p.cm;
  const roi = cm.tot > 0 ? p.cashFlow / cm.tot : null;

  renderKpiGroups(_mount.querySelector('#fnKpi'), [
    { step: 1, title: 'Incassato', tiles: [
      { label: 'Incassato del mese', value: eur(s.tot), hero: true, sub: delta(s.tot, sPrev.tot) || (fmt(s.n) + ' rate incassate') },
      { label: 'Nuovi clienti — 1ª rata pagata', value: eur(s.nuovi),
        sub: fmt(s.nuoviIds.size) + (s.nuoviIds.size === 1 ? ' cliente partito' : ' clienti partiti') + ' nel mese · esclusi rinnovi e upsell' },
      { label: 'Rate', value: eur(s.rate), sub: 'rate successive di clienti attivi' },
      { label: 'Rinnovi', value: eur(s.rinnovi), sub: 'tag RINNOVO sul contratto' },
      { label: 'Upsell', value: eur(s.upsell) },
    ] },
    { step: 2, title: 'Contrattualizzato', tiles: [
      { label: 'Contrattualizzato del mese', value: eur(c.tot), hero: true, sub: delta(c.tot, cPrev.tot) || 'valore dei contratti creati nel mese' },
      { label: 'Contratti firmati', value: fmt(c.n), sub: c.nuovi + ' nuovi · ' + c.rinnovi + ' rinnovi · ' + c.upsell + ' upsell' },
      { label: 'Ticket medio', value: eur(safeDiv(c.tot, c.n)) },
      { label: 'Valore rinnovi', value: eur(c.rinnoviVal) },
    ] },
    { step: 3, title: 'Da incassare', tiles: [
      { label: 'Rate da incassare nel mese', value: eur(sc.daIncassare), hero: true,
        sub: fmt(sc.nRate) + ' rate in scadenza a ' + ymLabel(MESE) + ' non ancora incassate' },
      { label: 'Previsto nel mese', value: eur(sc.previsto), sub: 'tutte le rate in scadenza nel mese' },
      { label: 'Già incassato sulle scadenze', value: eur(sc.incassato), sub: fmtPct(pct(sc.incassato, sc.previsto)) + ' del previsto' },
      { label: 'Insolute del mese (>7gg)', value: fmtPct(insPct), tone: ins.nonIncassate > 0 ? 'bad' : 'good',
        sub: ins.nScadute === 0
          ? 'nessuna rata di ' + ymLabel(MESE) + ' è ancora scaduta da oltre 7 giorni'
          : eur(ins.nonIncassate) + ' mai incassati su ' + eur(ins.scadute) + ' scaduti a ' + ymLabel(MESE)
            + ' · arretrato totale fino a qui ' + eur(insTot.nonIncassate) },
    ] },
    { step: 4, title: 'Commerciale', tiles: [
      { label: 'Nuovi clienti', value: fmt(c.nuovi), hero: true, sub: 'contratti nuovi creati nel mese' },
      { label: 'Clienti rinnovati', value: fmt(c.rinnovi), sub: 'contratti di rinnovo creati nel mese' },
      { label: 'Upsell effettuati', value: fmt(c.upsell) },
      { label: 'Clienti persi', value: fmt(persiMese), tone: persiMese > 0 ? 'bad' : 'good',
        sub: 'segnati persi su Notion nel mese (churn)' },
      { label: 'Ticket medio nuovi', value: eur(safeDiv(c.nuoviVal, c.nuovi)), sub: 'valore medio dei contratti nuovi' },
      { label: 'Incassato medio alla 1ª rata', value: eur(safeDiv(s.nuovi, s.nuoviIds.size)),
        sub: s.nuoviIds.size + ' nuovi clienti hanno pagato la 1ª rata nel mese' },
    ] },
    { step: 5, title: 'Azienda', tiles: [
      { label: 'Riempimento team', value: riempTot.quota === null ? '—' : pctFrac(riempTot.quota), hero: true,
        tone: riempTot.quota === null ? undefined
          : (riempTot.quota >= 0.95 ? 'bad' : (riempTot.quota >= 0.75 ? undefined : 'good')),
        sub: riempTot.posti === 0
          ? 'nessuna capienza impostata: falle nella tab Delivery'
          : fmt(riempTot.assegnati) + ' posti occupati su ' + fmt(riempTot.posti)
            + ' (' + riempTot.persone + ' persone nei tre reparti) · media dei reparti '
            + pctFrac(riempTot.media) },
      tileRiemp(RUOLI_CAP[0]),
      tileRiemp(RUOLI_CAP[1]),
      tileRiemp(RUOLI_CAP[2]),
      { label: 'Aziende gestite', value: fmt(gestiti.length), sub: 'tutti gli stati tranne CLIENTE PERSO/SPARITO' },
      { label: 'Costi del mese', value: eur(cm.tot),
        sub: 'voci ' + eur(cm.manuali) + ' + commissioni ' + eur(cm.comm.tot) + (cm.rimborsi > 0 ? ' + rimborsi ' + eur(cm.rimborsi) : '') },
      { label: 'EBITDA', value: eur(p.ebitda), tone: p.ebitda >= 0 ? 'good' : 'bad',
        sub: (p.pctEbitda !== null ? pctFrac(p.pctEbitda) + " dell'incassato netto · " : '')
          + 'esclusi investimenti e asset' + (cm.capex > 0 ? ' (' + eur(cm.capex) + ')' : '') },
      { label: 'Margine netto', value: eur(p.cashFlow), tone: p.cashFlow >= 0 ? 'good' : 'bad',
        sub: 'incassato − tutti i costi del mese, capex e rimborsi inclusi' },
      { label: 'ROI', value: roi === null ? '—' : pctFrac(roi), tone: roi === null ? undefined : (roi >= 0 ? 'good' : 'bad'),
        sub: 'margine netto ÷ costi del mese' },
    ] },
  ]);
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
             ebitda: p.ebitda, costi: p.cm.tot, rimborsi: p.rimborsi };
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
    xlab: ymShort, yfmt: eur, height: 280,
    tip: (r, m) => `<div class="t-date">${ymLabel(m)}</div>
      <div class="t-row"><span>Incassato</span><b>${eur(r.incassato)}</b></div>
      <div class="t-row"><span>Contrattualizzato</span><b>${eur(r.contrattualizzato)}</b></div>
      <div class="t-row"><span>EBITDA</span><b>${eur(r.ebitda)}</b></div>
      <div class="t-row"><span>Costi del mese</span><b>${eur(r.costi)}</b></div>
      <div class="t-row"><span>Contratti firmati</span><b>${fmt(r.n)}</b></div>`,
  });
}

// ── tabella: incassi del mese per centro ─────────────────────────────────────
const centroCols = [
  { key: 'centro', label: 'Centro' },
  { key: 'consulente', label: 'Consulente', fmt: v => esc(v || '—') },
  { key: 'nRate', label: 'Rate incassate', fmt },
  { key: 'incassato', label: 'Incassato', fmt: eur },
  { key: 'daIncassare', label: 'Da incassare nel mese', fmt: v => v > 0 ? eur(v) : '—' },
];

function centroRows() {
  const m = new Map();
  const get = r => {
    const k = r.centro || '(senza centro)';
    let a = m.get(k);
    if (!a) { a = { centro: k, consulente: r.consulente || null, nRate: 0, incassato: 0, daIncassare: 0 }; m.set(k, a); }
    if (!a.consulente && r.consulente) a.consulente = r.consulente;
    return a;
  };
  for (const r of incassi()) {
    if (ymOf(r.data_incasso) === MESE) { const a = get(r); a.nRate += 1; a.incassato += (+r.importo || 0); }
    if (ymOf(r.data_scadenza) === MESE && !incassata(r)) get(r).daIncassare += (+r.importo || 0);
  }
  return [...m.values()];
}

function renderCentri() {
  const el = _mount.querySelector('#fnCentri');
  if (!el) return;
  const rows = centroRows();
  if (!rows.length) { el.innerHTML = '<div class="status">Nessun incasso nel mese selezionato.</div>'; return; }
  renderTable(el, centroCols, rows, centroSort,
    k => { centroSort = { key: k, dir: centroSort.key === k ? -centroSort.dir : -1 }; renderCentri(); },
    { barKey: 'incassato' });
}

// ── tabella: contratti firmati nel mese ──────────────────────────────────────
const contrattiCols = [
  { key: 'nome_centro', label: 'Centro' },
  { key: 'creazione_contratto', label: 'Firmato il', fmt: dtIt },
  { key: 'valore', label: 'Valore', fmt: eur },
  { key: 'statoTxt', label: 'Tipo / stato', fmt: v => esc(v || '—') },
  { key: 'durataTxt', label: 'Durata (gg)', fmt: v => esc(v || '—') },
  { key: 'venditore', label: 'Venditore', fmt: v => esc(v || '—') },
];

function renderContratti() {
  const el = _mount.querySelector('#fnContratti');
  if (!el) return;
  const rows = contratti()
    .filter(c => ymOf(c.creazione_contratto) === MESE)
    .map(c => ({ ...c, statoTxt: (c.stato || []).join(' · '), durataTxt: (c.durata || []).join(' · ') }));
  if (!rows.length) { el.innerHTML = '<div class="status">Nessun contratto creato nel mese selezionato.</div>'; return; }
  renderTable(el, contrattiCols, rows, contrattiSort,
    k => { contrattiSort = { key: k, dir: contrattiSort.key === k ? -contrattiSort.dir : -1 }; renderContratti(); },
    { barKey: 'valore' });
}

// ── tabella: rate insolute ───────────────────────────────────────────────────
const giorniRitardo = iso => Math.floor((todayRome() - new Date(iso + 'T00:00:00')) / 86400000);
const insCols = [
  { key: 'centro', label: 'Centro', fmt: v => esc(v || '—') },
  { key: 'data_scadenza', label: 'Scadenza', fmt: dtIt },
  { key: 'ritardo', label: 'Ritardo', fmt: v => fmt(v) + ' gg' },
  { key: 'importo', label: 'Importo', fmt: eur },
  { key: 'rata_numero', label: 'Rata n°', fmt: v => v === null || v === undefined ? '—' : fmt(v) },
  { key: 'consulente', label: 'Consulente', fmt: v => esc(v || '—') },
  { key: 'venditore', label: 'Venditore', fmt: v => esc(v || '—') },
];

// insoluto per mese di scadenza, ultimi 12 mesi: la lettura "com'è andato quel mese",
// senza l'arretrato dei mesi precedenti che schiaccia sempre la percentuale.
function renderInsoluteMensile() {
  const el = _mount.querySelector('#fnInsMensile');
  if (!el) return;
  const righe = [];
  for (let i = 11; i >= 0; i--) {
    const m = addYm(MESE, -i);
    const x = insolute(m, true);
    righe.push({ m, scadute: x.scadute, non: x.nonIncassate, n: x.nNonIncassate, p: pct(x.nonIncassate, x.scadute) });
  }
  const tot = righe.reduce((a, r) => ({ scadute: a.scadute + r.scadute, non: a.non + r.non, n: a.n + r.n }),
    { scadute: 0, non: 0, n: 0 });
  el.innerHTML = `
    <thead><tr><th>Mese di scadenza</th><th>Scaduto</th><th>Incassato</th><th>Mai incassato</th><th>Rate</th><th>% insoluto</th></tr></thead>
    <tbody>
      ${righe.map(r => `<tr>
        <td class="name">${ymLabel(r.m)}</td>
        <td>${eur(r.scadute)}</td>
        <td>${eur(r.scadute - r.non)}</td>
        <td>${r.non > 0 ? `<span class="val-bad">${eur(r.non)}</span>` : '—'}</td>
        <td>${r.n > 0 ? fmt(r.n) : '—'}</td>
        <td>${fmtPct(r.p)}</td></tr>`).join('')}
      <tr class="fn-tot">
        <td class="name">Totale 12 mesi</td>
        <td>${eur(tot.scadute)}</td>
        <td>${eur(tot.scadute - tot.non)}</td>
        <td>${eur(tot.non)}</td>
        <td>${fmt(tot.n)}</td>
        <td>${fmtPct(pct(tot.non, tot.scadute))}</td></tr>
    </tbody>`;
}

function renderInsolute() {
  const el = _mount.querySelector('#fnInsolute');
  if (!el) return;
  const rows = insolute(MESE).righe.map(r => ({ ...r, ritardo: giorniRitardo(r.data_scadenza) }));
  if (!rows.length) { el.innerHTML = '<div class="status">Nessuna rata scaduta e non incassata. 🎉</div>'; return; }
  renderTable(el, insCols, rows, insSort,
    k => { insSort = { key: k, dir: insSort.key === k ? -insSort.dir : -1 }; renderInsolute(); });
}

// ── tab Dashboard ────────────────────────────────────────────────────────────
const DASH_HTML = `
  <div class="kpi-groups" id="fnKpi"></div>

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
  </div>

  <div class="card">
    <h2>Incassi del mese per centro</h2>
    <div class="subtitle">Rate incassate nel mese selezionato (per data incasso) e, per gli stessi centri,
      le rate in scadenza nel mese non ancora incassate.</div>
    <div class="table-scroll"><table id="fnCentri"></table></div>
  </div>

  <div class="card">
    <h2>Contratti firmati nel mese</h2>
    <div class="subtitle">Dal DATABASE VALORE CONTRATTI, per data di creazione del contratto.</div>
    <div class="table-scroll"><table id="fnContratti"></table></div>
  </div>

  <div class="card">
    <h2>Insoluto mese per mese</h2>
    <div class="subtitle">Ultimi 12 mesi fino a <span id="fnInsMeseLabel"></span>, per <strong>mese di scadenza</strong>:
      quanto è arrivato a scadenza e quanto di quello non è ancora entrato, alla data di oggi.
      Sul mese in corso contano solo le rate scadute da oltre 7 giorni.</div>
    <div class="table-scroll"><table class="fn-pnl" id="fnInsMensile"></table></div>
  </div>

  <div class="card">
    <h2>Rate scadute e non incassate</h2>
    <div class="subtitle">La lista da lavorare per il recupero: <strong>tutte</strong> le rate scadute da
      oltre 7 giorni e mai incassate, dall'inizio fino alla fine del mese selezionato — non solo quelle del mese.</div>
    <div class="table-scroll"><table id="fnInsolute"></table></div>
  </div>`;

function renderDash() {
  _mount.querySelector('#fnContent').innerHTML = DASH_HTML;
  const lab = _mount.querySelector('#fnMeseLabel');
  if (lab) lab.textContent = ymLabel(MESE);
  const labIns = _mount.querySelector('#fnInsMeseLabel');
  if (labIns) labIns.textContent = ymLabel(MESE);
  renderKPI();
  renderTrend();
  renderCentri();
  renderContratti();
  renderInsoluteMensile();
  renderInsolute();
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
function renderPnl() {
  const d = pnl(MESE);
  const p = pnl(addYm(MESE, -1));
  const rn = d.ricaviNetti;

  // riga: etichetta | mese | % ricavi netti | mese prima | Δ
  // segno = true → è un costo, si mostra in negativo e il Δ va letto al contrario
  const riga = (label, get, opt = {}) => {
    const v = get(d), vp = get(p);
    const f = opt.pct ? (x => x === null ? '—' : pctFrac(x)) : eur;
    const quota = (!opt.pct && !opt.noQuota && rn > 0) ? pctFrac(Math.abs(v) / rn) : '';
    let delta = '';
    if (!opt.noDelta && vp !== null && vp !== 0 && !opt.pct) {
      const dl = 100 * (v - vp) / Math.abs(vp);
      const buono = opt.costo ? dl <= 0 : dl >= 0;
      delta = `<span class="${buono ? 'val-good' : 'val-bad'}">${dl >= 0 ? '+' : ''}${fmt(dl)}%</span>`;
    }
    return `<tr class="${opt.cls || ''}">
      <td class="name"${opt.indent ? ' style="padding-left:26px;color:var(--muted)"' : ''}>${label}</td>
      <td>${opt.costo && v > 0 ? '−' : ''}${f(v)}</td>
      <td class="fn-quota">${quota}</td>
      <td class="fn-quota">${opt.costo && vp > 0 ? '−' : ''}${f(vp)}</td>
      <td>${delta}</td></tr>`;
  };
  const testa = t => `<tr class="fn-head"><td colspan="5">${t}</td></tr>`;

  const cm = d.cm;
  const persCost = sumImporti(cm.voci.filter(c =>
    (c.reparto === 'Delivery' || c.reparto === 'Commerciale' ||
     String(c.sottocategoria || '').toLowerCase().indexOf('personale') !== -1))) + cm.comm.tot;
  const costoMkt = sumImporti(cm.voci.filter(c => c.reparto === 'Marketing'));
  const fissi = cm.cat.Operativi + cm.cat.Strutturali;
  const breakEven = d.pctLordo > 0.05 ? (fissi + cm.rimborsi) / d.pctLordo : null;

  const topCosti = costiRaggruppati(cm).slice(0, 12);
  const maxCosto = topCosti.length ? topCosti[0].importo : 1;

  _mount.querySelector('#fnContent').innerHTML = `
    <div class="kpi-row" id="fnPnlKpi"></div>

    <div class="card">
      <h2>Conto economico (per cassa) — ${ymLabel(MESE)}</h2>
      <div class="subtitle">Ricavi = incassi realmente entrati nel mese (non il fatturato contrattualizzato).
        La colonna <strong>% ricavi</strong> è sull'incassato netto; il <strong>Δ</strong> confronta col mese precedente
        (verde = va nella direzione giusta, anche quando è un costo che scende).</div>
      <div class="table-scroll"><table class="fn-pnl">
        <thead><tr><th>Voce</th><th>${ymLabel(MESE)}</th><th>% ricavi</th><th>${ymLabel(addYm(MESE, -1))}</th><th>Δ</th></tr></thead>
        <tbody>
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
        </tbody>
      </table></div>
    </div>

    <div class="kpi-row" id="fnPnlInc"></div>

    <div class="card">
      <h2>Dove vanno i soldi — ${ymLabel(MESE)}</h2>
      <div class="subtitle">Le 12 voci più pesanti del mese, commissioni incluse.
        Il personale è unito per ruolo: una riga per i project manager, una per i media buyer e così via
        (il dettaglio persona per persona è nella tab Costi).</div>
      ${topCosti.length ? topCosti.map(x => `
        <div class="esito-row">
          <div class="esito-top"><span class="lbl">${esc(x.etichetta)}${x.n > 1 ? ` <span style="color:var(--muted);font-weight:400">· ${x.n} persone</span>` : ''}</span>
            <span class="val"><b>${eur(x.importo)}</b> · ${fmtPct(pct(x.importo, cm.tot))}</span></div>
          <div class="esito-track"><div class="esito-fill" style="width:${Math.max(2, Math.round(100 * x.importo / maxCosto))}%;background:var(--series-1)"></div></div>
        </div>`).join('') : '<div class="status">Nessun costo nel mese.</div>'}
    </div>`;

  renderKpiRow(_mount.querySelector('#fnPnlKpi'), [
    { label: 'Fatturato contrattualizzato', value: eur(d.contrattualizzato), sub: 'valore dei contratti firmati nel mese' },
    { label: 'Ricavi netti (cassa)', value: eur(rn), sub: 'incassato − rimborsi' },
    { label: 'Margine lordo', value: eur(d.margineLordo), sub: d.pctLordo === null ? '' : pctFrac(d.pctLordo) + ' dei ricavi netti' },
    { label: 'EBITDA', value: eur(d.ebitda), sub: d.pctEbitda === null ? '' : pctFrac(d.pctEbitda) + ' dei ricavi netti' },
    { label: 'Cash flow', value: eur(d.cashFlow), sub: 'dopo investimenti e asset' },
  ]);

  renderKpiRow(_mount.querySelector('#fnPnlInc'), [
    { label: 'Incidenza personale', value: rn > 0 ? pctFrac(persCost / rn) : '—',
      sub: eur(persCost) + ' fra team e commissioni' },
    { label: 'Incidenza costi fissi', value: rn > 0 ? pctFrac(fissi / rn) : '—',
      sub: 'operativi + strutturali sui ricavi netti' },
    { label: 'Incidenza marketing', value: rn > 0 ? pctFrac(costoMkt / rn) : '—',
      sub: eur(costoMkt) + ' di spese marketing registrate' },
    { label: 'Break even incassi', value: breakEven === null ? '—' : eur(breakEven),
      sub: 'incasso che copre i costi fissi, al margine lordo del mese' },
    { label: 'Costi totali', value: eur(cm.tot), sub: 'tutto quello che è uscito nel mese' },
  ]);
}

// ── tab Marketing ────────────────────────────────────────────────────────────
// Replica la pagina Marketing del Cockpit, con le fonti dichiarate riga per riga:
//  · budget ADV → SEMPRE dal foglio "KPI MARKETING & VENDITE 2026" (KPI ALL 3),
//    che finisce in fin_marketing col sync n8n: la spesa pubblicitaria di SV non
//    esiste da nessun'altra parte in Supabase;
//  · funnel → mesi chiusi dal foglio (dato ufficiale), mese in corso dal vivo
//    dalle opportunita' GHL. La regola di conteggio e' la stessa del foglio:
//    l'opportunita' pesa nel mese in cui e' NATA, non in quello in cui e' avanzata;
//  · euro → valore delle chiusure di quel funnel. Il venduto di TUTTE le fonti
//    (Notion) sta nella card di confronto: e' un'altra popolazione, non si somma.
// I chip sopra il funnel permettono di forzare foglio o live su qualsiasi mese.
const meseCorrente = () => dstr(todayRome()).slice(0, 7);
const numOrNull = v => (v === null || v === undefined || v === '') ? null : +v;
// come safeDiv, ma un numeratore MANCANTE resta '—': il foglio ha buchi (gennaio
// senza appuntamenti) e in JS null/253 farebbe 0, cioe' "0%", che e' un'altra cosa.
const div = (a, b) => (a === null || a === undefined) ? null : safeDiv(a, b);
const rigaFoglio = m => (DATA.marketing || []).find(r => r.mese === m) || null;
const rigaFunnel = m => (DATA.funnel || []).find(r => r.mese === m) || null;
const rigaVendita = m => (DATA.vendita || []).find(r => r.mese === m) || null;
let mktSort = { key: 'mese', dir: -1 };

function mesiMarketing() {
  const s = new Set([...(DATA.marketing || []).map(r => r.mese), ...(DATA.funnel || []).map(r => r.mese)]);
  return [...s].sort();
}

// i numeri del mese secondo la vista in vigore (+ i KPI che ne discendono)
function mkNumeri(m) {
  const fg = rigaFoglio(m), lv = rigaFunnel(m);
  const live = (MKT_VISTA ? MKT_VISTA === 'live' : m >= meseCorrente()) && !!lv;
  const k = live
    ? { lead: lv.lead, app: lv.app_fissati, daSvolgere: lv.app_da_svolgere, show: lv.app_presentati,
        chiusure: lv.chiusure, valore: numOrNull(lv.valore_chiusure),
        cash: fg ? numOrNull(fg.cash_incassato) : null }
    : { lead: fg ? numOrNull(fg.lead) : null, app: fg ? numOrNull(fg.app_fissati) : null,
        daSvolgere: fg ? numOrNull(fg.app_da_svolgere) : null,
        show: fg ? numOrNull(fg.app_presentati) : null, chiusure: fg ? numOrNull(fg.chiusure) : null,
        valore: fg ? numOrNull(fg.valore_contratti) : null, cash: fg ? numOrNull(fg.cash_incassato) : null };
  k.mese = m;
  k.fonte = live ? 'live' : 'foglio';
  k.budget = fg ? numOrNull(fg.budget_adv) : null;   // sempre e comunque dal foglio
  k.cpl = div(k.budget, k.lead);
  k.cac = div(k.budget, k.chiusure);
  k.roas = div(k.valore, k.budget);
  k.roasCash = div(k.cash, k.budget);
  k.roi = (k.budget > 0 && k.cash !== null) ? (k.cash - k.budget) / k.budget : null;
  k.ticket = div(k.valore, k.chiusure);
  k.booking = div(k.app, k.lead);
  k.showUp = div(k.show, k.app);
  k.closing = div(k.chiusure, k.show);
  k.closingLead = div(k.chiusure, k.lead);
  k.pctCash = div(k.cash, k.valore);
  return k;
}

const MKT_HTML = `
  <div class="kpi-row" id="mkKpi"></div>

  <div class="card">
    <div class="funnel-head">
      <h2>Funnel acquisizione — <span id="mkMese"></span></h2>
      <span class="funnel-spend" id="mkSpend"></span>
    </div>
    <div class="subtitle" id="mkNota"></div>
    <div class="lead-tabs" id="mkFonte">
      <button data-v="foglio">Foglio KPI ALL 3</button>
      <button data-v="live">Live (opportunità GHL)</button>
    </div>
    <div class="funnel" id="mkFunnel"></div>
    <div class="funnel-kpis" id="mkFunnelKpi"></div>
  </div>

  <div class="card">
    <h2>Venduto del mese secondo Notion — tutte le fonti</h2>
    <div class="subtitle">Il funnel qui sopra conta solo quello che passa dalle opportunità GHL (le campagne).
      Qui c'è invece tutto il venduto del mese come lo vede Notion — referral e passaparola compresi:
      serve a capire quanta parte del fatturato la generano davvero le campagne. Le due cifre non si sommano.</div>
    <div class="kpi-row" id="mkNotion"></div>
  </div>

  <div class="card">
    <h2>Andamento 12 mesi</h2>
    <div class="subtitle">Spesa pubblicitaria e valore dei contratti chiusi dal funnel, mese per mese.</div>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--series-1)"></span>Spesa ADV</span>
      <span class="key"><span class="swatch" style="background:var(--series-2)"></span>Valore contratti chiusi</span>
    </div>
    <div class="chart-wrap"><svg id="mkTrend" width="100%" height="280"></svg></div>
  </div>

  <div class="card">
    <h2>Mese per mese</h2>
    <div class="subtitle">Il tracker completo: colonna "Fonte" = da dove arrivano i numeri di quella riga
      (il budget è sempre del foglio).</div>
    <div class="table-scroll"><table id="mkTabella"></table></div>
  </div>

  <div class="card">
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
      <h2 style="margin-right:auto">Vendita — <span id="mkMeseV"></span></h2>
      <button class="tk-btn tk-btn-pri" id="mkModifica">Modifica i numeri a mano</button>
    </div>
    <div class="subtitle">KPI Totale e il venduto di rinnovi e upsell arrivano da soli (opportunità GHL per il
      lavoro dei setter, Notion per gli euro). Restano a mano solo i numeri che nessun sistema registra:
      i referral e le call di rinnovo/upsell.</div>
    <div class="kpi-groups" id="mkVendita"></div>
  </div>`;

function renderMarketing() {
  const content = _mount.querySelector('#fnContent');
  content.innerHTML = MKT_HTML;
  const k = mkNumeri(MESE);
  const lv = rigaFunnel(MESE);

  _mount.querySelector('#mkMese').textContent = ymLabel(MESE);
  _mount.querySelector('#mkMeseV').textContent = ymLabel(MESE);
  _mount.querySelector('#mkSpend').innerHTML =
    `Spesa ADV <b>${eur(k.budget)}</b> · CPL <b>${k.cpl === null ? '—' : eur2(k.cpl)}</b> · CAC <b>${eur(k.cac)}</b>`;
  _mount.querySelector('#mkNota').innerHTML = k.fonte === 'live'
    ? `Numeri dal vivo dalle opportunità GHL (aggiornati al momento), contate per mese di creazione — la stessa
       regola del foglio. La spesa pubblicitaria arriva comunque dal foglio KPI ALL 3.`
    : `Dato ufficiale del foglio "KPI MARKETING & VENDITE 2026" (KPI ALL 3)${
        rigaFoglio(MESE) ? '' : ' — <strong>nessuna riga per questo mese</strong>'}.
       In automatico i mesi chiusi si leggono dal foglio e il mese in corso dal vivo.`;

  _mount.querySelectorAll('#mkFonte button').forEach(b => {
    b.classList.toggle('active', b.dataset.v === k.fonte);
    b.onclick = () => { MKT_VISTA = b.dataset.v; renderMarketing(); };
  });

  renderKpiRow(_mount.querySelector('#mkKpi'), [
    { label: 'Spesa ADV', value: eur(k.budget), sub: 'dal foglio KPI ALL 3' },
    { label: 'CPL', value: k.cpl === null ? '—' : eur2(k.cpl), sub: fmt(k.lead) + ' lead' },
    { label: 'CAC', value: eur(k.cac), sub: fmt(k.chiusure) + ' chiusure' },
    { label: 'ROAS contrattualizzato', value: ratio(k.roas), sub: eur(k.valore) + ' di contratti' },
    { label: 'ROAS incassato', value: ratio(k.roasCash), sub: k.cash === null ? 'cash non disponibile' : eur(k.cash) + ' incassati subito' },
    { label: 'Ticket medio', value: eur(k.ticket), sub: 'valore ÷ chiusure' },
  ]);

  // funnel: le stesse barre della sezione Marketing per centro
  const stages = [
    { nome: 'Lead', val: k.lead },
    { nome: 'Appuntamenti fissati', val: k.app },
    { nome: 'Appuntamenti presentati', val: k.show },
    { nome: 'Chiusure', val: k.chiusure },
  ];
  const base = stages[0].val;
  _mount.querySelector('#mkFunnel').innerHTML = stages.map((s, i) => {
    const step = i > 0
      ? `<div class="f-step">↓ ${pctFrac(div(s.val, stages[i - 1].val))}</div>` : '';
    const w = base > 0 ? Math.max((s.val || 0) / base * 100, 2.5) : 2.5;
    return `${step}
      <div class="f-label"><span class="f-name">${s.nome}</span>
        <span class="f-val">${fmt(s.val)}</span>
        <span class="f-share">${pctFrac(div(s.val, base))}</span></div>
      <div class="f-bar f-bar-${i + 1}" style="width:${w}%"></div>`;
  }).join('');

  const kpiBox = (label, val, sub) => `
    <div class="f-kpi"><span class="f-kpi-label">${label}</span>
      <span class="f-kpi-val">${val}</span>${sub ? `<span class="f-kpi-sub">${sub}</span>` : ''}</div>`;
  _mount.querySelector('#mkFunnelKpi').innerHTML =
    kpiBox('Da lead ad appuntamento', pctFrac(k.booking), 'booking rate') +
    kpiBox('Da appuntamento a presentato', pctFrac(k.showUp), 'show-up rate') +
    kpiBox('Chiusure sui presentati', pctFrac(k.closing), 'closing rate') +
    kpiBox('Chiusure sui lead', pctFrac(k.closingLead), 'quanti lead diventano clienti') +
    kpiBox('ROI sul cash', k.roi === null ? '—' : pctFrac(k.roi), 'incassato subito − spesa, sulla spesa') +
    kpiBox('% cash sui contratti', pctFrac(k.pctCash), 'quanto del venduto entra subito');

  // confronto con Notion: il venduto di tutte le fonti nello stesso mese
  const cont = contrattualizzato(MESE);
  const inc = splitIncassato(MESE);
  renderKpiRow(_mount.querySelector('#mkNotion'), [
    { label: 'Nuovi contratti', value: fmt(cont.nuovi), sub: eur(cont.nuoviVal) + ' contrattualizzati' },
    { label: 'Cash 1ª rata nuovi', value: eur(inc.nuovi), sub: 'incassato nel mese dai clienti nuovi' },
    { label: 'Rinnovi', value: fmt(cont.rinnovi), sub: eur(cont.rinnoviVal) + ' · incassati ' + eur(inc.rinnovi) },
    { label: 'Upsell', value: fmt(cont.upsell), sub: eur(cont.upsellVal) + ' · incassati ' + eur(inc.upsell) },
    { label: 'Chiusure dal funnel', value: fmt(k.chiusure),
      sub: cont.nuovi > 0 ? pctFrac(div(k.chiusure, cont.nuovi)) + ' dei contratti nuovi' : '—' },
  ]);

  renderMktTrend();
  renderMktTabella();
  renderVenditaKpi();
  _mount.querySelector('#mkModifica').onclick = () => apriFormVendita(MESE);
}

function renderMktTrend() {
  const el = _mount.querySelector('#mkTrend');
  if (!el) return;
  // il tracker parte da gennaio 2026: prima non ci sono numeri, e una serie di
  // zeri iniziali schiaccerebbe la scala facendo sembrare che non si spendesse nulla
  const primo = mesiMarketing()[0];
  const months = [];
  for (let i = 11; i >= 0; i--) { const m = addYm(MESE, -i); if (!primo || m >= primo) months.push(m); }
  const rows = months.map(m => { const k = mkNumeri(m); return { ...k, spesa: k.budget || 0, valoreC: k.valore || 0 }; });
  renderLineChart(el, months, rows, [
    { key: 'spesa', color: '--series-1', name: 'Spesa ADV' },
    { key: 'valoreC', color: '--series-2', name: 'Valore contratti chiusi' },
  ], {
    xlab: ymShort, yfmt: eur, height: 280,
    tip: (r, m) => `<div class="t-date">${ymLabel(m)}</div>
      <div class="t-row"><span>Spesa ADV</span><b>${eur(r.budget)}</b></div>
      <div class="t-row"><span>Valore contratti</span><b>${eur(r.valore)}</b></div>
      <div class="t-row"><span>Lead</span><b>${fmt(r.lead)}</b></div>
      <div class="t-row"><span>CPL</span><b>${r.cpl === null ? '—' : eur2(r.cpl)}</b></div>
      <div class="t-row"><span>Chiusure</span><b>${fmt(r.chiusure)}</b></div>
      <div class="t-row"><span>CAC</span><b>${eur(r.cac)}</b></div>`,
  });
}

const mktCols = [
  { key: 'mese', label: 'Mese', fmt: v => ymLabel(v) },
  { key: 'budget', label: 'Spesa ADV', fmt: eur },
  { key: 'lead', label: 'Lead', fmt },
  { key: 'cpl', label: 'CPL', fmt: v => v === null ? '—' : eur2(v) },
  { key: 'app', label: 'App. fissati', fmt },
  { key: 'show', label: 'Presentati', fmt },
  { key: 'chiusure', label: 'Chiusure', fmt },
  { key: 'cac', label: 'CAC', fmt: eur },
  { key: 'valore', label: 'Valore contratti', fmt: eur },
  { key: 'roas', label: 'ROAS', fmt: ratio },
  { key: 'cash', label: 'Cash immediato', fmt: eur },
  { key: 'pctCash', label: '% cash', fmt: pctFrac },
  { key: 'fonte', label: 'Fonte', fmt: v => v === 'live' ? 'GHL dal vivo' : 'foglio' },
];

function renderMktTabella() {
  const el = _mount.querySelector('#mkTabella');
  if (!el) return;
  const rows = mesiMarketing().map(mkNumeri);
  if (!rows.length) { el.innerHTML = '<div class="status">Nessun dato marketing: il sync dal foglio non è ancora passato.</div>'; return; }
  renderTable(el, mktCols, rows, mktSort,
    k => { mktSort = { key: k, dir: mktSort.key === k ? -mktSort.dir : -1 }; renderMktTabella(); });
}

// ── blocco Vendita (dentro il tab Marketing) ─────────────────────────────────
// Totale = lavoro dei setter del mese, per mese di CAMBIO STAGE (la stessa
// convenzione della sezione Vendita: "cosa e' successo questo mese").
function renderVenditaKpi() {
  const el = _mount.querySelector('#mkVendita');
  if (!el) return;
  const lv = rigaFunnel(MESE);
  const v = rigaVendita(MESE) || {};
  const cont = contrattualizzato(MESE);
  const inc = splitIncassato(MESE);
  if (!lv) { el.innerHTML = '<div class="status">Nessun dato per questo mese.</div>'; return; }

  const rinN = numOrNull(v.rin_chiusura);
  const upN = numOrNull(v.up_chiusure);
  const gruppi = [
    { step: '1', title: 'KPI Totale', tiles: [
      { label: 'Chiusure', value: fmt(lv.st_chiusure), hero: true, sub: eur(lv.st_contrattualizzato) + ' contrattualizzati' },
      { label: 'Chiamati', value: fmt(lv.chiamati) },
      { label: 'Risposte', value: fmt(lv.risposte) },
      { label: 'Da richiamare', value: fmt(lv.st_da_richiamare) },
      { label: 'Scarti', value: fmt(lv.st_scarti), sub: 'non in target, fake' },
      { label: 'App. fissati', value: fmt(lv.st_app_fissati) },
      { label: 'Da svolgere', value: fmt(lv.st_app_da_svolgere) },
      { label: 'Presentati', value: fmt(lv.st_show) },
      { label: 'No show', value: fmt(lv.st_noshow) },
      { label: 'Incassato', value: eur(lv.st_incassato) },
      { label: '% App. su risposte', value: pctFrac(safeDiv(lv.st_app_fissati, lv.risposte)) },
      { label: '% Show up', value: pctFrac(safeDiv(lv.st_show, lv.st_app_fissati)) },
      { label: '% Closing', value: pctFrac(safeDiv(lv.st_chiusure, lv.st_show)) },
      { label: 'Ticket medio', value: eur(safeDiv(lv.st_contrattualizzato, lv.st_chiusure)) },
    ] },
    { step: '2', title: 'KPI Referral', tiles: [
      { label: 'Vendite referral', value: fmt(numOrNull(v.ref_n)), hero: true, sub: 'a mano' },
      { label: 'Contrattualizzato', value: eur(numOrNull(v.ref_contr)) },
      { label: 'Incassato', value: eur(numOrNull(v.ref_incassato)) },
      { label: 'Ticket medio', value: eur(div(numOrNull(v.ref_contr), numOrNull(v.ref_n))) },
      { label: '% incassato', value: pctFrac(div(numOrNull(v.ref_incassato), numOrNull(v.ref_contr))) },
    ] },
    { step: '3', title: 'KPI Rinnovi', tiles: [
      { label: 'Rinnovi firmati', value: fmt(cont.rinnovi), hero: true, sub: 'da Notion, nel mese' },
      { label: 'Contrattualizzato', value: eur(cont.rinnoviVal) },
      { label: 'Incassato', value: eur(inc.rinnovi) },
      { label: 'Ticket medio', value: eur(safeDiv(cont.rinnoviVal, cont.rinnovi)) },
      { label: '% incassato', value: pctFrac(safeDiv(inc.rinnovi, cont.rinnoviVal)) },
      { label: 'Call di rinnovo', value: fmt(numOrNull(v.rin_call)), sub: 'a mano' },
      { label: '% chiusura su call', value: pctFrac(safeDiv(rinN === null ? cont.rinnovi : rinN, numOrNull(v.rin_call))) },
      { label: 'Rinnovi 90/180/360', value: [v.rin_90, v.rin_180, v.rin_360].map(x => x === null || x === undefined ? '—' : x).join(' / '), sub: 'a mano' },
    ] },
    { step: '4', title: 'KPI Upsell', tiles: [
      { label: 'Upsell firmati', value: fmt(cont.upsell), hero: true, sub: 'da Notion, nel mese' },
      { label: 'Contrattualizzato', value: eur(cont.upsellVal) },
      { label: 'Incassato', value: eur(inc.upsell) },
      { label: 'Ticket medio', value: eur(safeDiv(cont.upsellVal, cont.upsell)) },
      { label: 'Call upsell', value: fmt(numOrNull(v.up_call)), sub: 'a mano' },
      { label: '% chiusura su call', value: pctFrac(safeDiv(upN === null ? cont.upsell : upN, numOrNull(v.up_call))) },
    ] },
  ];
  renderKpiGroups(el, gruppi);
}

// ── form: i numeri vendita che nessun sistema registra ───────────────────────
const CAMPI_VENDITA = [
  ['Referral', [['ref_n', 'n° vendite referral'], ['ref_contr', 'Contrattualizzato €'], ['ref_incassato', 'Incassato €']]],
  ['Rinnovi', [['rin_call', 'n° call di rinnovo'], ['rin_chiusura', 'n° chiusure rinnovo'],
               ['rin_90', 'Rinnovi a 90 giorni'], ['rin_180', 'Rinnovi a 180 giorni'], ['rin_360', 'Rinnovi a 360 giorni']]],
  ['Upsell', [['up_call', 'n° call upsell'], ['up_chiusure', 'n° chiusure upsell']]],
];

function apriFormVendita(m) {
  const box = _mount.querySelector('#fnModal');
  const v = rigaVendita(m) || {};
  const val = k => (v[k] === null || v[k] === undefined) ? '' : v[k];

  box.innerHTML = `<div class="modal-card tk-form-card">
    <div class="modal-head"><h3>Numeri vendita — ${ymLabel(m)}</h3>
      <button class="modal-close" id="fvX" title="Chiudi">✕</button></div>
    <div class="modal-sub">Solo quello che non arriva da solo: i referral e le call di rinnovo/upsell.
      Il venduto di rinnovi e upsell lo legge già Notion, il lavoro dei setter le opportunità GHL.</div>
    ${CAMPI_VENDITA.map(([tit, campi]) => `
      <h4 style="margin:14px 0 6px;font-size:13px">${tit}</h4>
      <div class="tk-campi">
        ${campi.map(([k, l]) =>
          `<label class="tk-campo">${l}<input type="number" step="any" id="fv_${k}" value="${val(k)}" placeholder="—"></label>`).join('')}
      </div>`).join('')}
    <div class="tk-campi" style="margin-top:12px">
      <label class="tk-campo tk-largo">Note<input type="text" id="fv_note" maxlength="300" value="${esc(v.note || '')}"></label>
    </div>
    <div class="tk-azioni tk-azioni-form">
      <span class="tk-msg" id="fvMsg"></span>
      <button class="tk-btn tk-btn-ghost" id="fvAnnulla">Annulla</button>
      <button class="tk-btn tk-btn-pri" id="fvSalva">Salva</button>
    </div>
  </div>`;
  box.classList.remove('hidden');

  const q = id => box.querySelector('#' + id);
  const chiudi = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  q('fvX').onclick = chiudi;
  q('fvAnnulla').onclick = chiudi;
  box.onclick = e => { if (e.target === box) chiudi(); };

  q('fvSalva').onclick = async () => {
    const riga = { mese: m, note: q('fv_note').value.trim() || null, aggiornato_a: new Date().toISOString() };
    for (const [, campi] of CAMPI_VENDITA) {
      for (const [k] of campi) {
        const raw = q('fv_' + k).value.trim();
        riga[k] = raw === '' ? null : +raw;
      }
    }
    q('fvSalva').disabled = true;
    const { error } = await supabase.from('fin_vendita').upsert(riga, { onConflict: 'mese' });
    q('fvSalva').disabled = false;
    if (error) { q('fvMsg').textContent = error.message; return; }
    chiudi();
    await ricaricaVendita();
    renderAll();
  };
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

let CAP = new Map();                          // "RUOLO|persona" → capienza
function rebuildCap() {
  CAP = new Map();
  for (const c of (DATA && DATA.capacita ? DATA.capacita : [])) {
    CAP.set(c.ruolo + '|' + c.nome, +c.capacita || 0);
  }
}
const capDi = (ruolo, nome) => {
  const v = CAP.get(ruolo + '|' + nome);
  return v === undefined ? RUOLO(ruolo).def : v;
};
const capImpostata = (ruolo, nome) => CAP.has(ruolo + '|' + nome);

// una riga per persona del ruolo, col suo carico, i suoi rinnovi e la sua capienza
function caricoPerRuolo(ruolo) {
  const R = RUOLO(ruolo);
  const campo = R.campo;
  const perNome = centriByNome();
  const m = new Map();
  const get = k => {
    let a = m.get(k);
    if (!a) { a = { pm: k, ruolo, gestiti: 0, attive: 0, operativi: 0, onboarding: 0, attesaRinnovo: 0, persi12m: 0, rinnovi: 0, incassato: 0 }; m.set(k, a); }
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
    a.capacita = a.pm === NON_ASSEGNATO ? null : capDi(ruolo, a.pm);
    a.saturazione = a.capacita > 0 ? a.carico / a.capacita * 100 : null;
    a.perCliente = a.gestiti > 0 ? a.incassato / a.gestiti : null;
    return a;
  });
}

// riempimento del ruolo = carico assegnato ÷ somma delle capienze delle persone
function riempimentoRuolo(ruolo) {
  const R = RUOLO(ruolo);
  const righe = caricoPerRuolo(ruolo);
  const persone = righe.filter(r => r.pm !== NON_ASSEGNATO && (r.gestiti > 0 || capImpostata(ruolo, r.pm)));
  const posti = persone.reduce((a, r) => a + (r.capacita || 0), 0);
  const assegnati = persone.reduce((a, r) => a + r.carico, 0);
  const senza = righe.filter(r => r.pm === NON_ASSEGNATO).reduce((a, r) => a + r.carico, 0);
  return { ruolo, base: R.base, baseTxt: R.baseTxt, persone: persone.length, posti, assegnati, senza,
           quota: posti > 0 ? assegnati / posti : null };
}

const capCol = {
  key: 'capacita', label: 'Capienza (modificabile)',
  fmt: (v, r) => r.pm === NON_ASSEGNATO ? '—'
    : `<input type="number" class="cap-inp" min="0" max="1000" step="1" value="${v}"
        data-ruolo="${esc(r.ruolo)}" data-nome="${esc(r.pm)}"
        title="Quante ${esc(RUOLO(r.ruolo).baseTxt)} può seguire ${esc(r.pm)}">`,
};
const colsRuolo = ruolo => {
  const R = RUOLO(ruolo);
  const cols = [
    { key: 'pm', label: R.label },
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
async function salvaCapacita(ruolo, nome, valore) {
  const n = Math.max(0, Math.min(1000, Math.round(+valore || 0)));
  const { error } = await supabase.from('fin_capacita')
    .upsert({ ruolo, nome, capacita: n, updated_at: new Date().toISOString() }, { onConflict: 'ruolo,nome' });
  if (error) { alert('Non sono riuscito a salvare la capienza: ' + error.message); return; }
  DATA.capacita = (DATA.capacita || []).filter(c => !(c.ruolo === ruolo && c.nome === nome))
    .concat([{ ruolo, nome, capacita: n }]);
  rebuildCap();
  renderDelivery();
}

// tasso di rinnovo e churn, mese per mese (ultimi 12)
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
    const scaduti = centriRows().filter(c => ymOf(c.fine_servizio) === m).length;
    return { mese: m, rinnovi: rin.length, persi, valore: val, cash, scaduti,
             tasso: pct(rin.length, rin.length + persi),
             churn: gestiti > 0 ? 100 * persi / gestiti : null };
  });
  return { months, righe: out, gestiti };
}

function renderDelivery() {
  const perRuoloRighe = {};
  RUOLI_CAP.forEach(R => {
    perRuoloRighe[R.key] = caricoPerRuolo(R.key)
      .filter(r => r.gestiti > 0 || r.rinnovi > 0 || r.incassato > 0 || capImpostata(R.key, r.pm));
  });
  const riemp = {};
  RUOLI_CAP.forEach(R => { riemp[R.key] = riempimentoRuolo(R.key); });
  const rc = rinnoviChurn();
  const cm = costiMese(MESE);
  const teamDel = cm.occ.filter(c => (c.reparto || '') === 'Delivery');
  const costoTeam = sumImporti(teamDel);
  const gestiti = rc.gestiti;
  const nPM = new Set(centriRows().filter(isGestito).map(x => x.consulente).filter(Boolean)).size;
  const perRuolo = RUOLI_DELIVERY.map(ru => ({
    ruolo: ru,
    voci: teamDel.filter(c => (c.ruolo || 'Altri ruoli') === ru).length,
    costo: sumImporti(teamDel.filter(c => (c.ruolo || 'Altri ruoli') === ru)),
  })).filter(x => x.voci > 0);
  const ultimi = rc.righe.slice(-12);
  const rinTot = ultimi.reduce((a, r) => a + r.rinnovi, 0);
  const persiTot = ultimi.reduce((a, r) => a + r.persi, 0);
  const churnMedio = ultimi.length ? ultimi.reduce((a, r) => a + (r.churn || 0), 0) / ultimi.length : null;

  _mount.querySelector('#fnContent').innerHTML = `
    <div class="kpi-row" id="fnDelKpi"></div>

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
      <div class="subtitle"><strong>Tasso di rinnovo</strong> = rinnovi firmati ÷ (rinnovi + clienti persi) nel mese.
        <strong>Churn</strong> = clienti persi nel mese ÷ ${fmt(gestiti)} clienti oggi in gestione: il denominatore è
        fisso (non abbiamo lo storico mensile della base gestita), quindi va letto come ordine di grandezza.
        "Contratti in scadenza" = clienti con FINE SERVIZIO in quel mese.</div>
      <div class="table-scroll"><table class="fn-pnl">
        <thead><tr><th>Mese</th><th>Rinnovi</th><th>Clienti persi</th><th>Tasso di rinnovo</th><th>Churn</th><th>In scadenza</th><th>Valore rinnovi</th><th>Incassato su rinnovi</th></tr></thead>
        <tbody>
          ${ultimi.map(r => `<tr>
            <td class="name">${ymLabel(r.mese)}</td>
            <td>${fmt(r.rinnovi)}</td>
            <td>${fmt(r.persi)}</td>
            <td>${r.tasso === null ? '—' : `<span class="${r.tasso >= 30 ? 'val-good' : 'val-bad'}">${fmtPct(r.tasso)}</span>`}</td>
            <td>${r.churn === null ? '—' : fmtPct(r.churn)}</td>
            <td>${fmt(r.scaduti)}</td>
            <td>${eur(r.valore)}</td>
            <td>${eur(r.cash)}</td></tr>`).join('')}
          <tr class="fn-tot"><td class="name">Totale 12 mesi</td>
            <td>${fmt(rinTot)}</td><td>${fmt(persiTot)}</td>
            <td>${fmtPct(pct(rinTot, rinTot + persiTot))}</td>
            <td>${churnMedio === null ? '—' : fmtPct(churnMedio)}</td>
            <td>${fmt(ultimi.reduce((a, r) => a + r.scaduti, 0))}</td>
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
    { label: 'Tasso di rinnovo 12 mesi', value: fmtPct(pct(rinTot, rinTot + persiTot)),
      sub: rinTot + ' rinnovi su ' + (rinTot + persiTot) + ' esiti' },
    { label: 'Churn medio mensile', value: churnMedio === null ? '—' : fmtPct(churnMedio),
      sub: 'sui clienti in gestione' },
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
  _mount.querySelectorAll('input.cap-inp').forEach(inp => {
    inp.onchange = () => salvaCapacita(inp.dataset.ruolo, inp.dataset.nome, inp.value);
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
      const k = (an && an[campo]) || '(non assegnato)';
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].map(([nome, n]) => ({ nome, n })).sort((a, b) => b.n - a.n).slice(0, 10);
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

const ltvCols = [
  { key: 'centro', label: 'Cliente' },
  { key: 'incassato', label: 'Incassato totale', fmt: eur },
  { key: 'nRate', label: 'Rate', fmt },
  { key: 'mesi', label: 'Mesi attivo', fmt: v => v === null ? '—' : fmt(v) },
  { key: 'perMese', label: 'Incassato / mese', fmt: v => v === null ? '—' : eur(v) },
  { key: 'primo', label: 'Primo incasso', fmt: dtIt },
  { key: 'ultimo', label: 'Ultimo incasso', fmt: dtIt },
  { key: 'consulente', label: 'PM', fmt: v => esc(v || '—') },
  { key: 'stato', label: 'Stato', fmt: v => v === 'perso' ? '<span class="val-bad">perso</span>' : '<span class="val-good">attivo</span>' },
];

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
    </div>

    <div class="card">
      <h2>Clienti per valore incassato</h2>
      <div class="subtitle">Tutto lo storico degli incassi, un cliente per riga. "Mesi attivo" parte da INIZIO SERVIZIO
        (o dal primo incasso se manca) e arriva a fine servizio, all'ultimo incasso se il cliente è perso, o a oggi.</div>
      <div class="table-scroll"><table id="fnLtv"></table></div>
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

  renderTable(_mount.querySelector('#fnLtv'), ltvCols, righe, ltvSort,
    k => { ltvSort = { key: k, dir: ltvSort.key === k ? -ltvSort.dir : -1 }; renderClienti(); },
    { barKey: 'incassato' });
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
        r.id_incasso, r.centro, r.consulente, r.venditore, r.data_incasso, r.data_scadenza,
        csvNum(r.importo), csvNum(r.rata_numero), r.metodo, (r.tipo_contratto || []).join(' · '),
        csvNum(r.comm_venditore), csvNum(r.comm_setter)])),
  }),
  incassiTutti: () => ({
    nome: 'incassi_tutti.csv',
    righe: [['ID incasso', 'Centro', 'Consulente', 'Data incasso', 'Scadenza', 'Importo', 'Rata n°', 'Incassata', 'Metodo', 'Tipo contratto']]
      .concat(incassi().map(r => [
        r.id_incasso, r.centro, r.consulente, r.data_incasso, r.data_scadenza,
        csvNum(r.importo), csvNum(r.rata_numero), incassata(r) ? 'sì' : 'no', r.metodo,
        (r.tipo_contratto || []).join(' · ')])),
  }),
  insolute: () => ({
    nome: 'rate_insolute_' + MESE + '.csv',
    righe: [['Centro', 'Scadenza', 'Giorni di ritardo', 'Importo', 'Rata n°', 'Consulente', 'Venditore']]
      .concat(insolute(MESE).righe.map(r => [
        r.centro, r.data_scadenza, giorniRitardo(r.data_scadenza), csvNum(r.importo),
        csvNum(r.rata_numero), r.consulente, r.venditore])),
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
        riga('Cash incassato', d => d.lordi),
        riga('di cui prime rate (nuovi clienti)', d => d.s.nuovi),
        riga('di cui rate', d => d.s.rate),
        riga('di cui rinnovi', d => d.s.rinnovi),
        riga('di cui upsell', d => d.s.upsell),
        riga('Rimborsi', d => d.rimborsi),
        riga('Ricavi netti', d => d.ricaviNetti),
        riga('Commissioni', d => d.cm.comm.tot),
        riga('Altri costi diretti', d => d.cm.cat.Diretti),
        riga('Margine lordo', d => d.margineLordo),
        riga('Costi operativi', d => d.cm.cat.Operativi),
        riga('Margine operativo', d => d.margineOp),
        riga('Costi strutturali', d => d.cm.cat.Strutturali),
        riga('EBITDA', d => d.ebitda),
        riga('Investimenti e asset', d => d.cm.capex),
        riga('Cash flow', d => d.cashFlow),
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
        <li><b>Insolute (&gt;7gg)</b>: due letture diverse. La <b>tile</b> e la tabella "mese per mese" guardano solo
          le rate con DATA SCADENZA <i>in quel mese</i>: quanto è scaduto e quanto di quello non è ancora entrato.
          La <b>lista di recupero</b> in fondo è invece cumulativa, dall'inizio a oggi. In entrambe una rata conta
          come scaduta solo dopo 7 giorni (tolleranza per bonifici e addebiti in viaggio) e lo stato pagato/non
          pagato è sempre quello di <i>oggi</i>: scegliendo un mese passato non si ricostruisce la fotografia di allora.</li>
        <li><b>Commissioni</b>: formule di Notion sulla singola rata (venditore 10%, setter 5%, PM/MB/BS sui rinnovi),
          sommate sugli incassi del mese. Non sono stime.</li>
        <li><b>Costi</b>: registro interno (tab Costi). Una voce mensile conta da <i>data inizio</i> in poi,
          una annua nello stesso mese di ogni anno, una tantum solo nel suo mese.</li>
        <li><b>EBITDA</b>: ricavi netti − costi correnti − commissioni, <b>esclusi</b> investimenti e asset.
          <b>Cash flow / margine netto</b>: EBITDA meno gli investimenti.</li>
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
