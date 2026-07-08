// manager-stats · Sezione Panoramica — KPI azienda + tabella per-centro
import { supabase } from '../supabase.js';
import { fetchAll } from '../data.js';
import { getFilters } from '../filters.js';
import { navigate } from '../router.js';
import { renderTable, renderKpiRow } from '../tables.js';
import { fmt, eur, ratio, safeDiv, pctFrac, esc } from '../format.js';

let sort = { key: 'spesa', dir: -1 };
let search = '';
let _rows = [];   // aggregati per centro (per re-sort / re-filter senza refetch)

const cols = [
  { key: 'centro',         label: 'Centro' },
  { key: 'spesa',          label: 'Spesa',        fmt: eur },
  { key: 'lead_fb',        label: 'Lead FB',      fmt: fmt },
  { key: 'lead_reali',     label: 'Lead reali',   fmt: fmt },
  { key: 'cpl',            label: 'CPL',          fmt: eur },
  { key: 'appuntamenti',   label: 'App.',         fmt: fmt },
  { key: 'cpa',            label: 'CPA',          fmt: eur },
  { key: 'presenze',       label: 'Presenze',     fmt: fmt },
  { key: 'non_presentati', label: 'No show',      fmt: fmt },
  { key: 'cps',            label: 'CPS',          fmt: eur },
  { key: 'pacchetti',      label: 'Pacchetti',    fmt: fmt },
  { key: 'cpv',            label: 'CPV',          fmt: eur },
  { key: 'ricavo',         label: 'Ricavo',       fmt: eur },
  { key: 'roas',           label: 'ROAS',         fmt: ratio },
  { key: 'potenziale',     label: 'Potenziale',   fmt: eur },
  { key: 'roas_pot',       label: 'ROAS pot.',    fmt: ratio },
  { key: 'pct_show',       label: '% Show',       fmt: pctFrac },
  { key: 'pct_chiusura',   label: '% Chiusura',   fmt: pctFrac },
];

function deriveRatios(r) {
  r.cpl          = safeDiv(r.spesa, r.lead_fb);
  r.cpa          = safeDiv(r.spesa, r.appuntamenti);
  r.cps          = safeDiv(r.spesa, r.presenze);
  r.cpv          = safeDiv(r.spesa, r.pacchetti);
  r.roas         = safeDiv(r.ricavo, r.spesa);
  r.roas_pot     = safeDiv(r.potenziale, r.spesa);
  r.pct_show     = safeDiv(r.presenze, r.presenze + r.non_presentati);
  r.pct_chiusura = safeDiv(r.pacchetti, r.presenze);
  return r;
}

function aggregate(daily) {
  const m = new Map();
  const NUM = ['spesa', 'impression', 'lead_fb', 'lead_reali', 'appuntamenti', 'presenze', 'non_presentati', 'pacchetti', 'ricavo', 'potenziale'];
  for (const row of daily) {
    const id = row.centro_id || '__none__';
    let a = m.get(id);
    if (!a) {
      a = { centro_id: row.centro_id || null, centro: row.centro || '(senza centro)', consulente: row.consulente || null };
      for (const k of NUM) a[k] = 0;
      m.set(id, a);
    }
    for (const k of NUM) a[k] += (+row[k] || 0);
  }
  return [...m.values()].map(deriveRatios);
}

function draw(mount) {
  let rows = _rows;
  if (search) rows = rows.filter(r => r.centro.toLowerCase().includes(search));

  // KPI azienda dai totali del range
  const T = { spesa: 0, lead_fb: 0, appuntamenti: 0, presenze: 0, non_presentati: 0, pacchetti: 0, ricavo: 0 };
  for (const r of rows) for (const k of Object.keys(T)) T[k] += (+r[k] || 0);
  const tiles = [
    { label: 'Spesa',        value: eur(T.spesa) },
    { label: 'Lead FB',      value: fmt(T.lead_fb) },
    { label: 'CPL',          value: eur(safeDiv(T.spesa, T.lead_fb)), sub: 'spesa / lead FB' },
    { label: 'Appuntamenti', value: fmt(T.appuntamenti) },
    { label: 'CPA',          value: eur(safeDiv(T.spesa, T.appuntamenti)), sub: 'spesa / appuntamenti' },
    { label: 'Presenze',     value: fmt(T.presenze) },
    { label: '% Show',       value: pctFrac(safeDiv(T.presenze, T.presenze + T.non_presentati)), sub: 'presenze / (presenze + no show)' },
    { label: 'Pacchetti',    value: fmt(T.pacchetti) },
    { label: '% Chiusura',   value: pctFrac(safeDiv(T.pacchetti, T.presenze)), sub: 'pacchetti / presenze' },
    { label: 'Ricavo',       value: eur(T.ricavo) },
    { label: 'ROAS',         value: ratio(safeDiv(T.ricavo, T.spesa)), sub: 'ricavo / spesa' },
  ];
  renderKpiRow(mount.querySelector('#pnKpi'), tiles);

  renderTable(mount.querySelector('#pnTable'), cols, rows, sort,
    k => { sort = { key: k, dir: sort.key === k ? -sort.dir : -1 }; draw(mount); },
    {
      barKey: 'spesa',
      rowLink: r => !!r.centro_id,
      onRowClick: r => { if (r.centro_id) navigate('/marketing', { centro: r.centro_id }); },
    });
}

export async function render(mount, params) {
  const f = getFilters();
  mount.innerHTML = `
    <div class="kpi-row" id="pnKpi"></div>
    <div class="card">
      <h2>Per centro</h2>
      <div class="subtitle">Nel periodo selezionato · KPI ricalcolati sui totali. Clicca una riga per il drill-down marketing.</div>
      <input type="search" id="pnSearch" placeholder="Cerca centro…" value="${esc(search)}">
      <div class="table-scroll"><table id="pnTable"></table></div>
    </div>
    <div id="pnStatus" class="status">Caricamento dati…</div>`;

  mount.querySelector('#pnSearch').oninput = e => { search = e.target.value.toLowerCase(); draw(mount); };

  const daily = await fetchAll((lo, hi) =>
    supabase.from('v_panoramica_centro')
      .select('centro_id,giorno,centro,consulente,spesa,impression,lead_fb,lead_reali,appuntamenti,presenze,non_presentati,pacchetti,ricavo,potenziale')
      .gte('giorno', f.from).lte('giorno', f.to)
      .range(lo, hi));

  let rows = aggregate(daily);
  if (f.consulente) rows = rows.filter(r => r.consulente === f.consulente);
  _rows = rows;

  mount.querySelector('#pnStatus').remove();
  if (!_rows.length) {
    mount.querySelector('#pnTable').innerHTML = '';
    mount.querySelector('#pnKpi').innerHTML = '<div class="status">Nessun dato nel periodo selezionato.</div>';
    return;
  }
  draw(mount);
}

export function onResize() { /* nessun grafico */ }
