// manager-stats · Sezione Chiamate — port del dashboard call-center (adapter DATA su Supabase)
import { supabase } from '../supabase.js';
import { fetchAll, loadFreshness } from '../data.js';
import { getFilters } from '../filters.js';
import { renderTable, renderKpiRow } from '../tables.js';
import { renderLineChart, renderBarChart } from '../charts.js';
import { openEsiti } from '../modal.js';
import { fmt, fmt1, fmtMin, pct, fmtPct, dlab, nextDay } from '../format.js';

let DATA = null;
let MODE = 'chiamata';            // 'chiamata' | 'inserimento'
let setterSort = { key: 'chiamate', dir: -1 };
let centroSort = { key: 'chiamate', dir: -1 };
let centroFilter = '';
let _mount = null;
let _renderId = 0;                // invalidato a ogni render(): scarta i load obsoleti

// ── adapter: ricostruisce l'oggetto DATA dai query diretti alle viste ────────
async function buildData(from, to, mode) {
  const chiamata = mode === 'chiamata';
  const setterView = chiamata ? 'agg_setter_giorno' : 'agg_coorte_setter_giorno';
  const centroView = chiamata ? 'agg_centro_giorno' : 'agg_coorte_centro_giorno';
  const [aggSetter, aggCentro, distribuzione, aggiornato_a, clientiAttivi, leadUnici] = await Promise.all([
    fetchAll((lo, hi) => supabase.from(setterView).select('*').gte('giorno', from).lte('giorno', to).range(lo, hi)),
    fetchAll((lo, hi) => supabase.from(centroView).select('*').gte('giorno', from).lte('giorno', to).range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('lead_call_distribution').select('*').range(lo, hi)),
    loadFreshness().catch(() => null),
    supabase.rpc('api_clienti_attivi', { p_from: from, p_to: to })
      .then(r => { if (r.error) throw r.error; return r.data; })
      .catch(() => null),                     // spesa ads assente → tile "—", mai blocco sezione
    chiamata                                  // lead UNICI del periodo (count distinct sull'intera finestra)
      ? supabase.rpc('api_lead_unici', { p_from: from, p_to: to })
          .then(r => { if (r.error) throw r.error; return r.data; })
          .catch(() => null)                  // RPC assente/errore → fallback somma-giorni nelle tabelle
      : Promise.resolve(null),
  ]);
  return { from, to, mode, aggiornato_a, aggSetter, aggCentro, distribuzione, clientiAttivi, leadUnici };
}

// mappe (operator_id / campaign_id → lead unici) dalla RPC api_lead_unici
function uniqMaps() {
  const u = { setter: new Map(), centro: new Map(), totale: null };
  for (const r of (DATA.leadUnici || [])) {
    if (r.dim === 'totale') u.totale = +r.lead_unici;
    else if (u[r.dim]) u[r.dim].set(r.id, +r.lead_unici);
  }
  return u;
}

