// manager-stats · Sezione Vendita — statistiche dei setter B2B
//
// Fonte: set_chiamate (1 riga = 1 chiamata, sync da Notion LOG CHIAMATE SETTER).
// Tutti i ratio sono ricalcolati dai TOTALI del periodo, mai come media di ratio
// per-riga — stessa regola di Panoramica e Chiamate.
import { supabase } from '../supabase.js';
import { fetchAll } from '../data.js';
import { getFilters } from '../filters.js';
import { renderTable, renderKpiGroups, renderKpiRow } from '../tables.js';
import { renderLineChart, renderBarChart } from '../charts.js';
import { fmt, fmt1, pct, fmtPct, fmtMin, safeDiv, ratio, dlab, esc } from '../format.js';

let DATA = null;
let _mount = null;
let _renderId = 0;
let setterSort = { key: 'chiamate', dir: -1 };
let ghlSort = { key: 'chiamate', dir: -1 };
let setterFilter = '';

// ── caricamento ──────────────────────────────────────────────────────────────
async function buildData(from, to) {
  const [perGiorno, perOra, esiti, distribuzione, uniciRes, ghl] = await Promise.all([
    fetchAll((lo, hi) => supabase.from('agg_set_setter_giorno').select('*')
      .gte('giorno', from).lte('giorno', to).range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('agg_set_ora').select('*')
      .gte('giorno', from).lte('giorno', to).range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('set_esiti_setter').select('*')
      .gte('giorno', from).lte('giorno', to).range(lo, hi)),
    fetchAll((lo, hi) => supabase.from('set_tentativi_dist').select('*').range(lo, hi)),
    supabase.rpc('api_set_contatti_unici', { p_from: from, p_to: to }).then(r => r.data || []).catch(() => []),
    // chiamate oggettive dal log nativo GHL — grana diversa (1 riga = 1 squillo composto)
    fetchAll((lo, hi) => supabase.from('agg_set_ghl_setter_giorno').select('*')
      .gte('giorno', from).lte('giorno', to).range(lo, hi)).catch(() => []),
  ]);

  // l'RPC ritorna una riga per setter + una riga con setter NULL = totale azienda
  const uniciSetter = new Map();
  let uniciTot = null;
  for (const r of uniciRes) {
    if (r.setter === null) uniciTot = r;
    else uniciSetter.set(r.setter, r);
  }
  return { perGiorno, perOra, esiti, distribuzione, uniciSetter, uniciTot, ghl };
}

// ── chiamate reali (GHL) ─────────────────────────────────────────────────────
const GHLNUM = ['chiamate', 'connesse', 'conversazioni', 'secondi', 'senza_esito',
                'conversazioni_senza_esito', 'non_risposte', 'non_partite'];

function ghlBySetter() {
  const m = new Map();
  for (const r of (DATA.ghl || [])) {
    const k = r.setter || '(sconosciuto)';
    let a = m.get(k);
    if (!a) { a = { setter: k }; for (const n of GHLNUM) a[n] = 0; m.set(k, a); }
    for (const n of GHLNUM) a[n] += (+r[n] || 0);
  }
  return [...m.values()].map(a => {
    a.pctConnesse   = pct(a.connesse, a.chiamate);
    a.minuti        = a.secondi;
    a.durataMedia   = a.connesse ? a.secondi / a.connesse : null;   // secondi medi quando qualcuno risponde
    a.pctSenzaEsito = pct(a.senza_esito, a.chiamate);
    return a;
  });
}

function ghlTotali() {
  const t = {};
  for (const n of GHLNUM) t[n] = 0;
  for (const r of (DATA.ghl || [])) for (const n of GHLNUM) t[n] += (+r[n] || 0);
  return t;
}

// ── aggregazioni ─────────────────────────────────────────────────────────────
const NUM = ['chiamate', 'contatti', 'risposte', 'appuntamenti', 'conferme', 'scarti',
             'da_richiamare', 'non_interessati', 'fake', 'non_risposte', 'primi_contatti'];

