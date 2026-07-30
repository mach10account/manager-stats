// manager-stats · Sezione Vendita — statistiche dei setter B2B
//
// Fonte: set_chiamate (1 riga = 1 chiamata, sync da Notion LOG CHIAMATE SETTER).
// Tutti i ratio sono ricalcolati dai TOTALI del periodo, mai come media di ratio
// per-riga — stessa regola di Panoramica e Chiamate.
import { supabase } from '../supabase.js';
import { NOTE_PROXY_URL } from '../config.js';
import { fetchAll } from '../data.js';
import { getFilters } from '../filters.js';
import { renderTable, renderKpiGroups, renderKpiRow } from '../tables.js';
import { renderLineChart, renderBarChart } from '../charts.js';
import { fmt, fmt1, pct, fmtPct, fmtMin, eur, safeDiv, ratio, dlab, esc } from '../format.js';

let DATA = null;
let _mount = null;
let _renderId = 0;
let setterSort = { key: 'chiamate', dir: -1 };
let ghlSort = { key: 'chiamate', dir: -1 };
let stlSort = { key: 'primi_contatti', dir: -1 };
let soloSaltati = false;
let setterFilter = '';

// ── caricamento ──────────────────────────────────────────────────────────────
async function buildData(from, to) {
  const [perGiorno, perOra, esiti, distribuzione, uniciRes, ghl, funnel, stl] = await Promise.all([
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
    // il report giornaliero NUOVI/VECCHI (chiamate + funnel opportunità)
    supabase.rpc('api_set_funnel', { p_from: from, p_to: to, p_setter: funnelSetter || null })
      .then(r => r.data || []).catch(() => []),
    // speed to lead — una riga per lead ENTRATO nel periodo (non per chiamata fatta)
    fetchAll((lo, hi) => supabase.from('v_set_speed_to_lead')
      .select('minuti,setter,fascia,in_attesa,saltato,lead,entrata_a,ghl_contact_id,n_chiamate,fine_finestra')
      .gte('giorno_entrata', from).lte('giorno_entrata', to)
      .order('entrata_a', { ascending: false }).range(lo, hi)).catch(() => []),
  ]);

  // l'RPC ritorna una riga per setter + una riga con setter NULL = totale azienda
  const uniciSetter = new Map();
  let uniciTot = null;
  for (const r of uniciRes) {
    if (r.setter === null) uniciTot = r;
    else uniciSetter.set(r.setter, r);
  }
  return { perGiorno, perOra, esiti, distribuzione, uniciSetter, uniciTot, ghl, funnel, stl };
}

// ── speed to lead ────────────────────────────────────────────────────────────
// durata leggibile: 4 min · 1h 20m · 2g 4h
const durata = m => {
  if (m === null || m === undefined || isNaN(m)) return '—';
  if (m < 60) return Math.round(m) + ' min';
  if (m < 1440) { const h = Math.floor(m / 60), r = Math.round(m % 60); return h + 'h' + (r ? ' ' + r + 'm' : ''); }
  const g = Math.floor(m / 1440), h = Math.round((m % 1440) / 60);
  return g + 'g' + (h ? ' ' + h + 'h' : '');
};

const mediana = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

const FASCE = ['entro 5 min', '5-30 min', '30-60 min', '1-4 ore', '4-24 ore',
               '1-3 giorni', 'oltre 3 giorni', 'mai chiamato', 'in attesa'];

function stlTotali() {
  const r = DATA.stl || [];
  const chiamati = r.filter(x => x.minuti !== null && x.minuti !== undefined);
  const min = chiamati.map(x => +x.minuti);
  return {
    lead: r.length,
    chiamati: chiamati.length,
    inAttesa: r.filter(x => x.in_attesa).length,
    saltati: r.filter(x => x.saltato).length,
    mediana: mediana(min),
    entro1h: min.filter(m => m <= 60).length,
    entro24h: min.filter(m => m <= 1440).length,
  };
}