// ── aggregazioni (per data chiamata) ─────────────────────────────────────────
function totals() {
  const t = { chiamate: 0, risposte: 0, appuntamenti: 0, acconti: 0, talk: 0 };
  const leadDays = {};
  for (const r of DATA.aggSetter) {
    t.chiamate += r.chiamate; t.risposte += r.risposte;
    t.appuntamenti += r.appuntamenti; t.acconti += (r.acconti_pagati || 0);
    t.talk += (r.talk_sec || 0);
    leadDays[r.giorno] = (leadDays[r.giorno] || 0) + r.lead_lavorati;
  }
  const days = Object.keys(leadDays).length;
  t.leadGiorno = days ? Object.values(leadDays).reduce((a, b) => a + b, 0) / days : 0;
  t.giorniAttivi = days;
  t.leadUnici = uniqMaps().totale;            // null se la RPC non ha risposto → tile "—"
  return t;
}
function bySetter() {
  const uniq = uniqMaps();
  const m = {};
  for (const r of DATA.aggSetter) {
    const k = r.setter;
    if (!m[k]) m[k] = { setter: k, _dim: 'setter', _id: r.operator_id, chiamate: 0, risposte: 0, appuntamenti: 0, acconti: 0, leadGG: 0, talk: 0, giorni: 0 };
    m[k].chiamate += r.chiamate; m[k].risposte += r.risposte;
    m[k].appuntamenti += r.appuntamenti; m[k].acconti += (r.acconti_pagati || 0);
    m[k].leadGG += r.lead_lavorati; m[k].talk += (r.talk_sec || 0);   // leadGG = somma dei distinti PER GIORNO (per la media Lead/giorno)
    if (r.chiamate > 0) m[k].giorni += 1;
  }
  return Object.values(m).map(s => ({
    ...s,
    // Lead gestiti = lead UNICI nel periodo (richiami non contano); fallback somma-giorni se RPC assente
    lead: DATA.leadUnici ? (uniq.setter.get(s._id) ?? 0) : s.leadGG,
    chGiorno: s.giorni ? s.chiamate / s.giorni : 0,
    leadGiorno: s.giorni ? s.leadGG / s.giorni : 0,
    tassoRisp: pct(s.risposte, s.chiamate),
    conv: pct(s.appuntamenti, s.chiamate),
  }));
}
function byCentro() {
  const uniq = uniqMaps();
  const m = {};
  for (const r of DATA.aggCentro) {
    const k = r.centro;
    if (!m[k]) m[k] = { centro: k, _dim: 'centro', _id: r.campaign_id, chiamate: 0, risposte: 0, appuntamenti: 0, acconti: 0, leadGG: 0 };
    m[k].chiamate += r.chiamate; m[k].risposte += r.risposte;
    m[k].appuntamenti += r.appuntamenti; m[k].acconti += (r.acconti_pagati || 0);
    m[k].leadGG += r.lead_lavorati;
  }
  return Object.values(m).map(c => {
    const lead = DATA.leadUnici ? (uniq.centro.get(c._id) ?? 0) : c.leadGG;   // lead unici nel periodo
    return {
      ...c,
      lead,
      chPerLead: lead > 0 ? c.chiamate / lead : null,
      conv: pct(c.appuntamenti, c.chiamate),
    };
  });
}

// ── aggregazioni COORTE (per data inserimento) ───────────────────────────────
function totalsCoorte() {
  const t = { lead: 0, appuntamenti: 0, risposte: 0, male: 0, accP: 0, accNP: 0 };
  for (const r of DATA.aggSetter) {
    t.lead += r.lead_totali; t.appuntamenti += r.appuntamenti; t.risposte += r.risposte;
    t.male += (r.lavorati_male || 0); t.accP += (r.acconti_pagati || 0); t.accNP += (r.acconti_non_pagati || 0);
  }
  return t;
}
function bySetterCoorte() {
  const m = {};
  for (const r of DATA.aggSetter) {
    const k = r.setter;
    if (!m[k]) m[k] = { setter: k, _dim: 'setter', _id: r.operator_id, lead: 0, appuntamenti: 0, risposte: 0, male: 0, accP: 0, accNP: 0 };
    m[k].lead += r.lead_totali; m[k].appuntamenti += r.appuntamenti; m[k].risposte += r.risposte;
    m[k].male += (r.lavorati_male || 0); m[k].accP += (r.acconti_pagati || 0); m[k].accNP += (r.acconti_non_pagati || 0);
  }
  return Object.values(m).map(s => ({
    ...s,
    appTot: pct(s.appuntamenti, s.lead),
    appRisp: pct(s.appuntamenti, s.risposte),
    tassoRisp: pct(s.risposte, s.lead),
    malePct: pct(s.male, s.lead),
    accPresi: pct(s.accP, s.accP + s.accNP),
  }));
}
function byCentroCoorte() {
  const m = {};
  for (const r of DATA.aggCentro) {
    const k = r.centro;
    if (!m[k]) m[k] = { centro: k, _dim: 'centro', _id: r.campaign_id, lead: 0, appuntamenti: 0, risposte: 0, male: 0 };
    m[k].lead += r.lead_totali; m[k].appuntamenti += r.appuntamenti; m[k].risposte += r.risposte;
    m[k].male += (r.lavorati_male || 0);
  }
  return Object.values(m).map(c => ({
    ...c,
    appTot: pct(c.appuntamenti, c.lead),
    appRisp: pct(c.appuntamenti, c.risposte),
    tassoRisp: pct(c.risposte, c.lead),
    malePct: pct(c.male, c.lead),
  }));
}

