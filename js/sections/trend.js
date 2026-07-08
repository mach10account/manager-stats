// manager-stats · Sezione Andamento — line chart per metrica × granularità
import { supabase } from '../supabase.js';
import { fetchAll } from '../data.js';
import { getFilters } from '../filters.js';
import { renderLineChart } from '../charts.js';
import { fmt, fmt1, eur, ratio, safeDiv, fmtCompact, dstr, dlab } from '../format.js';

let _daily = [];
let metric = 'spesa';
let gran = 'giorno';

const METRICS = {
  spesa:        { label: 'Spesa',        kind: 'sum',   field: 'spesa',        fmt: eur,   axis: v => fmtCompact(v) + ' €' },
  lead_fb:      { label: 'Lead FB',      kind: 'sum',   field: 'lead_fb',      fmt: fmt,   axis: fmtCompact },
  lead_reali:   { label: 'Lead reali',   kind: 'sum',   field: 'lead_reali',   fmt: fmt,   axis: fmtCompact },
  appuntamenti: { label: 'Appuntamenti', kind: 'sum',   field: 'appuntamenti', fmt: fmt,   axis: fmtCompact },
  presenze:     { label: 'Presenze',     kind: 'sum',   field: 'presenze',     fmt: fmt,   axis: fmtCompact },
  ricavo:       { label: 'Ricavo',       kind: 'sum',   field: 'ricavo',       fmt: eur,   axis: v => fmtCompact(v) + ' €' },
  cpl:          { label: 'CPL',          kind: 'ratio', num: 'spesa', den: 'lead_fb', fmt: eur,   axis: v => fmtCompact(v) + ' €' },
  roas:         { label: 'ROAS',         kind: 'ratio', num: 'ricavo', den: 'spesa',  fmt: ratio, axis: v => fmt1(v) + 'x' },
};
const SUMFIELDS = ['spesa', 'lead_fb', 'lead_reali', 'appuntamenti', 'presenze', 'ricavo'];

function weekStart(iso) {
  const d = new Date(iso + 'T00:00:00');
  const day = (d.getDay() + 6) % 7;  // 0 = lunedì
  d.setDate(d.getDate() - day);
  return dstr(d);
}

function bucketKey(iso) {
  if (gran === 'settimana') return weekStart(iso);
  if (gran === 'mese')      return iso.slice(0, 7);
  return iso;
}

function xlab(key) {
  if (gran === 'mese') { const [y, m] = key.split('-'); return m + '/' + y.slice(2); }
  return dlab(key);   // dd/mm
}

function buildBuckets() {
  const f = getFilters();
  const m = new Map();
  for (const row of _daily) {
    if (f.consulente && row.consulente !== f.consulente) continue;
    const key = bucketKey(row.giorno);
    let a = m.get(key);
    if (!a) { a = { key }; for (const k of SUMFIELDS) a[k] = 0; m.set(key, a); }
    for (const k of SUMFIELDS) a[k] += (+row[k] || 0);
  }
  const keys = [...m.keys()].sort();
  const def = METRICS[metric];
  const labels = keys;
  const rows = keys.map(k => {
    const b = m.get(k);
    let v;
    if (def.kind === 'sum') v = b[def.field];
    else v = safeDiv(b[def.num], b[def.den]) || 0;
    return { value: v };
  });
  return { labels, rows };
}

function draw(mount) {
  const def = METRICS[metric];
  const { labels, rows } = buildBuckets();
  const svg = mount.querySelector('#trChart');
  const padL = (metric === 'spesa' || metric === 'ricavo' || metric === 'cpl') ? 56 : 44;
  renderLineChart(svg, labels, rows, [{ key: 'value', color: '--series-1', name: def.label }], {
    height: 300, padL,
    yfmt: def.fmt, axisFmt: def.axis, xlab,
    lastLabels: true,
    tip: (r, label) => `<div class="t-date">${xlab(label)}</div>
      <div class="t-row"><span>${def.label}</span><b>${def.fmt(r.value)}</b></div>`,
  });
}

export async function render(mount, params) {
  const f = getFilters();
  mount.innerHTML = `
    <div class="card">
      <h2>Andamento nel tempo</h2>
      <div class="subtitle">Metrica calcolata sui totali di ciascun periodo.</div>
      <div class="chart-controls">
        <label>Metrica
          <select id="trMetric">${Object.entries(METRICS).map(([k, v]) => `<option value="${k}" ${k === metric ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        </label>
        <label>Granularità
          <select id="trGran">
            <option value="giorno" ${gran === 'giorno' ? 'selected' : ''}>Giorno</option>
            <option value="settimana" ${gran === 'settimana' ? 'selected' : ''}>Settimana</option>
            <option value="mese" ${gran === 'mese' ? 'selected' : ''}>Mese</option>
          </select>
        </label>
      </div>
      <div class="chart-wrap"><svg id="trChart" width="100%" height="300"></svg></div>
    </div>
    <div id="trStatus" class="status">Caricamento dati…</div>`;

  mount.querySelector('#trMetric').onchange = e => { metric = e.target.value; draw(mount); };
  mount.querySelector('#trGran').onchange   = e => { gran = e.target.value; draw(mount); };

  _daily = await fetchAll((lo, hi) =>
    supabase.from('v_panoramica_centro')
      .select('centro_id,giorno,consulente,spesa,lead_fb,lead_reali,appuntamenti,presenze,ricavo')
      .gte('giorno', f.from).lte('giorno', f.to)
      .range(lo, hi));

  mount.querySelector('#trStatus').remove();
  draw(mount);
}

export function onResize() {
  const mount = document.getElementById('app');
  if (mount && mount.querySelector('#trChart')) draw(mount);
}
