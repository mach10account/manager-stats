// manager-stats · Dettaglio centro (da click in Panoramica) — tab Campagne / Adset / Ad
import { supabase } from '../supabase.js';
import { fetchAll, loadCentri, centriMap } from '../data.js';
import { getFilters } from '../filters.js';
import { navigate } from '../router.js';
import { renderTable } from '../tables.js';
import { fmt, eur, eur2, ratio, pctFrac, safeDiv, esc } from '../format.js';

let sort = { key: 'lead', dir: -1 };
let _ctx = null;   // { rows, centro, tab } per re-sort / cambio tab senza refetch

const TABS = [
  { key: 'campaign', label: 'Campagne', col: 'Campagna', idKey: 'campaign_id', nameKey: 'campaign_name' },
  { key: 'adset',    label: 'Adset',    col: 'Adset',    idKey: 'adset_id',    nameKey: 'adset_name' },
  { key: 'ad',       label: 'Ad',       col: 'Ad',       idKey: 'ad_id',       nameKey: 'ad_name' },
];

function makeCols(firstLabel) {
  return [
    { key: 'nome',                  label: firstLabel },
    { key: 'lead',                  label: 'Lead',           fmt: fmt },
    { key: 'lead_con_appuntamento', label: 'Lead con app.',  fmt: fmt },
    { key: 'pct_app',               label: '% App.',         fmt: pctFrac },
    { key: 'presenze',              label: 'Presenze',       fmt: fmt },
    { key: 'vendite',               label: 'Vendite',        fmt: fmt },
    { key: 'ricavo',                label: 'Ricavo',         fmt: eur },
    { key: 'potenziale',            label: 'Potenziale',     fmt: eur },
    { key: 'spend',                 label: 'Spesa',          fmt: v => v === null || v === undefined ? '—' : eur(v) },
    { key: 'cpl',                   label: 'CPL',            fmt: eur2 },
    { key: 'roas',                  label: 'ROAS',           fmt: ratio },
  ];
}

function groupBy(rows, idKey, nameKey) {
  const m = new Map();
  const SUM = ['lead', 'lead_con_appuntamento', 'presenze', 'vendite', 'ricavo', 'potenziale'];
  for (const r of rows) {
    const id = r[idKey] || '__none__';
    let a = m.get(id);
    if (!a) {
      a = { _id: r[idKey] || null, nome: r[nameKey] || '(senza nome)', spend: null };
      for (const k of SUM) a[k] = 0;
      m.set(id, a);
    }
    for (const k of SUM) a[k] += (+r[k] || 0);
    // spend: somma solo i giorni con dato FB reale; resta null se non c'è in fb_insights_ad (mai zeri sintetici)
    if (r.spend !== null && r.spend !== undefined) a.spend = (a.spend || 0) + (+r.spend || 0);
  }
  return [...m.values()].map(a => {
    a.pct_app = safeDiv(a.lead_con_appuntamento, a.lead);
    a.cpl  = a.spend === null ? null : safeDiv(a.spend, a.lead);    // costo per lead attribuito
    a.roas = a.spend === null ? null : safeDiv(a.ricavo, a.spend);  // ricavo / spesa
    return a;
  });
}

function drawDetail(mount) {
  const t = TABS.find(x => x.key === _ctx.tab) || TABS[0];
  mount.querySelectorAll('.mk-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t.key));

  const rows = groupBy(_ctx.rows, t.idKey, t.nameKey);
  renderTable(mount.querySelector('#mkTable'), makeCols(t.col), rows, sort,
    k => { sort = { key: k, dir: sort.key === k ? -sort.dir : -1 }; drawDetail(mount); },
    { barKey: 'lead' });
}

export async function render(mount, params) {
  const centro = params.get('centro') || '';
  if (!centro) { navigate('/panoramica'); return; }   // la sezione esiste solo come drill-down

  const f = getFilters();
  const tabParam = params.get('tab') || 'campaign';

  let centroLabel = '';
  try { await loadCentri(); const c = centriMap().get(centro); if (c) centroLabel = c.nome; } catch (e) { /* auth error surfaced sotto */ }

  mount.innerHTML = `
    <div class="card">
      <div class="mk-head">
        <button id="mkBack" class="btn-back">← Indietro</button>
        <h2>${esc(centroLabel || '(senza nome)')}</h2>
      </div>
      <div class="subtitle">Attribuzione per-lead · costi FB a livello ad (— = senza spesa FB nel periodo) · nel periodo selezionato.</div>
      <div class="lead-tabs mk-tabs">${TABS.map(t => `<button data-tab="${t.key}">${t.label}</button>`).join('')}</div>
      <div class="table-scroll"><table id="mkTable"></table></div>
    </div>
    <div id="mkStatus" class="status loading">Caricamento dati…</div>`;
  mount.querySelector('#mkBack').onclick = () => navigate('/panoramica');
  mount.querySelectorAll('.mk-tabs button').forEach(b => b.onclick = () => {
    if (!_ctx || _ctx.centro !== centro) return;   // dati non ancora caricati
    _ctx.tab = b.dataset.tab;
    history.replaceState(null, '', '#/marketing?' + new URLSearchParams({ centro, tab: _ctx.tab }));
    drawDetail(mount);
  });

  const rows = await fetchAll((lo, hi) =>
    supabase.from('v_drilldown_ad')
      .select('centro_id,giorno,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,lead,lead_con_appuntamento,appuntamenti,presenze,vendite,ricavo,potenziale,spend')
      .gte('giorno', f.from).lte('giorno', f.to)
      .eq('centro_id', centro)
      .range(lo, hi));

  _ctx = { rows, centro, tab: TABS.some(t => t.key === tabParam) ? tabParam : 'campaign' };

  const st = mount.querySelector('#mkStatus');
  if (!st) return;   // render obsoleto: l'utente ha cambiato sezione durante il caricamento
  st.remove();
  if (!rows.length) {
    mount.querySelectorAll('.mk-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === _ctx.tab));
    mount.querySelector('#mkTable').innerHTML = '<tbody><tr><td class="name">Nessun dato nel periodo selezionato.</td></tr></tbody>';
    return;
  }
  drawDetail(mount);
}

export function onResize() { /* nessun grafico */ }