// ── KPI ──────────────────────────────────────────────────────────────────────
function renderKPI() {
  const el = _mount.querySelector('#chKpi');
  const ca = DATA.clientiAttivi;
  const caTile = (ca && ca.giorni_con_dati)
    ? { label: 'Clienti attivi (ads)', value: fmt(ca.n_clienti), sub: 'spesa >1 € nel periodo · media ' + fmt1(ca.media_giorno) + ' al giorno' }
    : { label: 'Clienti attivi (ads)', value: '—', sub: 'nessun dato spesa nel periodo' };
  if (MODE === 'inserimento') {
    const t = totalsCoorte();
    renderKpiRow(el, [
      { label: 'Totale Lead', value: fmt(t.lead), sub: 'inseriti nel periodo' },
      { label: 'Appuntamenti', value: fmt(t.appuntamenti), sub: 'lead della coorte con appuntamento' },
      { label: 'Tasso app. su totale', value: fmtPct(pct(t.appuntamenti, t.lead)), sub: 'appuntamenti / lead inseriti' },
      { label: 'Tasso app. su risposta', value: fmtPct(pct(t.appuntamenti, t.risposte)), sub: 'appuntamenti / lead con risposta' },
      { label: 'Tasso di risposta', value: fmtPct(pct(t.risposte, t.lead)), sub: fmt(t.risposte) + ' lead con risposta' },
      { label: 'Lavorati non correttamente', value: fmtPct(pct(t.male, t.lead)), sub: fmt(t.male) + ' lead' },
      { label: 'Acconti presi', value: fmtPct(pct(t.accP, t.accP + t.accNP)), sub: fmt(t.accP) + ' pagati / ' + fmt(t.accNP) + ' non pagati' },
      caTile,
    ]);
    return;
  }
  const t = totals();
  renderKpiRow(el, [
    { label: 'Chiamate', value: fmt(t.chiamate), sub: fmt1(t.giorniAttivi ? t.chiamate / t.giorniAttivi : 0) + ' al giorno' },
    { label: 'Tasso di risposta', value: fmtPct(pct(t.risposte, t.chiamate)), sub: fmt(t.risposte) + ' risposte' },
    { label: 'Appuntamenti', value: fmt(t.appuntamenti), sub: 'conf. / acconto pagato' },
    { label: 'Acconti pagati', value: fmt(t.acconti), sub: 'inclusi negli appuntamenti' },
    { label: 'Chiamate → Appuntamento', value: fmtPct(pct(t.appuntamenti, t.chiamate)), sub: 'appuntamenti / chiamate' },
    { label: 'Lead gestiti', value: fmt(t.leadUnici), sub: 'lead unici nel periodo · media ' + fmt1(t.leadGiorno) + '/giorno' },
    { label: 'Tempo di gestione', value: fmtMin(t.talk), sub: 'totale nel periodo' },
    caTile,
  ]);
}