function totals() {
  const t = {};
  for (const k of NUM) t[k] = 0;
  const giorni = new Set();
  for (const r of DATA.perGiorno) {
    for (const k of NUM) t[k] += (+r[k] || 0);
    giorni.add(r.giorno);
  }
  t.giorniAttivi = giorni.size;
  t.contattiUnici = DATA.uniciTot ? +DATA.uniciTot.contatti : null;
  t.contattiConApp = DATA.uniciTot ? +DATA.uniciTot.contatti_con_app : null;
  return t;
}

function bySetter() {
  const m = new Map();
  for (const r of DATA.perGiorno) {
    const k = r.setter || '(senza nome)';
    let a = m.get(k);
    if (!a) { a = { setter: k, giorni: 0 }; for (const n of NUM) a[n] = 0; m.set(k, a); }
    for (const n of NUM) a[n] += (+r[n] || 0);
    a.giorni += 1;
  }
  return [...m.values()].map(a => {
    const u = DATA.uniciSetter.get(a.setter);
    a.contattiUnici = u ? +u.contatti : null;
    a.chGiorno      = safeDiv(a.chiamate, a.giorni);
    a.chPerContatto = safeDiv(a.chiamate, a.contattiUnici);
    a.tassoRisp     = pct(a.risposte, a.chiamate);
    a.appGiorno     = safeDiv(a.appuntamenti, a.giorni);
    a.appSuRisposte = pct(a.appuntamenti, a.risposte);
    a.appSuContatti = pct(a.appuntamenti, a.contattiUnici);
    a.chPerApp      = safeDiv(a.chiamate, a.appuntamenti);
    return a;
  });
}

// ── KPI ──────────────────────────────────────────────────────────────────────
function renderKPI() {
  const t = totals();
  renderKpiGroups(_mount.querySelector('#vdKpi'), [
    { step: 1, title: 'Attività', tiles: [
      { label: 'Chiamate', value: fmt(t.chiamate), hero: true },
      { label: 'Al giorno', value: fmt1(safeDiv(t.chiamate, t.giorniAttivi)), sub: t.giorniAttivi + ' giorni lavorati' },
      { label: 'Contatti lavorati', value: fmt(t.contattiUnici), sub: 'titolari unici nel periodo' },
      { label: 'Chiamate per contatto', value: fmt1(safeDiv(t.chiamate, t.contattiUnici)), sub: 'tentativi medi' },
      { label: 'Primi contatti', value: fmt(t.primi_contatti), sub: fmtPct(pct(t.primi_contatti, t.chiamate)) + ' delle chiamate · il resto è follow-up' },
    ] },
    { step: 2, title: 'Contatto', tiles: [
      { label: 'Risposte', value: fmt(t.risposte), hero: true },
      { label: 'Tasso di risposta', value: fmtPct(pct(t.risposte, t.chiamate)), sub: 'risposte / chiamate' },
      { label: 'Non risponde', value: fmt(t.non_risposte) },
      { label: 'Da richiamare', value: fmt(t.da_richiamare), sub: 'ha risposto, va ricontattato' },
    ] },
    { step: 3, title: 'Risultato', tiles: [
      { label: 'Appuntamenti fissati', value: fmt(t.appuntamenti), hero: true },
      { label: 'Chiamate per appuntamento', value: fmt1(safeDiv(t.chiamate, t.appuntamenti)), sub: 'quante chiamate costa un appuntamento' },
      { label: 'Su chi risponde', value: fmtPct(pct(t.appuntamenti, t.risposte)), sub: 'appuntamenti / risposte' },
      { label: 'Su contatti lavorati', value: fmtPct(pct(t.contattiConApp, t.contattiUnici)), sub: fmt(t.contattiConApp) + ' contatti su ' + fmt(t.contattiUnici) },
      { label: 'Conferme', value: fmt(t.conferme), sub: 'appuntamenti già esistenti, non contati sopra' },
      { label: 'Chiusi (no / fake)', value: fmt(t.scarti), sub: fmt(t.non_interessati) + ' non interessati · ' + fmt(t.fake) + ' fake' },
    ] },
  ]);
}