function stlBySetter() {
  const m = new Map();
  for (const r of (DATA.stl || [])) {
    if (r.minuti === null || r.minuti === undefined) continue;   // la prima chiamata non c'è: nessuno da attribuire
    const k = r.setter || '(sconosciuto)';
    if (!m.has(k)) m.set(k, { setter: k, minuti: [] });
    m.get(k).minuti.push(+r.minuti);
  }
  return [...m.values()].map(a => ({
    setter: a.setter,
    primi_contatti: a.minuti.length,
    mediana: mediana(a.minuti),
    entro1h: pct(a.minuti.filter(x => x <= 60).length, a.minuti.length),
    entro24h: pct(a.minuti.filter(x => x <= 1440).length, a.minuti.length),
  }));
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

// ── report giornaliero NUOVI / VECCHI ────────────────────────────────────────
let funnelSetter = '';          // '' = tutti
let _funnelReqId = 0;

// popolamento del filtro: i setter visti nel periodo (stessi nomi normalizzati del resto)
function renderFunnelFilter() {
  const sel = _mount.querySelector('#vdFunnelSetter');
  if (!sel) return;
  const nomi = [...new Set((DATA.perGiorno || []).map(r => r.setter).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">Tutti i setter</option>' +
    nomi.map(n => `<option value="${esc(n)}"${n === funnelSetter ? ' selected' : ''}>${esc(n)}</option>`).join('');
  sel.onchange = async () => {
    funnelSetter = sel.value;
    const myId = ++_funnelReqId;
    const el = _mount.querySelector('#vdFunnel');
    el.innerHTML = '<tbody><tr><td class="name">Caricamento…</td></tr></tbody>';
    const f = getFilters();
    // NB: il builder di supabase-js ha solo .then — un .catch diretto è un TypeError
    const { data } = await supabase.rpc('api_set_funnel',
      { p_from: f.from, p_to: f.to, p_setter: funnelSetter || null }).then(r => r).catch(() => ({ data: null }));
    if (myId !== _funnelReqId || !_mount.querySelector('#vdFunnel')) return;   // risposta obsoleta
    DATA.funnel = data || [];
    renderFunnel();
  };
}

function renderFunnel() {
  const el = _mount.querySelector('#vdFunnel');
  const rows = DATA.funnel || [];
  if (!rows.length) {
    el.innerHTML = '<div class="status">Nessun dato nel periodo' + (funnelSetter ? ' per ' + esc(funnelSetter) : '') + '.</div>';
    return;
  }
  // (ordine, metrica) → { NUOVI, VECCHI }
  const m = new Map();
  for (const r of rows) {
    let e = m.get(r.ordine);
    if (!e) { e = { metrica: r.metrica, ordine: r.ordine, NUOVI: 0, VECCHI: 0 }; m.set(r.ordine, e); }
    e[r.gruppo] = +r.valore || 0;
  }
  const lista = [...m.values()].sort((a, b) => a.ordine - b.ordine);
  const isEuro = r => r.metrica.includes('€');
  const f = (r, v) => isEuro(r) ? eur(v) : fmt(v);
  let h = `<thead><tr><th></th><th>Nuovi lead</th><th>Vecchi lead</th><th>Totale</th></tr></thead><tbody>`;
  for (const r of lista) {
    // stacchi: chiamate | esiti lead (stage GHL) | funnel appuntamenti | valori €
    const sep = (r.ordine === 2 || r.ordine === 5 || r.ordine === 10) ? ' class="fn-sep"' : '';
    h += `<tr${sep}><td class="name">${esc(r.metrica)}</td>
      <td>${f(r, r.NUOVI)}</td><td>${f(r, r.VECCHI)}</td><td><b>${f(r, r.NUOVI + r.VECCHI)}</b></td></tr>`;
  }
  el.innerHTML = h + '</tbody>';
}

// ── card speed to lead ───────────────────────────────────────────────────────
const stlCols = [
  { key: 'setter',         label: 'Setter' },
  { key: 'primi_contatti', label: 'Primi contatti', fmt },
  { key: 'mediana',        label: 'Mediana',        fmt: durata },
  { key: 'entro1h',        label: 'Entro 1 ora',    fmt: fmtPct, good: true, goodMin: 25 },
  { key: 'entro24h',       label: 'Entro 24 ore',   fmt: fmtPct, good: true, goodMin: 70 },
];

function renderStl() {
  const t = stlTotali();
  if (!t.lead) {
    _mount.querySelector('#vdStl').innerHTML =
      '<div class="status">Nessun lead entrato nel periodo selezionato.</div>';
    return;
  }
  renderKpiRow(_mount.querySelector('#vdStlKpi'), [
    { label: 'Lead entrati', value: fmt(t.lead), sub: 'nel periodo' },
    { label: 'Tempo mediano', value: durata(t.mediana), sub: 'dall\'ingresso al primo squillo' },
    { label: 'Entro 1 ora', value: fmtPct(pct(t.entro1h, t.chiamati)), sub: fmt(t.entro1h) + ' lead' },
    { label: 'Entro 24 ore', value: fmtPct(pct(t.entro24h, t.chiamati)), sub: fmt(t.entro24h) + ' lead' },
    { label: 'Mai chiamati', value: fmt(t.saltati), sub: fmtPct(pct(t.saltati, t.lead)) + ' dei lead entrati' },
    { label: 'In attesa', value: fmt(t.inAttesa), sub: 'entrati da meno di 24 ore' },
  ]);

  // distribuzione: "in attesa" resta fuori dal grafico, non è un ritardo
  const conta = new Map(FASCE.map(f => [f, 0]));
  for (const r of DATA.stl) conta.set(r.fascia, (conta.get(r.fascia) || 0) + 1);
  const buckets = FASCE.filter(f => f !== 'in attesa').map(f => ({
    label: f === 'mai chiamato' ? 'mai' : f.replace(' min', 'm').replace(' ore', 'h').replace(' giorni', 'g'),
    value: conta.get(f) || 0,
    subLabel: fmtPct(pct(conta.get(f) || 0, t.lead - t.inAttesa)),
    _f: f,
  }));
  renderBarChart(_mount.querySelector('#vdStlChart'), buckets, {
    footer: 'tempo dall\'ingresso del lead al primo squillo — sotto: quota sui lead entrati',
    tip: b => `<div class="t-date">${b._f}</div>
      <div class="t-row"><span>Lead</span><b>${fmt(b.value)}</b></div>
      <div class="t-row"><span>Quota</span><b>${b.subLabel}</b></div>`,
  });

  renderTable(_mount.querySelector('#vdStlTable'), stlCols, stlBySetter(), stlSort,
    k => { stlSort = { key: k, dir: stlSort.key === k ? -stlSort.dir : -1 }; renderStl(); },
    { barKey: 'primi_contatti' });

  renderElencoLead();
}

// elenco dei lead entrati: la prima domanda guardando il conteggio è "chi sono"
const ORA = iso => !iso ? '—' : new Date(iso).toLocaleString('it-IT',
  { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// dettaglio di un lead (tab Chiamate / Note): caricato al primo click, poi in cache.
// Le chiamate usano gli stessi confini temporali del conteggio n_chiamate (dalla creazione
// dell'opportunità alla nascita dell'opportunità successiva dello stesso contatto);
// le note arrivano da GHL via proxy n8n (autenticato col login Supabase).
const _leadDet = new Map();     // leadKey → righe chiamate, oppure 'err'
const _leadNote = new Map();    // leadKey → note GHL, oppure 'err'
const _leadTab = new Map();     // leadKey → 'chiamate' | 'note'
const _leadOpen = new Set();    // leadKey espansi
let _utentiGhl = null;          // user_id GHL → nome (per firmare le note)
const leadKey = r => r.ghl_contact_id + '|' + r.entrata_a;

const STATO_CALL = {
  completed: 'risposta', 'no-answer': 'non risposta', busy: 'occupato',
  failed: 'non partita', ringing: 'non partita', voicemail: 'segreteria',
  'in-progress': 'in corso', initiated: 'avviata',
};
const durataCall = s => !s ? '' : (s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60 ? s % 60 + 's' : ''));

async function fetchLeadDet(r) {
  const k = leadKey(r);
  if (_leadDet.has(k)) return;
  let q = supabase.from('v_set_chiamate_ghl')
    .select('quando,setter,stato,durata_s,esito')
    .eq('ghl_contact_id', r.ghl_contact_id)
    .gte('quando', r.entrata_a)
    .order('quando', { ascending: true })
    .limit(200);
  if (r.fine_finestra) q = q.lt('quando', r.fine_finestra);
  const { data, error } = await q;
  _leadDet.set(k, error ? 'err' : (data || []));
}

async function fetchUtenti() {
  if (_utentiGhl) return;
  const { data } = await supabase.from('set_utenti_ghl').select('user_id,nome')
    .then(r => r).catch(() => ({ data: null }));
  _utentiGhl = new Map((data || []).map(u => [u.user_id, u.nome]));
}

async function fetchLeadNote(r) {
  const k = leadKey(r);
  if (_leadNote.has(k)) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    // text/plain = niente preflight CORS; il jwt viaggia nel body, mai nell'URL
    const res = await fetch(NOTE_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ jwt: session ? session.access_token : '', contact: r.ghl_contact_id }),
    });
    const j = await res.json();
    await fetchUtenti();
    _leadNote.set(k, j.ok ? (j.note || []) : 'err');
  } catch (e) { _leadNote.set(k, 'err'); }
}

