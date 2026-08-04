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
// · Nuovi clienti       = incassi il cui contratto è stato creato nello stesso mese
//                         (join via ID CONTRATTO) e non è RINNOVO/UPSELL
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
import { fmt, fmt1, eur, pct, fmtPct, pctFrac, safeDiv, dstr, todayRome, esc } from '../format.js';

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
  ['dash', 'Dashboard'], ['costi', 'Costi'], ['pnl', 'P&L'],
  ['delivery', 'Delivery'], ['clienti', 'Clienti & LTV'], ['report', 'Report'],
];
let centroSort = { key: 'incassato', dir: -1 };
let contrattiSort = { key: 'valore', dir: -1 };
let insSort = { key: 'data_scadenza', dir: 1 };
let pmSort = { key: 'gestiti', dir: -1 };
let ltvSort = { key: 'incassato', dir: -1 };
const costiSort = {};                        // per reparto

// ── caricamento ──────────────────────────────────────────────────────────────
async function buildData() {
  const [incassi, contratti, centri, costi] = await Promise.all([
    fetchAll((lo, hi) => supabase.from('fin_incassi')
      .select('id_incasso,id_contratto,centro,consulente,agenzia,tipo_contratto,venditore,data_incasso,data_scadenza,importo,rata_numero,pagato,metodo,comm_venditore,comm_setter,comm_pm,comm_mb,comm_bs')
      .range(lo, hi)),
    // mirror del DATABASE CONTRATTI di Notion: 1 riga = 1 contratto vero.
    // (fin_contratti nasceva da VALORE CONTRATTI e contava anche righe senza contratto)
    fetchAll((lo, hi) => supabase.from('v_notion_contratti')
      .select('nome_centro,id_contratto,valore,stato,durata,agenzia,venditore,creazione_contratto')
      .range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('centri')
      .select('nome,agenzia,stato_attivita,consulente,beauty,data_cliente_perso,inizio_servizio,fine_servizio,data_rinnovo')
      .range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('fin_costi').select('*').range(lo, hi)),
  ]);
  // dal mirror il venditore arriva come array e il valore come numeric (stringa via
  // PostgREST): qui li riporto alle forme che il resto della sezione si aspetta.
  const contrattiNorm = contratti.map(c => ({
    ...c,
    valore: (c.valore === null || c.valore === undefined) ? null : Number(c.valore),
    venditore: Array.isArray(c.venditore) ? c.venditore.join(', ') : c.venditore,
  }));
  return { incassi, contratti: contrattiNorm, centri, costi };
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

function contrattiById() {
  const m = new Map();
  for (const c of DATA.contratti) if (c.id_contratto && !m.has(c.id_contratto)) m.set(c.id_contratto, c);
  return m;
}

function centriByNome() {
  const m = new Map();
  for (const c of centriRows()) if (c.nome) m.set(chiave(c.nome), c);
  return m;
}

// incassato del mese, spezzato in nuovi / rate / rinnovi / upsell.
// maxDay ('03'…'31'): considera solo i giorni 1..maxDay — serve per confrontare
// un mese in corso con la STESSA porzione del mese precedente.
function splitIncassato(m, byId, maxDay) {
  const t = { tot: 0, n: 0, nuovi: 0, rate: 0, rinnovi: 0, upsell: 0, nuoviIds: new Set() };
  for (const r of incassi()) {
    if (ymOf(r.data_incasso) !== m) continue;
    if (maxDay && r.data_incasso.slice(8, 10) > maxDay) continue;
    const imp = +r.importo || 0;
    t.tot += imp; t.n += 1;
    if (hasTag(r.tipo_contratto, 'RINNOVO')) t.rinnovi += imp;
    else if (hasTag(r.tipo_contratto, 'UPSELL')) t.upsell += imp;
    else {
      const c = r.id_contratto ? byId.get(r.id_contratto) : null;
      if (c && ymOf(c.creazione_contratto) === m) { t.nuovi += imp; t.nuoviIds.add(r.id_contratto); }
      else t.rate += imp;
    }
  }
  return t;
}

function contrattualizzato(m, maxDay) {
  const t = { tot: 0, n: 0, rinnovi: 0, rinnoviVal: 0, upsell: 0, nuovi: 0, nuoviVal: 0 };
  for (const c of contratti()) {
    if (ymOf(c.creazione_contratto) !== m) continue;
    if (maxDay && c.creazione_contratto.slice(8, 10) > maxDay) continue;
    const v = +c.valore || 0;
    t.tot += v; t.n += 1;
    if (hasTag(c.stato, 'RINNOVO')) { t.rinnovi += 1; t.rinnoviVal += v; }
    else if (hasTag(c.stato, 'UPSELL')) t.upsell += 1;
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

// rate scadute da oltre 7 giorni e mai incassate, fino a fine mese selezionato
function insolute(m) {
  const oggi = todayRome();
  oggi.setDate(oggi.getDate() - 7);
  const cut = dstr(oggi) < fineMese(m) ? dstr(oggi) : fineMese(m);
  const t = { scadute: 0, nonIncassate: 0, nScadute: 0, righe: [] };
  for (const r of incassi()) {
    if (!r.data_scadenza || r.data_scadenza > cut) continue;
    const imp = +r.importo || 0;
    t.scadute += imp; t.nScadute += 1;
    if (!incassata(r)) { t.nonIncassate += imp; t.righe.push(r); }
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
  const byId = contrattiById();
  const s = splitIncassato(m, byId);
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

// ── KPI dashboard ────────────────────────────────────────────────────────────
function renderKPI() {
  const byId = contrattiById();
  // mese in corso = confronto ad armi pari: il mese prima viene tagliato allo
  // stesso giorno (1–3 ago vs 1–3 lug). Mesi chiusi = mese pieno vs mese pieno.
  const oggi = dstr(todayRome());
  const maxDay = MESE === oggi.slice(0, 7) ? oggi.slice(8, 10) : null;
  const s = splitIncassato(MESE, byId);
  const sPrev = splitIncassato(addYm(MESE, -1), byId, maxDay);
  const c = contrattualizzato(MESE);
  const cPrev = contrattualizzato(addYm(MESE, -1), maxDay);
  const sc = scadenze(MESE);
  const ins = insolute(MESE);
  const insPct = pct(ins.nonIncassate, ins.scadute);
  const rif = maxDay ? 'sui giorni 1–' + (+maxDay) + ' del mese prima' : 'sul mese prima';
  const delta = (cur, prev) => prev > 0
    ? (cur >= prev ? '+' : '') + fmt(100 * (cur - prev) / prev) + '% ' + rif + ' (' + eur(prev) + ')'
    : null;

  // commerciale: churn da DATA CLIENTE PERSO · azienda: riempimento come il Cockpit
  const persiMese = centriRows().filter(x => x.data_cliente_perso && ymOf(x.data_cliente_perso) === MESE).length;
  const CAP_PM = 35;
  const gestiti = centriRows().filter(isGestito);
  const nPM = new Set(gestiti.map(x => x.consulente).filter(Boolean)).size;
  const riemp = nPM > 0 ? gestiti.length / (nPM * CAP_PM) : null;

  const p = pnl(MESE);
  const cm = p.cm;
  const roi = cm.tot > 0 ? p.cashFlow / cm.tot : null;

  renderKpiGroups(_mount.querySelector('#fnKpi'), [
    { step: 1, title: 'Incassato', tiles: [
      { label: 'Incassato del mese', value: eur(s.tot), hero: true, sub: delta(s.tot, sPrev.tot) || (fmt(s.n) + ' rate incassate') },
      { label: 'Nuovi clienti', value: eur(s.nuovi), sub: 'contratti firmati nel mese' },
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
      { label: 'Insolute (>7gg)', value: fmtPct(insPct), tone: ins.nonIncassate > 0 ? 'bad' : 'good',
        sub: eur(ins.nonIncassate) + ' mai incassati su ' + eur(ins.scadute) + ' di rate scadute da oltre 7 giorni, fino a ' + ymLabel(MESE) },
    ] },
    { step: 4, title: 'Commerciale', tiles: [
      { label: 'Nuovi clienti', value: fmt(c.nuovi), hero: true, sub: 'contratti nuovi creati nel mese' },
      { label: 'Clienti rinnovati', value: fmt(c.rinnovi), sub: 'contratti di rinnovo creati nel mese' },
      { label: 'Upsell effettuati', value: fmt(c.upsell) },
      { label: 'Clienti persi', value: fmt(persiMese), tone: persiMese > 0 ? 'bad' : 'good',
        sub: 'segnati persi su Notion nel mese (churn)' },
      { label: 'Ticket medio nuovi', value: eur(safeDiv(c.nuoviVal, c.nuovi)), sub: 'valore medio dei contratti nuovi' },
      { label: 'Ticket medio incassato nuovi', value: eur(safeDiv(s.nuovi, s.nuoviIds.size)),
        sub: s.nuoviIds.size + ' nuovi clienti paganti nel mese' },
    ] },
    { step: 5, title: 'Azienda', tiles: [
      { label: 'Riempimento team', value: riemp === null ? '—' : pctFrac(riemp), hero: true,
        tone: riemp === null ? undefined : (riemp >= 0.95 ? 'bad' : (riemp >= 0.75 ? undefined : 'good')),
        sub: fmt(gestiti.length) + ' aziende gestite ÷ (' + nPM + ' PM × ' + CAP_PM + ' clienti)' },
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
  return { months, rows: months.map(m => ({ incassato: inc.get(m), contrattualizzato: con.get(m), n: nCon.get(m) })) };
}

function renderTrend() {
  const el = _mount.querySelector('#fnTrend');
  if (!el) return;
  const { months, rows } = trendRows();
  renderLineChart(el, months, rows, [
    { key: 'incassato', color: '--series-1', name: 'Incassato' },
    { key: 'contrattualizzato', color: '--series-2', name: 'Contrattualizzato' },
  ], {
    xlab: ymShort, yfmt: eur, height: 280,
    tip: (r, m) => `<div class="t-date">${ymLabel(m)}</div>
      <div class="t-row"><span>Incassato</span><b>${eur(r.incassato)}</b></div>
      <div class="t-row"><span>Contrattualizzato</span><b>${eur(r.contrattualizzato)}</b></div>
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
    <div class="subtitle">Ultimi 12 mesi fino a <span id="fnMeseLabel"></span>: incassato (per data incasso)
      e contrattualizzato (per data di creazione del contratto).</div>
    <div class="legend">
      <span class="key"><span class="swatch" style="background:var(--series-1)"></span>Incassato</span>
      <span class="key"><span class="swatch" style="background:var(--series-2)"></span>Contrattualizzato</span>
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
    <h2>Rate scadute e non incassate</h2>
    <div class="subtitle">Tutte le rate scadute da <strong>oltre 7 giorni</strong> e mai incassate,
      fino alla fine del mese selezionato: è la lista da lavorare per recuperare gli insoluti.</div>
    <div class="table-scroll"><table id="fnInsolute"></table></div>
  </div>`;

function renderDash() {
  _mount.querySelector('#fnContent').innerHTML = DASH_HTML;
  const lab = _mount.querySelector('#fnMeseLabel');
  if (lab) lab.textContent = ymLabel(MESE);
  renderKPI();
  renderTrend();
  renderCentri();
  renderContratti();
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

  const topCosti = [['Commissioni vendita (auto)', cm.comm.tot]]
    .concat(cm.occ.filter(c => +c.importo > 0).map(c =>
      [c.descrizione + (c.sottocategoria ? ' · ' + c.sottocategoria : ''), +c.importo]))
    .filter(x => x[1] > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const maxCosto = topCosti.length ? topCosti[0][1] : 1;

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
          ${riga('di cui: nuovi clienti', x => x.s.nuovi, { indent: true })}
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
      <div class="subtitle">Le 12 voci più pesanti del mese, commissioni incluse.</div>
      ${topCosti.length ? topCosti.map(([l, v]) => `
        <div class="esito-row">
          <div class="esito-top"><span class="lbl">${esc(l)}</span>
            <span class="val"><b>${eur(v)}</b> · ${fmtPct(pct(v, cm.tot))}</span></div>
          <div class="esito-track"><div class="esito-fill" style="width:${Math.max(2, Math.round(100 * v / maxCosto))}%;background:var(--series-1)"></div></div>
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

// ── tab Delivery ─────────────────────────────────────────────────────────────
const CAP_PM = 35;

// una riga per PM (consulente) con il suo carico e i suoi rinnovi
function deliveryPerPm() {
  const perNome = centriByNome();
  const m = new Map();
  const get = k => {
    let a = m.get(k);
    if (!a) { a = { pm: k, gestiti: 0, onboarding: 0, attesaRinnovo: 0, persi12m: 0, rinnovi: 0, incassato: 0 }; m.set(k, a); }
    return a;
  };
  const limite12m = addYm(dstr(todayRome()).slice(0, 7), -11) + '-01';

  for (const c of centriRows()) {
    const k = c.consulente || '(non assegnato)';
    const a = get(k);
    if (isGestito(c)) {
      a.gestiti += 1;
      if (hasTag(c.stato_attivita, 'ONBOARDING')) a.onboarding += 1;
      if (hasTag(c.stato_attivita, 'IN ATTESA DI RINNOVO')) a.attesaRinnovo += 1;
    }
    if (c.data_cliente_perso && c.data_cliente_perso >= limite12m) a.persi12m += 1;
  }
  // rinnovi e incassato si attribuiscono al PM del centro (join per nome)
  for (const c of contratti()) {
    if (!hasTag(c.stato, 'RINNOVO')) continue;
    const an = perNome.get(chiave(c.nome_centro));
    get(an && an.consulente ? an.consulente : '(non assegnato)').rinnovi += 1;
  }
  for (const r of incassi()) {
    if (ymOf(r.data_incasso) !== MESE) continue;
    const an = perNome.get(chiave(r.centro));
    const k = (an && an.consulente) || r.consulente || '(non assegnato)';
    get(k).incassato += (+r.importo || 0);
  }
  return [...m.values()].map(a => {
    a.saturazione = a.gestiti / CAP_PM * 100;
    a.perCliente = a.gestiti > 0 ? a.incassato / a.gestiti : null;
    return a;
  });
}

const pmCols = [
  { key: 'pm', label: 'Project manager' },
  { key: 'gestiti', label: 'Clienti gestiti', fmt },
  { key: 'saturazione', label: 'Saturazione', fmt: v => fmtPct(v) },
  { key: 'onboarding', label: 'In onboarding', fmt },
  { key: 'attesaRinnovo', label: 'In attesa rinnovo', fmt },
  { key: 'rinnovi', label: 'Rinnovi firmati', fmt },
  { key: 'persi12m', label: 'Persi (12 mesi)', fmt },
  { key: 'incassato', label: 'Incassato del mese', fmt: eur },
];

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
  const righe = deliveryPerPm().filter(r => r.gestiti > 0 || r.rinnovi > 0 || r.incassato > 0);
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

    <div class="card">
      <h2>Carico per project manager</h2>
      <div class="subtitle">Clienti in gestione (tutti gli stati tranne CLIENTE PERSO/SPARITO) e saturazione
        sulla capienza di riferimento di ${CAP_PM} clienti per PM. Rinnovi e incassato sono attribuiti
        al PM del centro (join per nome del centro).</div>
      <div class="table-scroll"><table id="fnPm"></table></div>
    </div>

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
    { label: 'Media per PM', value: fmt1(safeDiv(gestiti, nPM)), sub: 'capienza di riferimento ' + CAP_PM },
    { label: 'Costo team delivery', value: eur(costoTeam), sub: teamDel.length + ' persone/voci nel mese' },
    { label: 'Costo per cliente', value: eur(safeDiv(costoTeam, gestiti)), sub: 'solo team delivery' },
    { label: 'Tasso di rinnovo 12 mesi', value: fmtPct(pct(rinTot, rinTot + persiTot)),
      sub: rinTot + ' rinnovi su ' + (rinTot + persiTot) + ' esiti' },
    { label: 'Churn medio mensile', value: churnMedio === null ? '—' : fmtPct(churnMedio),
      sub: 'sui clienti in gestione' },
  ]);

  renderTable(_mount.querySelector('#fnPm'), pmCols, righe, pmSort,
    k => { pmSort = { key: k, dir: pmSort.key === k ? -pmSort.dir : -1 }; renderDelivery(); },
    { barKey: 'gestiti' });

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
        riga('di cui nuovi clienti', d => d.s.nuovi),
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
          (DATABASE VALORE CONTRATTI), per data di creazione.</li>
        <li><b>Nuovi / rate / rinnovi / upsell</b>: un incasso è "nuovo cliente" se il suo contratto è stato creato
          nello stesso mese; rinnovi e upsell seguono il tag esatto sul contratto.</li>
        <li><b>Commissioni</b>: formule di Notion sulla singola rata (venditore 10%, setter 5%, PM/MB/BS sui rinnovi),
          sommate sugli incassi del mese. Non sono stime.</li>
        <li><b>Costi</b>: registro interno (tab Costi). Una voce mensile conta da <i>data inizio</i> in poi,
          una annua nello stesso mese di ogni anno, una tantum solo nel suo mese.</li>
        <li><b>EBITDA</b>: ricavi netti − costi correnti − commissioni, <b>esclusi</b> investimenti e asset.
          <b>Cash flow / margine netto</b>: EBITDA meno gli investimenti.</li>
        <li><b>Clienti persi</b>: DATA CLIENTE PERSO su Notion DATABASE CLIENTI, nel mese.</li>
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
  dash: renderDash, costi: renderCostiPage, pnl: renderPnl,
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
  if (DATA && _mount && _mount.querySelector('#fnTrend')) renderTrend();
}