// ── grafici ──────────────────────────────────────────────────────────────────
// Due grafici invece di uno: gli appuntamenti (~10/giorno) schiacciati sullo stesso
// asse delle chiamate (~130/giorno) diventerebbero una riga piatta a zero.
function renderTrend() {
  const byDay = {};
  for (const r of DATA.perGiorno) {
    if (!byDay[r.giorno]) byDay[r.giorno] = { chiamate: 0, risposte: 0, appuntamenti: 0 };
    byDay[r.giorno].chiamate     += (+r.chiamate || 0);
    byDay[r.giorno].risposte     += (+r.risposte || 0);
    byDay[r.giorno].appuntamenti += (+r.appuntamenti || 0);
  }
  const days = Object.keys(byDay).sort();
  const rows = days.map(d => byDay[d]);
  const data = (r, label) => `<div class="t-date">${label.split('-').reverse().join('/')}</div>`;

  renderLineChart(_mount.querySelector('#vdTrend'), days, rows, [
    { key: 'chiamate', color: '--series-1', name: 'Chiamate' },
    { key: 'risposte', color: '--series-3', name: 'Risposte' },
  ], {
    xlab: dlab, yfmt: fmt,
    tip: (r, label) => data(r, label) +
      `<div class="t-row"><span>Chiamate</span><b>${fmt(r.chiamate)}</b></div>
       <div class="t-row"><span>Risposte</span><b>${fmt(r.risposte)}</b></div>
       <div class="t-row"><span>Tasso di risposta</span><b>${fmtPct(pct(r.risposte, r.chiamate))}</b></div>`,
  });

  renderLineChart(_mount.querySelector('#vdTrendApp'), days, rows, [
    { key: 'appuntamenti', color: '--series-2', name: 'Appuntamenti' },
  ], {
    xlab: dlab, yfmt: fmt, height: 200, minMax: 3,
    tip: (r, label) => data(r, label) +
      `<div class="t-row"><span>Appuntamenti</span><b>${fmt(r.appuntamenti)}</b></div>
       <div class="t-row"><span>Su chiamate</span><b>${fmtPct(pct(r.appuntamenti, r.chiamate))}</b></div>
       <div class="t-row"><span>Su risposte</span><b>${fmtPct(pct(r.appuntamenti, r.risposte))}</b></div>`,
  });
}

// Distribuzione oraria: quando si chiama e quando rispondono davvero.
function renderOre() {
  const byOra = new Map();
  for (const r of DATA.perOra) {
    const o = r.ora_locale;
    let a = byOra.get(o);
    if (!a) { a = { ora: o, chiamate: 0, risposte: 0, appuntamenti: 0 }; byOra.set(o, a); }
    a.chiamate     += (+r.chiamate || 0);
    a.risposte     += (+r.risposte || 0);
    a.appuntamenti += (+r.appuntamenti || 0);
  }
  const ore = [...byOra.values()].sort((a, b) => a.ora - b.ora);
  const buckets = ore.map(o => {
    const p = pct(o.risposte, o.chiamate);
    return {
      label: String(o.ora).padStart(2, '0'),
      value: o.chiamate,
      subLabel: p === null ? '' : Math.round(p) + '%',
      _o: o,
    };
  });
  renderBarChart(_mount.querySelector('#vdOre'), buckets, {
    footer: 'ora del giorno (Europe/Rome) — sotto: tasso di risposta della fascia',
    tip: b => {
      const o = b._o;
      return `<div class="t-date">Ore ${b.label}:00</div>
        <div class="t-row"><span>Chiamate</span><b>${fmt(o.chiamate)}</b></div>
        <div class="t-row"><span>Risposte</span><b>${fmt(o.risposte)} (${fmtPct(pct(o.risposte, o.chiamate))})</b></div>
        <div class="t-row"><span>Appuntamenti</span><b>${fmt(o.appuntamenti)} (${fmtPct(pct(o.appuntamenti, o.chiamate))})</b></div>`;
    },
  });
}

