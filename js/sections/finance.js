// manager-stats · Sezione Finance — dashboard generale (solo admin)
//
// Fonte: fin_incassi (1 riga = 1 rata, da Notion 🏦 DATABASE INCASSI) e
// fin_contratti (1 riga = 1 contratto, da Notion DATABASE VALORE CONTRATTI),
// sync WF-M7 orario. Le tabelle sono leggibili SOLO dagli admin (RLS ms_puo).
//
// La vista è MENSILE come il CFO Cockpit: la barra filtri globale è nascosta
// (app.js) e qui c'è un selettore mese dedicato + filtro agenzia.
//
// Definizioni (stesse del prototipo CFO Cockpit, adattate ai dati Notion):
// · Incassato del mese  = somma IMPORTO RATA con DATA INCASSO nel mese
// · Nuovi clienti       = incassi il cui contratto è stato creato nello stesso mese
//                         (join via ID CONTRATTO) e non è RINNOVO/UPSELL
// · Rinnovi / Upsell    = tag esatto 'RINNOVO' / 'UPSELL' in TIPO DI CONTRATTO
//                         (⚠️ match sull'elemento, non substring: esiste anche
//                         "CONTRATTO TERMINATO CON RINNOVO" che NON è un rinnovo)
// · Contrattualizzato   = somma VALORE CONTRATTO dei contratti creati nel mese
// · Rate da incassare   = rate con scadenza nel mese e non ancora incassate
// · Insolute (>7gg)     = rate scadute da oltre 7 giorni e mai incassate,
//                         cumulate su tutte le mensilità fino al mese selezionato
import { supabase } from '../supabase.js';
import { fetchAll } from '../data.js';
import { renderTable, renderKpiGroups } from '../tables.js';
import { renderLineChart } from '../charts.js';
import { fmt, eur, pct, fmtPct, pctFrac, safeDiv, dstr, todayRome, esc } from '../format.js';

let DATA = null;          // { incassi, contratti } grezzi (già filtrati dalla RLS)
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

let MESE = dstr(todayRome()).slice(0, 7);   // default: mese corrente (Europe/Rome)
let AGENZIA = '';                                    // '' = tutte
let centroSort = { key: 'incassato', dir: -1 };
let contrattiSort = { key: 'valore', dir: -1 };
let insSort = { key: 'data_scadenza', dir: 1 };

// ── caricamento ──────────────────────────────────────────────────────────────
async function buildData() {
  const [incassi, contratti, centri] = await Promise.all([
    fetchAll((lo, hi) => supabase.from('fin_incassi')
      .select('id_incasso,id_contratto,centro,consulente,agenzia,tipo_contratto,venditore,data_incasso,data_scadenza,importo,rata_numero,pagato,metodo')
      .range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('fin_contratti')
      .select('nome_centro,id_contratto,valore,stato,durata,agenzia,venditore,creazione_contratto')
      .range(lo, hi)),
    // anagrafica clienti: serve per churn (DATA CLIENTE PERSO) e riempimento team.
    // Select dedicato e non loadCentri: colonne diverse e niente cache condivisa.
    fetchAll((lo, hi) => supabase.from('centri')
      .select('nome,agenzia,stato_attivita,consulente,data_cliente_perso')
      .range(lo, hi)),
  ]);
  return { incassi, contratti, centri };
}

// ── filtri e definizioni ─────────────────────────────────────────────────────
const hasTag = (arr, tag) => Array.isArray(arr) && arr.indexOf(tag) !== -1;
const inAg = r => !AGENZIA || hasTag(r.agenzia, AGENZIA);
const incassi = () => DATA.incassi.filter(inAg);
const contratti = () => DATA.contratti.filter(inAg);
const centriRows = () => (DATA.centri || []).filter(inAg);
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