// ── trend ─────────────────────────────────────────────────────────────────────
function renderTrend() {
  const coorte = MODE === 'inserimento';
  const byDay = {};
  for (const r of DATA.aggSetter) {
    if (!byDay[r.giorno]) byDay[r.giorno] = { chiamate: 0, appuntamenti: 0 };
    byDay[r.giorno].chiamate += coorte ? r.lead_totali : r.chiamate;
    byDay[r.giorno].appuntamenti += r.appuntamenti;
  }
  const days = Object.keys(byDay).sort();
  const rows = days.map(d => byDay[d]);
  renderLineChart(_mount.querySelector('#chTrend'), days, rows, [
    { key: 'chiamate', color: '--series-1', name: coorte ? 'Lead inseriti' : 'Chiamate' },
    { key: 'appuntamenti', color: '--series-2', name: 'Appuntamenti' },
  ], {
    xlab: dlab, yfmt: fmt,
    tip: (r, label) => `<div class="t-date">${label.split('-').reverse().join('/')}</div>
      <div class="t-row"><span>${coorte ? 'Lead inseriti' : 'Chiamate'}</span><b>${fmt(r.chiamate)}</b></div>
      <div class="t-row"><span>Appuntamenti</span><b>${fmt(r.appuntamenti)}</b></div>
      <div class="t-row"><span>Conversione</span><b>${fmtPct(pct(r.appuntamenti, r.chiamate))}</b></div>`,
  });
}

// ── tabelle ───────────────────────────────────────────────────────────────────
const setterCols = [
  { key: 'setter', label: 'Setter' },
  { key: 'chiamate', label: 'Chiamate', fmt },
  { key: 'chGiorno', label: 'Chiamate/giorno', fmt: fmt1 },
  { key: 'tassoRisp', label: 'Tasso risposta', fmt: fmtPct },
  { key: 'appuntamenti', label: 'Appuntamenti', fmt },
  { key: 'acconti', label: 'Acconti pagati', fmt },
  { key: 'conv', label: 'Conv. %', fmt: fmtPct, good: true },
  { key: 'lead', label: 'Lead gestiti', fmt },
  { key: 'leadGiorno', label: 'Lead/giorno', fmt: fmt1 },
  { key: 'giorni', label: 'Giorni attivi', fmt },
  { key: 'talk', label: 'Gestione', fmt: fmtMin },
];
const centroCols = [
  { key: 'centro', label: 'Centro' },
  { key: 'chiamate', label: 'Chiamate', fmt },
  { key: 'lead', label: 'Lead lavorati', fmt },
  { key: 'chPerLead', label: 'Chiamate/lead', fmt: fmt1 },
  { key: 'tR', label: 'Tasso risposta', fmt: fmtPct },
  { key: 'appuntamenti', label: 'Appuntamenti', fmt },
  { key: 'acconti', label: 'Acconti pagati', fmt },
  { key: 'conv', label: 'Conv. %', fmt: fmtPct, good: true },
];
const setterColsCoorte = [
  { key: 'setter', label: 'Setter' },
  { key: 'lead', label: 'Totale Lead', fmt },
  { key: 'appuntamenti', label: 'Appuntamenti', fmt },
  { key: 'appTot', label: 'App. su totale', fmt: fmtPct, good: true },
  { key: 'appRisp', label: 'App. su risposta', fmt: fmtPct, good: true },
  { key: 'tassoRisp', label: 'Tasso risposta', fmt: fmtPct },
  { key: 'malePct', label: 'Lavorati male', fmt: fmtPct },
  { key: 'accPresi', label: 'Acconti presi', fmt: fmtPct },
];
const centroColsCoorte = [
  { key: 'centro', label: 'Centro' },
  { key: 'lead', label: 'Totale Lead', fmt },
  { key: 'appuntamenti', label: 'Appuntamenti', fmt },
  { key: 'appTot', label: 'App. su totale', fmt: fmtPct, good: true },
  { key: 'appRisp', label: 'App. su risposta', fmt: fmtPct },
  { key: 'tassoRisp', label: 'Tasso risposta', fmt: fmtPct },
  { key: 'malePct', label: 'Lavorati male', fmt: fmtPct },
];