// Quanti tentativi servono: istogramma storico su tutti i contatti.
function renderDist() {
  const raw = [...(DATA.distribuzione || [])].sort((a, b) => a.n_chiamate - b.n_chiamate);
  const buckets = [];
  const over = { n_contatti: 0, n_fissati: 0 };
  for (const r of raw) {
    if (r.n_chiamate < 10) buckets.push({ n_contatti: +r.n_contatti, n_fissati: +r.n_fissati, label: String(r.n_chiamate) });
    else { over.n_contatti += +r.n_contatti; over.n_fissati += +r.n_fissati; }
  }
  if (over.n_contatti > 0) buckets.push({ ...over, label: '10+' });
  renderBarChart(_mount.querySelector('#vdDist'), buckets.map(b => {
    const p = pct(b.n_fissati, b.n_contatti);
    return { label: b.label, value: b.n_contatti, subLabel: p === null ? '' : Math.round(p) + '%', _b: b };
  }), {
    footer: 'n° chiamate ricevute dal contatto — sotto: % che ha poi fissato',
    tip: cb => {
      const b = cb._b;
      return `<div class="t-date">${b.label} chiamat${b.label === '1' ? 'a' : 'e'}</div>
        <div class="t-row"><span>Contatti</span><b>${fmt(b.n_contatti)}</b></div>
        <div class="t-row"><span>Hanno fissato</span><b>${fmt(b.n_fissati)} (${fmtPct(pct(b.n_fissati, b.n_contatti))})</b></div>`;
    },
  });
}

// ── esiti nel periodo ────────────────────────────────────────────────────────
function renderEsiti() {
  const m = new Map();
  let tot = 0;
  for (const r of DATA.esiti) {
    const e = r.esito || '(vuoto)';
    m.set(e, (m.get(e) || 0) + (+r.n || 0));
    tot += (+r.n || 0);
  }
  const rows = [...m.entries()].map(([esito, n]) => ({ esito, n })).sort((a, b) => b.n - a.n);
  const max = Math.max(...rows.map(r => r.n), 1);
  const APP = new Set(['Appuntamento fissato', 'App fissato Ai/ VSL']);
  const el = _mount.querySelector('#vdEsiti');
  if (!rows.length) { el.innerHTML = '<div class="status">Nessun dato nel periodo.</div>'; return; }
  el.innerHTML = rows.map(r => {
    const col = APP.has(r.esito) ? 'var(--series-2)' : (r.esito === 'Non risp' ? 'var(--muted)' : 'var(--series-1)');
    return `<div class="esito-row">
      <div class="esito-top">
        <span class="lbl">${esc(r.esito)}</span>
        <span class="val"><b>${fmt(r.n)}</b> · ${fmtPct(pct(r.n, tot))}</span>
      </div>
      <div class="esito-track"><div class="esito-fill" style="width:${Math.max(2, Math.round(100 * r.n / max))}%; background:${col}"></div></div>
    </div>`;
  }).join('');
}

// ── tabella setter ───────────────────────────────────────────────────────────
const setterCols = [
  { key: 'setter',         label: 'Setter' },
  { key: 'chiamate',       label: 'Chiamate',       fmt },
  { key: 'chGiorno',       label: 'Chiamate/giorno', fmt: fmt1 },
  { key: 'contattiUnici',  label: 'Contatti',       fmt },
  { key: 'chPerContatto',  label: 'Chiamate/contatto', fmt: fmt1 },
  { key: 'tassoRisp',      label: 'Tasso risposta', fmt: fmtPct },
  { key: 'appuntamenti',   label: 'Appuntamenti',   fmt },
  { key: 'appGiorno',      label: 'App./giorno',    fmt: fmt1 },
  { key: 'appSuRisposte',  label: 'App. su risposte', fmt: fmtPct, good: true, goodMin: 15 },
  { key: 'appSuContatti',  label: 'App. su contatti', fmt: fmtPct, good: true, goodMin: 15 },
  { key: 'chPerApp',       label: 'Chiamate per app.', fmt: v => v === null ? '—' : fmt1(v) },
  { key: 'conferme',       label: 'Conferme',       fmt },
  { key: 'non_interessati', label: 'Non int.',      fmt },
  { key: 'fake',           label: 'Fake',           fmt },
  { key: 'giorni',         label: 'Giorni attivi',  fmt },
];