// ── KPI ──────────────────────────────────────────────────────────────────────
function renderKPI() {
  const byId = contrattiById();
  // mese in corso = confronto ad armi pari: il mese prima viene tagliato allo
  // stesso giorno (1–3 ago vs 1–3 lug), altrimenti a inizio mese il delta
  // sarebbe sempre un -90% senza senso. Mesi chiusi = mese pieno vs mese pieno.
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
      { label: 'Costi del mese', value: '—', sub: 'fonte costi non ancora collegata' },
      { label: 'Margine netto', value: '—', sub: 'incassato − costi − rimborsi: serve la fonte costi' },
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
  const { months, rows } = trendRows();
  renderLineChart(_mount.querySelector('#fnTrend'), months, rows, [
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
  const rows = centroRows();
  const el = _mount.querySelector('#fnCentri');
  if (!rows.length) { el.innerHTML = '<div class="status">Nessun incasso nel mese selezionato.</div>'; return; }
  renderTable(el, centroCols, rows, centroSort,
    k => { centroSort = { key: k, dir: centroSort.key === k ? -centroSort.dir : -1 }; renderCentri(); },
    { barKey: 'incassato' });
}

// ── tabella: contratti firmati nel mese ──────────────────────────────────────
const contrattiCols = [
  { key: 'nome_centro', label: 'Centro' },
  { key: 'creazione_contratto', label: 'Firmato il', fmt: v => v ? v.split('-').reverse().join('/') : '—' },
  { key: 'valore', label: 'Valore', fmt: eur },
  { key: 'statoTxt', label: 'Tipo / stato', fmt: v => esc(v || '—') },
  { key: 'durataTxt', label: 'Durata (gg)', fmt: v => esc(v || '—') },
  { key: 'venditore', label: 'Venditore', fmt: v => esc(v || '—') },
];

function renderContratti() {
  const rows = contratti()
    .filter(c => ymOf(c.creazione_contratto) === MESE)
    .map(c => ({ ...c, statoTxt: (c.stato || []).join(' · '), durataTxt: (c.durata || []).join(' · ') }));
  const el = _mount.querySelector('#fnContratti');
  if (!rows.length) { el.innerHTML = '<div class="status">Nessun contratto creato nel mese selezionato.</div>'; return; }
  renderTable(el, contrattiCols, rows, contrattiSort,
    k => { contrattiSort = { key: k, dir: contrattiSort.key === k ? -contrattiSort.dir : -1 }; renderContratti(); },
    { barKey: 'valore' });
}

// ── tabella: rate insolute ───────────────────────────────────────────────────
const giorniRitardo = iso => Math.floor((todayRome() - new Date(iso + 'T00:00:00')) / 86400000);
const insCols = [
  { key: 'centro', label: 'Centro', fmt: v => esc(v || '—') },
  { key: 'data_scadenza', label: 'Scadenza', fmt: v => v ? v.split('-').reverse().join('/') : '—' },
  { key: 'ritardo', label: 'Ritardo', fmt: v => fmt(v) + ' gg' },
  { key: 'importo', label: 'Importo', fmt: eur },
  { key: 'rata_numero', label: 'Rata n°', fmt: v => v === null || v === undefined ? '—' : fmt(v) },
  { key: 'consulente', label: 'Consulente', fmt: v => esc(v || '—') },
  { key: 'venditore', label: 'Venditore', fmt: v => esc(v || '—') },
];

function renderInsolute() {
  const rows = insolute(MESE).righe.map(r => ({ ...r, ritardo: giorniRitardo(r.data_scadenza) }));
  const el = _mount.querySelector('#fnInsolute');
  if (!rows.length) { el.innerHTML = '<div class="status">Nessuna rata scaduta e non incassata. 🎉</div>'; return; }
  renderTable(el, insCols, rows, insSort,
    k => { insSort = { key: k, dir: insSort.key === k ? -insSort.dir : -1 }; renderInsolute(); });
}

// ── barra mese + agenzia ─────────────────────────────────────────────────────
function renderBar() {
  const mi = _mount.querySelector('#fnMese');
  if (mi) mi.value = MESE;
  const lab = _mount.querySelector('#fnMeseLabel');
  if (lab) lab.textContent = ymLabel(MESE);
  const chips = _mount.querySelector('#fnAgChips');
  const ags = agenzie();
  const wrap = _mount.querySelector('#fnAgWrap');
  if (wrap) wrap.classList.toggle('hidden', ags.length < 2);
  if (chips && ags.length >= 2) {
    chips.innerHTML = ['', ...ags].map(a =>
      `<button data-ag="${esc(a)}" class="${AGENZIA === a ? 'active' : ''}">${a === '' ? 'Tutte' : esc(a)}</button>`).join('');
    chips.querySelectorAll('button').forEach(b => b.onclick = () => { AGENZIA = b.dataset.ag; renderAll(); });
  }
}

function renderAll() {
  renderBar();
  renderKPI();
  renderTrend();
  renderCentri();
  renderContratti();
  renderInsolute();
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

export async function render(mount) {
  _mount = mount;
  _renderId++;
  mount.innerHTML = `
    <div class="filters" style="margin-bottom:14px">
      <span class="filter-cap">Mese</span>
      <button id="fnPrev" title="Mese precedente">‹</button>
      <input type="month" id="fnMese">
      <button id="fnNext" title="Mese successivo">›</button>
      <span id="fnAgWrap" class="hidden"><span class="filter-cap">Agenzia</span><span id="fnAgChips"></span></span>
    </div>
    <div id="fnStatus" class="status loading">Caricamento dati…</div>
    <div id="fnContent" class="hidden">
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
      </div>
    </div>`;

  mount.querySelector('#fnPrev').onclick = () => { MESE = addYm(MESE, -1); if (DATA) renderAll(); };
  mount.querySelector('#fnNext').onclick = () => { MESE = addYm(MESE, 1); if (DATA) renderAll(); };
  mount.querySelector('#fnMese').onchange = e => { if (e.target.value) { MESE = e.target.value; if (DATA) renderAll(); } };

  await load();
}

export function onResize() {
  if (DATA && _mount && _mount.querySelector('#fnTrend')) renderTrend();
}
