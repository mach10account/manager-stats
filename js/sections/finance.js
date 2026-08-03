// manager-stats · Sezione Finance — dashboard generale + gestione costi (solo admin)
//
// Fonte: fin_incassi (1 riga = 1 rata, da Notion 🏦 DATABASE INCASSI),
// fin_contratti (1 riga = 1 contratto, da Notion DATABASE VALORE CONTRATTI),
// fin_costi (voci di costo, EDITABILI qui — modello CFO Cockpit), centri
// (anagrafica: churn e riempimento team). Sync WF-M7 orario; RLS solo admin.
//
// Due tab: Dashboard (vista mensile) e Costi (registro voci per reparto).
// La barra filtri globale è nascosta (app.js); qui c'è il selettore mese.
//
// Definizioni (dal prototipo CFO Cockpit, adattate ai dati Notion):
// · Incassato del mese  = somma IMPORTO RATA con DATA INCASSO nel mese
// · Nuovi clienti       = incassi il cui contratto è stato creato nello stesso mese
//                         (join via ID CONTRATTO) e non è RINNOVO/UPSELL
// · Rinnovi / Upsell    = tag esatto 'RINNOVO' / 'UPSELL' (match sull'elemento:
//                         "CONTRATTO TERMINATO CON RINNOVO" NON è un rinnovo)
// · Contrattualizzato   = somma VALORE CONTRATTO dei contratti creati nel mese
// · Insolute (>7gg)     = rate scadute da oltre 7 giorni e mai incassate
// · Commissioni (auto)  = somma delle formule commissione Notion sugli incassi
//                         del mese (venditore 10% · setter 5% · PM/MB/BS su rinnovi)
// · Ricorrenza costi    = mensile (da `data` in poi, fino a `fine`), annua
//                         (stesso mese dell'anno), una tantum (solo quel mese)
import { supabase } from '../supabase.js';
import { fetchAll } from '../data.js';
import { renderTable, renderKpiGroups, renderKpiRow } from '../tables.js';
import { renderLineChart } from '../charts.js';
import { fmt, eur, pct, fmtPct, pctFrac, safeDiv, dstr, todayRome, esc } from '../format.js';

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

let MESE = dstr(todayRome()).slice(0, 7);   // default: mese corrente (Europe/Rome)
let AGENZIA = '';                            // '' = tutte
let TAB = 'dash';                            // 'dash' | 'costi'
let centroSort = { key: 'incassato', dir: -1 };
let contrattiSort = { key: 'valore', dir: -1 };
let insSort = { key: 'data_scadenza', dir: 1 };
const costiSort = {};                        // per reparto

// ── caricamento ──────────────────────────────────────────────────────────────
async function buildData() {
  const [incassi, contratti, centri, costi] = await Promise.all([
    fetchAll((lo, hi) => supabase.from('fin_incassi')
      .select('id_incasso,id_contratto,centro,consulente,agenzia,tipo_contratto,venditore,data_incasso,data_scadenza,importo,rata_numero,pagato,metodo,comm_venditore,comm_setter,comm_pm,comm_mb,comm_bs')
      .range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('fin_contratti')
      .select('nome_centro,id_contratto,valore,stato,durata,agenzia,venditore,creazione_contratto')
      .range(lo, hi)),
    // anagrafica clienti: churn (DATA CLIENTE PERSO) e riempimento team.
    fetchAll((lo, hi) => supabase.from('centri')
      .select('nome,agenzia,stato_attivita,consulente,data_cliente_perso')
      .range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('fin_costi').select('*').range(lo, hi)),
  ]);
  return { incassi, contratti, centri, costi };
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

// ── costi: ricorrenza e commissioni ──────────────────────────────────────────
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
// (e nel margine netto) ma NON nell'EBITDA.
function costiMese(m) {
  const occ = costi().filter(c => costOccurs(c, m));
  const rimborsi = sumImporti(occ.filter(c => (c.sottocategoria || '') === 'Rimborsi'));
  const voci = occ.filter(c => (c.sottocategoria || '') !== 'Rimborsi');
  const manuali = sumImporti(voci);
  const capex = sumImporti(voci.filter(c => c.categoria === 'Asset' || c.categoria === 'Investimenti'));
  const comm = commissioniMese(m);
  return { occ, manuali, capex, rimborsi, comm, tot: manuali + rimborsi + comm.tot };
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

  // costi reali dal registro + commissioni → margine, EBITDA e ROI.
  // EBITDA (per cassa): incassato netto − costi correnti − commissioni,
  // ESCLUSI investimenti/asset (capex); interessi e tasse non sono nel registro.
  const cm = costiMese(MESE);
  const margine = s.tot - cm.tot;
  const roi = cm.tot > 0 ? margine / cm.tot : null;
  const ricaviNetti = s.tot - cm.rimborsi;
  const ebitda = ricaviNetti - (cm.manuali - cm.capex) - cm.comm.tot;
  const pctEbitda = ricaviNetti > 0 ? ebitda / ricaviNetti : null;

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
      { label: 'EBITDA', value: eur(ebitda), tone: ebitda >= 0 ? 'good' : 'bad',
        sub: (pctEbitda !== null ? pctFrac(pctEbitda) + " dell'incassato netto · " : '')
          + 'esclusi investimenti e asset' + (cm.capex > 0 ? ' (' + eur(cm.capex) + ')' : '') },
      { label: 'Margine netto', value: eur(margine), tone: margine >= 0 ? 'good' : 'bad',
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

function renderAll() {
  renderBar();
  if (TAB === 'costi') renderCostiPage();
  else renderDash();
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
      status.textContent = 'Nessun dato finance disponibile (il sync gira ogni ora al minuto 50).';
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
  TAB = params && params.get && params.get('tab') === 'costi' ? 'costi' : 'dash';
  mount.innerHTML = `
    <div class="filters" style="margin-bottom:8px">
      <span class="filter-cap">Mese</span>
      <button id="fnPrev" title="Mese precedente">‹</button>
      <input type="month" id="fnMese">
      <button id="fnNext" title="Mese successivo">›</button>
      <span id="fnAgWrap" class="hidden"><span class="filter-cap">Agenzia</span><span id="fnAgChips"></span></span>
    </div>
    <div class="lead-tabs" id="fnTabs" style="margin-bottom:12px">
      <button data-tab="dash">Dashboard</button>
      <button data-tab="costi">Costi</button>
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
    history.replaceState(null, '', '#/finance' + (TAB === 'costi' ? '?tab=costi' : ''));
    if (DATA) renderAll();
  });

  await load();
}

export function onResize() {
  if (DATA && _mount && _mount.querySelector('#fnTrend')) renderTrend();
}