function openEsitiForRow(r) {
  const dim = r._dim, id = r._id;
  const nome = dim === 'setter' ? r.setter : r.centro;
  const f = getFilters();
  const from = f.from, to = f.to, mode = MODE;
  openEsiti({
    title: nome,
    subMaker: totale => {
      const unita = mode === 'inserimento' ? 'lead della coorte' : 'trattative';
      return `${fmt(totale)} ${unita} · dal ${from.split('-').reverse().join('/')} al ${to.split('-').reverse().join('/')} · vista ${mode === 'inserimento' ? 'per data inserimento' : 'per data chiamata'} — clicca un esito per le note della beauty`;
    },
    loadEsiti: () => loadEsiti(dim, id, from, to, mode),
    loadNote: esito => loadNote(dim, id, esito, from, to, mode),
  });
}

async function loadEsiti(dim, id, from, to, mode) {
  const chiamata = mode === 'chiamata';
  const view = dim === 'setter'
    ? (chiamata ? 'esiti_chiamata_setter' : 'esiti_coorte_setter')
    : (chiamata ? 'esiti_chiamata_centro' : 'esiti_coorte_centro');
  const idCol = dim === 'setter' ? 'operator_id' : 'campaign_id';
  const rows = await fetchAll((lo, hi) => supabase.from(view)
    .select('esito,esito_class,is_appointment,n')
    .eq(idCol, id).gte('giorno', from).lte('giorno', to).range(lo, hi));
  const m = new Map();
  for (const r of rows) {
    let a = m.get(r.esito);
    if (!a) { a = { esito: r.esito, esito_class: r.esito_class, is_appointment: r.is_appointment, n: 0 }; m.set(r.esito, a); }
    a.n += (+r.n || 0);
    if (r.is_appointment) a.is_appointment = true;
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

async function loadNote(dim, id, esito, from, to, mode) {
  if (mode === 'chiamata') {
    const idCol = dim === 'setter' ? 'operator_id' : 'campaign_id';
    const rows = await fetchAll((lo, hi) => supabase.from('v_calls')
      .select('giorno,start_date,operator_notes,esito,operator_id,campaign_id')
      .eq(idCol, id).eq('esito', esito).gte('giorno', from).lte('giorno', to).range(lo, hi));
    return rows
      .filter(r => r.operator_notes && String(r.operator_notes).trim())
      .sort((a, b) => String(b.giorno || '').localeCompare(String(a.giorno || '')))
      .map(r => ({ data: r.giorno || r.start_date, testo: r.operator_notes }));
  }
  const idCol = dim === 'setter' ? 'op_attribuito' : 'campaign_id';
  const rows = await fetchAll((lo, hi) => supabase.from('lead_coorte')
    .select('insert_eff,data_ciclo,nota_ciclo,esito_nome,campaign_id,op_attribuito')
    .eq(idCol, id).eq('esito_nome', esito).gte('insert_eff', from).lt('insert_eff', nextDay(to)).range(lo, hi));
  return rows
    .filter(r => r.nota_ciclo && String(r.nota_ciclo).trim())
    .sort((a, b) => String(b.data_ciclo || '').localeCompare(String(a.data_ciclo || '')))
    .map(r => ({ data: r.data_ciclo, testo: r.nota_ciclo }));
}

function renderSetterTable() {
  const coorte = MODE === 'inserimento';
  renderTable(_mount.querySelector('#chSetter'),
    coorte ? setterColsCoorte : setterCols,
    coorte ? bySetterCoorte() : bySetter(),
    setterSort,
    k => { setterSort = { key: k, dir: setterSort.key === k ? -setterSort.dir : -1 }; renderSetterTable(); },
    { barKey: coorte ? 'lead' : 'chiamate', rowLink: r => r._id !== undefined && r._id !== null, onRowClick: openEsitiForRow });
}
function renderCentroTable() {
  const coorte = MODE === 'inserimento';
  let rows = coorte ? byCentroCoorte() : byCentro().map(c => ({ ...c, tR: pct(c.risposte, c.chiamate) }));
  if (centroFilter) rows = rows.filter(r => r.centro && r.centro.toLowerCase().includes(centroFilter));
  renderTable(_mount.querySelector('#chCentro'),
    coorte ? centroColsCoorte : centroCols,
    rows, centroSort,
    k => { centroSort = { key: k, dir: centroSort.key === k ? -centroSort.dir : -1 }; renderCentroTable(); },
    { barKey: coorte ? 'lead' : 'chiamate', rowLink: r => r._id !== undefined && r._id !== null, onRowClick: openEsitiForRow });
}

// ── distribuzione ─────────────────────────────────────────────────────────────
function renderDist() {
  const raw = [...(DATA.distribuzione || [])].sort((a, b) => a.n_chiamate - b.n_chiamate);
  const buckets = [];
  let over = { n_lead: 0, n_con_appuntamento: 0 };
  for (const r of raw) {
    if (r.n_chiamate < 10) buckets.push({ n_lead: r.n_lead, n_con_appuntamento: r.n_con_appuntamento, label: String(r.n_chiamate) });
    else { over.n_lead += r.n_lead; over.n_con_appuntamento += r.n_con_appuntamento; }
  }
  if (over.n_lead > 0) buckets.push({ n_lead: over.n_lead, n_con_appuntamento: over.n_con_appuntamento, label: '10+' });
  const chartBuckets = buckets.map(b => {
    const p = pct(b.n_con_appuntamento, b.n_lead);
    return { label: b.label, value: b.n_lead, subLabel: p === null ? '' : Math.round(p) + '%', _b: b };
  });
  renderBarChart(_mount.querySelector('#chDist'), chartBuckets, {
    footer: 'n° chiamate ricevute — sotto: % lead con appuntamento',
    tip: cb => {
      const b = cb._b;
      return `<div class="t-date">${b.label} chiamat${b.label === '1' ? 'a' : 'e'}</div>
        <div class="t-row"><span>Lead</span><b>${fmt(b.n_lead)}</b></div>
        <div class="t-row"><span>Con appuntamento</span><b>${fmt(b.n_con_appuntamento)} (${fmtPct(pct(b.n_con_appuntamento, b.n_lead))})</b></div>`;
    },
  });
}

// ── ciclo di rendering ────────────────────────────────────────────────────────
function renderAll() {
  const coorte = MODE === 'inserimento';
  _mount.querySelector('#chModeHint').textContent = coorte
    ? '⚠️ i giorni recenti crescono nel tempo: i lead appena inseriti devono ancora essere lavorati' : '';
  _mount.querySelector('#chTrendSub').textContent = coorte
    ? 'Lead inseriti per giorno e quanti di quei lead hanno (finora) un appuntamento'
    : 'Chiamate effettuate e appuntamenti fissati per giorno';
  _mount.querySelector('#chLeg1').textContent = coorte ? 'Lead inseriti' : 'Chiamate';
  _mount.querySelector('#chLeg2').textContent = coorte ? 'Appuntamenti (della coorte)' : 'Appuntamenti';
  _mount.querySelector('#chSetterSub').textContent = (coorte
    ? 'Lead INSERITI nel periodo, attribuiti alla setter dell\'ultima chiamata del ciclo.'
    : 'Nel periodo selezionato. "Lead gestiti" = lead UNICI nel periodo (3 chiamate allo stesso lead = 1 lead). "Lead/giorno" = media dei lead distinti lavorati nei giorni attivi.')
    + ' Clicca una riga per gli esiti singoli.';
  _mount.querySelector('#chCentroSub').textContent = (coorte
    ? 'Nel periodo selezionato.'
    : 'Nel periodo selezionato. "Lead lavorati" = lead UNICI nel periodo; "Chiamate/lead" = quante chiamate sono servite in media per lead.')
    + ' Clicca una riga per gli esiti singoli.';
  renderKPI();
  renderTrend();
  renderSetterTable();
  renderCentroTable();
  renderDist();
}

async function load() {
  const myId = _renderId;
  const status = _mount.querySelector('#chStatus');
  const content = _mount.querySelector('#chContent');
  if (!status || !content) return;                 // DOM non montato: render obsoleto
  status.classList.remove('hidden');
  content.classList.add('hidden');
  status.textContent = 'Caricamento dati…';
  const f = getFilters();
  try {
    const data = await buildData(f.from, f.to, MODE);
    // stale se: un render chiamate più recente è partito (token) OPPURE il DOM è stato
    // sostituito da un'altra sezione durante il load (#chModeHint sparito).
    if (myId !== _renderId || !_mount.querySelector('#chModeHint')) return;
    DATA = data;
    renderAll();
    status.classList.add('hidden');
    content.classList.remove('hidden');
  } catch (e) {
    if (myId !== _renderId || !_mount.querySelector('#chStatus')) return;   // render obsoleto
    status.textContent = 'Errore nel caricamento: ' + e.message;
    throw e;
  }
}

export async function render(mount) {
  _mount = mount;
  _renderId++;                                     // invalida eventuali load ancora in volo
  mount.innerHTML = `
    <div class="filters" id="chMode">
      <button data-mode="chiamata" class="${MODE === 'chiamata' ? 'active' : ''}">📞 Per data chiamata</button>
      <button data-mode="inserimento" class="${MODE === 'inserimento' ? 'active' : ''}">🌱 Per data inserimento lead</button>
      <span class="custom" id="chModeHint"></span>
    </div>
    <div id="chStatus" class="status loading">Caricamento dati…</div>
    <div id="chContent" class="hidden">
      <div class="kpi-row" id="chKpi"></div>
      <div class="card">
        <h2>Andamento giornaliero</h2>
        <div class="subtitle" id="chTrendSub"></div>
        <div class="legend">
          <span class="key"><span class="swatch" style="background:var(--series-1)"></span><span id="chLeg1">Chiamate</span></span>
          <span class="key"><span class="swatch" style="background:var(--series-2)"></span><span id="chLeg2">Appuntamenti</span></span>
        </div>
        <div class="chart-wrap"><svg id="chTrend" width="100%" height="260"></svg></div>
      </div>
      <div class="card">
        <h2>Per setter</h2>
        <div class="subtitle" id="chSetterSub"></div>
        <div class="table-scroll"><table id="chSetter"></table></div>
      </div>
      <div class="card">
        <h2>Per centro</h2>
        <div class="subtitle" id="chCentroSub"></div>
        <input type="search" id="chSearch" placeholder="Cerca centro…" value="${centroFilter}">
        <div class="table-scroll"><table id="chCentro"></table></div>
      </div>
      <div class="card">
        <h2>Quante chiamate servono?</h2>
        <div class="subtitle">Distribuzione storica (tutti i lead): numero di chiamate ricevute per lead e quanti hanno raggiunto un appuntamento.</div>
        <div class="chart-wrap"><svg id="chDist" width="100%" height="240"></svg></div>
      </div>
    </div>`;

  mount.querySelectorAll('#chMode button[data-mode]').forEach(b => {
    b.onclick = () => {
      if (MODE === b.dataset.mode) return;
      MODE = b.dataset.mode;
      mount.querySelectorAll('#chMode button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      setterSort = { key: MODE === 'inserimento' ? 'lead' : 'chiamate', dir: -1 };
      centroSort = { key: MODE === 'inserimento' ? 'lead' : 'chiamate', dir: -1 };
      load();
    };
  });
  mount.querySelector('#chSearch').oninput = e => { centroFilter = e.target.value.toLowerCase(); renderCentroTable(); };

  await load();
}

export function onResize() {
  if (DATA && _mount && _mount.querySelector('#chTrend')) { renderTrend(); renderDist(); }
}