function chiamateHtml(r) {
  const det = _leadDet.get(leadKey(r));
  if (det === undefined) return '<div class="status">Carico le chiamate…</div>';
  if (det === 'err') return '<div class="status">Errore nel caricare le chiamate.</div>';
  if (!det.length) return '<div class="status">Nessuna chiamata registrata da GHL per questo lead.</div>';
  return '<table class="lead-det-tab"><thead><tr><th>Quando</th><th>Setter</th><th>Telefonata</th><th>Esito dichiarato</th></tr></thead><tbody>' +
    det.map(c => {
      const tec = (STATO_CALL[c.stato] || c.stato || '—') + (c.durata_s ? ' · ' + durataCall(c.durata_s) : '');
      return `<tr><td>${ORA(c.quando)}</td><td>${esc(c.setter || '—')}</td><td>${esc(tec)}</td><td>${esc(c.esito || '—')}</td></tr>`;
    }).join('') + '</tbody></table>';
}

function noteHtml(r) {
  const det = _leadNote.get(leadKey(r));
  if (det === undefined) return '<div class="status">Carico le note…</div>';
  if (det === 'err') return '<div class="status">Errore nel caricare le note.</div>';
  if (!det.length) return '<div class="status">Nessuna nota su questo lead in GHL.</div>';
  return '<div class="lead-note-list">' + det.map(n => {
    const autore = (_utentiGhl && _utentiGhl.get(n.user_id)) || '—';
    return `<div class="lead-nota"><div class="lead-nota-meta">${ORA(n.quando)} · ${esc(autore)}</div>` +
      `<div class="lead-nota-testo">${esc(n.testo)}</div></div>`;
  }).join('') + '</div>';
}

