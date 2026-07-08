// manager-stats · Sezione Coorti — funnel per mese di CREAZIONE lead
import { supabase } from '../supabase.js';
import { fetchAll, loadCentri, centriMap } from '../data.js';
import { getFilters } from '../filters.js';
import { renderTable } from '../tables.js';
import { fmt, eur, pctFrac, safeDiv } from '../format.js';

let sort = { key: 'mese_coorte', dir: -1 };
let _rows = [];

// cella composita "valore (percentuale)"
const withPct = (num, den) => `${fmt(num)} <span class="cell-sub">${pctFrac(safeDiv(num, den))}</span>`;

const cols = [
  { key: 'mese_coorte', label: 'Coorte (mese)' },
  { key: 'lead',        label: 'Lead',          fmt: fmt },
  { key: 'lead_con_appuntamento', label: 'Con app.', fmt: (v, r) => withPct(v, r.lead) },
  { key: 'presenze',    label: 'Presenze',      fmt: (v, r) => withPct(v, r.lead_con_appuntamento) },
  { key: 'vendite',     label: 'Vendite',       fmt: (v, r) => withPct(v, r.presenze) },
  { key: 'ricavo',      label: 'Ricavo',        fmt: eur },
  { key: 'potenziale',  label: 'Potenziale',    fmt: eur },
  { key: 'appt_pendenti', label: 'In maturazione', fmt: v => v > 0 ? `<span class="badge">${fmt(v)} in maturazione</span>` : '—' },
];

function aggregate(rows) {
  const m = new Map();
  const SUM = ['lead', 'lead_con_appuntamento', 'presenze', 'vendite', 'ricavo', 'potenziale', 'appt_pendenti'];
  for (const r of rows) {
    const k = r.mese_coorte;
    let a = m.get(k);
    if (!a) { a = { mese_coorte: k }; for (const s of SUM) a[s] = 0; m.set(k, a); }
    for (const s of SUM) a[s] += (+r[s] || 0);
  }
  return [...m.values()];
}

function draw(mount) {
  renderTable(mount.querySelector('#coTable'), cols, _rows, sort,
    k => { sort = { key: k, dir: sort.key === k ? -sort.dir : -1 }; draw(mount); },
    { barKey: 'lead' });
}

export async function render(mount, params) {
  const f = getFilters();
  mount.innerHTML = `
    <div class="card">
      <h2>Coorti mensili</h2>
      <div class="subtitle">Coorte = mese di creazione del lead. Gli eventi (app./presenze/vendite) sono attribuiti alla coorte del lead. I mesi recenti continuano a maturare.</div>
      <div class="table-scroll"><table id="coTable"></table></div>
    </div>
    <div id="coStatus" class="status">Caricamento dati…</div>`;

  let rows = await fetchAll((lo, hi) =>
    supabase.from('agg_coorte_mese_centro')
      .select('centro_id,mese_coorte,lead,lead_con_appuntamento,presenze,vendite,ricavo,potenziale,appt_pendenti')
      .range(lo, hi));

  // filtro consulente via mappa centri
  if (f.consulente) {
    try { await loadCentri(); } catch (e) { /* ignore */ }
    const map = centriMap();
    rows = rows.filter(r => { const c = map.get(r.centro_id); return c && c.consulente === f.consulente; });
  }

  _rows = aggregate(rows);
  mount.querySelector('#coStatus').remove();
  if (!_rows.length) {
    mount.querySelector('#coTable').innerHTML = '<tbody><tr><td class="name">Nessuna coorte disponibile.</td></tr></tbody>';
    return;
  }
  draw(mount);
}

export function onResize() { /* nessun grafico */ }