function renderSetterTable() {
  let rows = bySetter();
  if (setterFilter) rows = rows.filter(r => r.setter.toLowerCase().includes(setterFilter));
  renderTable(_mount.querySelector('#vdSetter'), setterCols, rows, setterSort,
    k => { setterSort = { key: k, dir: setterSort.key === k ? -setterSort.dir : -1 }; renderSetterTable(); },
    { barKey: 'chiamate' });
}

// ── tabella chiamate reali (GHL) ─────────────────────────────────────────────
const ghlCols = [
  { key: 'setter',        label: 'Setter' },
  { key: 'chiamate',      label: 'Composte',      fmt },
  { key: 'connesse',      label: 'Connesse',      fmt },
  { key: 'pctConnesse',   label: '% connesse',    fmt: fmtPct },
  { key: 'conversazioni', label: 'Conversazioni', fmt },
  { key: 'secondi',       label: 'Al telefono',   fmt: fmtMin },
  { key: 'durataMedia',   label: 'Durata media',  fmt: v => v === null ? '—' : Math.round(v) + ' s' },
  { key: 'senza_esito',   label: 'Senza esito',   fmt },
  { key: 'pctSenzaEsito', label: '% senza esito', fmt: fmtPct },
  { key: 'non_partite',   label: 'Non partite',   fmt },
];

function renderGhlTable() {
  const rows = ghlBySetter();
  const el = _mount.querySelector('#vdGhlTable');
  if (!rows.length) { el.innerHTML = ''; return; }
  renderTable(el, ghlCols, rows, ghlSort,
    k => { ghlSort = { key: k, dir: ghlSort.key === k ? -ghlSort.dir : -1 }; renderGhlTable(); },
    { barKey: 'chiamate' });
}

function renderGhl() {
  const wrap = _mount.querySelector('#vdGhl');
  if (!DATA.ghl || !DATA.ghl.length) {
    wrap.innerHTML = '<div class="status">Nessuna chiamata registrata da GoHighLevel nel periodo.</div>';
    return;
  }
  const t = ghlTotali();
  renderKpiRow(_mount.querySelector('#vdGhlKpi'), [
    { label: 'Chiamate composte', value: fmt(t.chiamate), sub: 'squilli effettivi, non esiti' },
    { label: 'Connesse', value: fmt(t.connesse), sub: fmtPct(pct(t.connesse, t.chiamate)) + ' di risposta reale' },
    { label: 'Conversazioni', value: fmt(t.conversazioni), sub: 'oltre 30 secondi' },
    { label: 'Al telefono', value: fmtMin(t.secondi), sub: 'tempo parlato totale' },
    { label: 'Durata media', value: t.connesse ? Math.round(t.secondi / t.connesse) + ' s' : '—', sub: 'quando rispondono' },
    { label: 'Senza esito', value: fmt(t.senza_esito), sub: fmtPct(pct(t.senza_esito, t.chiamate)) + ' delle chiamate' },
    { label: 'Conversazioni perse', value: fmt(t.conversazioni_senza_esito), sub: 'oltre 30s e mai registrate' },
    { label: 'Non partite', value: fmt(t.non_partite), sub: 'errore tecnico o annullate' },
  ]);
  renderGhlTable();
}

// ── ciclo di rendering ───────────────────────────────────────────────────────
function renderAll() {
  renderKPI();
  renderTrend();
  renderSetterTable();
  renderGhl();
  renderOre();
  renderDist();
  renderEsiti();
}