function detHtml(r) {
  const tab = _leadTab.get(leadKey(r)) || 'chiamate';
  return `<div class="lead-tabs">
      <button data-tab="chiamate" class="${tab === 'chiamate' ? 'active' : ''}">Chiamate</button>
      <button data-tab="note" class="${tab === 'note' ? 'active' : ''}">Note</button>
    </div>` + (tab === 'note' ? noteHtml(r) : chiamateHtml(r));
}

function renderElencoLead() {
  const el = _mount.querySelector('#vdStlLead');
  let righe = [...(DATA.stl || [])];
  if (soloSaltati) righe = righe.filter(r => r.saltato);
  if (!righe.length) {
    el.innerHTML = '<div class="status">' + (soloSaltati ? 'Nessun lead saltato nel periodo.' : 'Nessun lead.') + '</div>';
    return;
  }
  el.innerHTML = '<thead><tr><th>Lead</th><th>Entrato</th><th>Prima chiamata</th><th>Chiamate</th><th>Setter</th></tr></thead><tbody>' +
    righe.map((r, i) => {
      const stato = r.saltato ? '<span class="val-bad">mai chiamato</span>'
        : r.in_attesa ? '<span class="lead-attesa">in attesa</span>'
        : durata(r.minuti);
      const n = +r.n_chiamate || 0;
      const open = _leadOpen.has(leadKey(r));
      let h = `<tr class="lead-click" data-i="${i}"><td class="name">${esc(r.lead || '(senza nome)')}</td>
        <td>${ORA(r.entrata_a)}</td><td>${stato}</td>
        <td>${n ? `<b>${n}</b>` : '0'} <span class="lead-caret">${open ? '▾' : '▸'}</span></td>
        <td>${esc(r.setter || '—')}</td></tr>`;
      if (open) h += `<tr class="lead-det" data-i="${i}"><td colspan="5">${detHtml(r)}</td></tr>`;
      return h;
    }).join('') + '</tbody>';
  el.querySelectorAll('tr.lead-click').forEach(tr => {
    tr.onclick = async () => {
      const r = righe[+tr.dataset.i];
      const k = leadKey(r);
      if (_leadOpen.has(k)) { _leadOpen.delete(k); renderElencoLead(); return; }
      _leadOpen.add(k);
      renderElencoLead();                                   // mostra subito "Carico…"
      const tab = _leadTab.get(k) || 'chiamate';
      if (tab === 'note' && !_leadNote.has(k)) { await fetchLeadNote(r); renderElencoLead(); }
      else if (tab === 'chiamate' && !_leadDet.has(k)) { await fetchLeadDet(r); renderElencoLead(); }
    };
  });
  el.querySelectorAll('tr.lead-det button[data-tab]').forEach(b => {
    b.onclick = async () => {
      const r = righe[+b.closest('tr').dataset.i];
      const k = leadKey(r), t = b.dataset.tab;
      _leadTab.set(k, t);
      renderElencoLead();
      if (t === 'note' && !_leadNote.has(k)) { await fetchLeadNote(r); renderElencoLead(); }
      else if (t === 'chiamate' && !_leadDet.has(k)) { await fetchLeadDet(r); renderElencoLead(); }
    };
  });
}