async function load() {
  const myId = _renderId;
  const status = _mount.querySelector('#vdStatus');
  const content = _mount.querySelector('#vdContent');
  if (!status || !content) return;
  status.classList.remove('hidden');
  content.classList.add('hidden');
  status.textContent = 'Caricamento dati…';
  const f = getFilters();
  try {
    const data = await buildData(f.from, f.to);
    if (myId !== _renderId || !_mount.querySelector('#vdContent')) return;   // render obsoleto
    DATA = data;
    if (!data.perGiorno.length) {
      status.textContent = 'Nessuna chiamata nel periodo selezionato.';
      return;
    }
    renderAll();
    status.classList.add('hidden');
    content.classList.remove('hidden');
  } catch (e) {
    if (myId !== _renderId || !_mount.querySelector('#vdStatus')) return;
    status.textContent = 'Errore nel caricamento: ' + e.message;
    throw e;
  }
}

export async function render(mount) {
  _mount = mount;
  _renderId++;
  mount.innerHTML = `
    <div id="vdStatus" class="status loading">Caricamento dati…</div>
    <div id="vdContent" class="hidden">
      <div class="kpi-groups" id="vdKpi"></div>

      <div class="card">
        <h2>Andamento giornaliero</h2>
        <div class="subtitle">Chiamate effettuate e risposte ottenute, giorno per giorno.</div>
        <div class="legend">
          <span class="key"><span class="swatch" style="background:var(--series-1)"></span>Chiamate</span>
          <span class="key"><span class="swatch" style="background:var(--series-3)"></span>Risposte</span>
        </div>
        <div class="chart-wrap"><svg id="vdTrend" width="100%" height="260"></svg></div>
        <div class="subtitle" style="margin-top:18px">Appuntamenti fissati per giorno — su scala propria, altrimenti sarebbero una riga piatta accanto alle chiamate.</div>
        <div class="chart-wrap"><svg id="vdTrendApp" width="100%" height="200"></svg></div>
      </div>

      <div class="card">
        <h2>Per setter</h2>
        <div class="subtitle">Nel periodo selezionato. "Contatti" = titolari UNICI lavorati (3 chiamate allo stesso titolare = 1 contatto).
          "Appuntamenti" esclude le conferme, che riguardano appuntamenti già presi. Il filtro Consulente non si applica: i setter lavorano l'acquisizione, non i centri clienti.</div>
        <input type="search" id="vdSearch" placeholder="Cerca setter…" value="${esc(setterFilter)}">
        <div class="table-scroll"><table id="vdSetter"></table></div>
      </div>

      <div class="card">
        <h2>Al telefono davvero</h2>
        <div class="subtitle">Chiamate registrate da GoHighLevel: qui una riga è uno <strong>squillo effettivamente composto</strong>, non un esito dichiarato.
          "Connesse" = la linea si è aperta (può essere anche una segreteria); "Conversazioni" = oltre 30 secondi.
          <strong>"Senza esito"</strong> sono le chiamate a cui il setter non ha associato nessun esito, quindi invisibili nelle tabelle qui sopra.</div>
        <div class="kpi-row" id="vdGhlKpi"></div>
        <div id="vdGhl"><div class="table-scroll"><table id="vdGhlTable"></table></div></div>
      </div>

      <div class="card">
        <h2>A che ora rispondono</h2>
        <div class="subtitle">Chiamate per fascia oraria e tasso di risposta di quella fascia: dove la barra è bassa ma la percentuale è alta, c'è margine.</div>
        <div class="chart-wrap"><svg id="vdOre" width="100%" height="240"></svg></div>
      </div>

      <div class="card">
        <h2>Quante chiamate servono per fissare</h2>
        <div class="subtitle">Distribuzione storica su tutti i contatti (non filtrata per periodo): quante chiamate ha ricevuto un titolare e quanti di quelli hanno poi fissato.</div>
        <div class="chart-wrap"><svg id="vdDist" width="100%" height="240"></svg></div>
      </div>

      <div class="card">
        <h2>Esiti nel periodo</h2>
        <div class="subtitle">Come si chiudono le chiamate.</div>
        <div id="vdEsiti"></div>
      </div>
    </div>`;

  mount.querySelector('#vdSearch').oninput = e => {
    setterFilter = e.target.value.toLowerCase();
    if (DATA) renderSetterTable();
  };

  await load();
}

export function onResize() {
  if (DATA && _mount && _mount.querySelector('#vdTrend')) { renderTrend(); renderOre(); renderDist(); }
}