// ── ciclo di rendering ───────────────────────────────────────────────────────
function renderAll() {
  renderKPI();
  renderStl();
  renderFunnelFilter();
  renderFunnel();
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
    // basta UNA delle due fonti: a inizio giornata ci sono lead entrati e ancora zero
    // esiti registrati, e lo speed to lead è proprio quello che serve vedere in quel momento
    if (!data.perGiorno.length && !data.stl.length) {
      status.textContent = 'Nessuna attività nel periodo selezionato.';
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
        <h2>Speed to lead</h2>
        <div class="subtitle">Quanto passa fra l'ingresso del lead in pipeline e il <strong>primo squillo</strong>.
          Una riga per lead <em>entrato</em> nel periodo (non per chiamata fatta), quindi il filtro periodo qui seleziona la data di ingresso.
          "Mai chiamati" conta solo chi è entrato da oltre 24 ore: chi è arrivato stamattina sta in "In attesa".
          Nell'elenco, <strong>Chiamate</strong> = squilli composti dal log nativo GHL: clicca il lead per vedere le chiamate (quando, da chi, con che esito) e le <strong>note</strong> scritte su di lui in GHL.</div>
        <div class="kpi-row" id="vdStlKpi"></div>
        <div id="vdStl">
          <div class="chart-wrap"><svg id="vdStlChart" width="100%" height="240"></svg></div>
          <div class="table-scroll" style="margin-top:14px"><table id="vdStlTable"></table></div>
          <div class="filters" style="margin:18px 0 8px">
            <span class="filter-cap">Elenco lead</span>
            <button id="vdStlTutti" class="active">Tutti</button>
            <button id="vdStlSaltati">Solo mai chiamati</button>
          </div>
          <div class="table-scroll"><table id="vdStlLead"></table></div>
        </div>
      </div>

      <div class="card">
        <h2>Report attività — nuovi vs vecchi lead</h2>
        <div class="subtitle"><strong>Nuovo</strong> = contatto la cui prima chiamata di sempre cade nel periodo selezionato; tutto il resto è vecchio.
          Gli esiti vengono dagli <strong>stage della pipeline GHL</strong>, classificati e divisi come il foglio KPI CAMPAGNE
          (Show = attesa risposta, trattativa, contratto inviato, chiusi, fissato 2°/3°, vendita non chiusa; Chiusure = solo contratto firmato),
          e contano le opportunità entrate nello stage nel periodo, attribuite al setter tramite i <strong>follower</strong> dell'opportunità
          (se l'opportunità non ha follower: chi ne ha fissato l'appuntamento).
          "Da svolgere" = entrata in uno stage fissato nel periodo e ancora lì.</div>
        <div class="filters" style="margin-bottom:10px">
          <span class="filter-cap">Setter</span>
          <label class="consulente-wrap"><select id="vdFunnelSetter"><option value="">Tutti i setter</option></select></label>
        </div>
        <div class="table-scroll"><table id="vdFunnel"></table></div>
      </div>

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
          "Appuntamenti" esclude le conferme, che riguardano appuntamenti già presi.</div>
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
  const bT = mount.querySelector('#vdStlTutti'), bS = mount.querySelector('#vdStlSaltati');
  bT.onclick = () => { soloSaltati = false; bT.classList.add('active'); bS.classList.remove('active'); if (DATA) renderElencoLead(); };
  bS.onclick = () => { soloSaltati = true; bS.classList.add('active'); bT.classList.remove('active'); if (DATA) renderElencoLead(); };

  await load();
}

export function onResize() {
  if (DATA && _mount && _mount.querySelector('#vdTrend')) { renderTrend(); renderOre(); renderDist(); renderStl(); }
}
