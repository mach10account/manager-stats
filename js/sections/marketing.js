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

// Funnel del periodo: totali del centro (indipendenti dal tab attivo).
// Larghezza barre proporzionale ai volumi; % di passaggio tra le fasi.
function drawFunnel(mount) {
  const card = mount.querySelector('#mkFunnelCard');
  if (!card) return;

  const tot = { lead: 0, app: 0, presenze: 0, vendite: 0, ricavo: 0, spend: null };
  for (const r of _ctx.rows) {
    tot.lead     += (+r.lead || 0);
    tot.app      += (+r.lead_con_appuntamento || 0);
    tot.presenze += (+r.presenze || 0);
    tot.vendite  += (+r.vendite || 0);
    tot.ricavo   += (+r.ricavo || 0);
    if (r.spend !== null && r.spend !== undefined) tot.spend = (tot.spend || 0) + (+r.spend || 0);
  }
  if (!tot.lead) { card.hidden = true; return; }

  const stages = [
    { nome: 'Lead',          val: tot.lead },
    { nome: 'Lead con app.', val: tot.app },
    { nome: 'Presenze',      val: tot.presenze },
    { nome: 'Vendite',       val: tot.vendite },
  ];

  let html = '';
  stages.forEach((s, i) => {
    if (i > 0) {
      const conv = safeDiv(s.val, stages[i - 1].val);
      html += `<div class="f-step">↓ ${conv === null ? '—' : pctFrac(conv)}</div>`;
    }
    const w = Math.max(s.val / tot.lead * 100, 2.5);
    html += `
      <div class="f-label"><span class="f-name">${s.nome}</span>
        <span class="f-val">${fmt(s.val)}</span>
        <span class="f-share">${pctFrac(safeDiv(s.val, tot.lead))}</span></div>
      <div class="f-bar f-bar-${i + 1}" style="width:${w}%"></div>`;
  });
  card.querySelector('#mkFunnel').innerHTML = html;

  const kpi = (label, val, sub) => `
    <div class="f-kpi"><span class="f-kpi-label">${label}</span>
      <span class="f-kpi-val">${val}</span>${sub ? `<span class="f-kpi-sub">${sub}</span>` : ''}</div>`;
  card.querySelector('#mkFunnelKpis').innerHTML =
    kpi('Conversione lead → vendita', pctFrac(safeDiv(tot.vendite, tot.lead))) +
    kpi('Costo per presenza', tot.spend === null || !tot.presenze ? '—' : eur2(tot.spend / tot.presenze),
        tot.spend === null ? 'senza spesa FB' : `${eur(tot.spend)} / ${fmt(tot.presenze)}`) +
    kpi('Costo per vendita', tot.spend === null || !tot.vendite ? '—' : eur2(tot.spend / tot.vendite),
        tot.spend === null ? '' : `${eur(tot.spend)} / ${fmt(tot.vendite)}`);

  card.querySelector('#mkFunnelSpend').innerHTML =
    `Spesa <b>${tot.spend === null ? '—' : eur(tot.spend)}</b> · Ricavo <b>${eur(tot.ricavo)}</b>`;
  card.hidden = false;
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
    <div class="card" id="mkFunnelCard" hidden>
      <div class="funnel-head">
        <h2>Funnel del periodo</h2>
        <span class="funnel-spend" id="mkFunnelSpend"></span>
      </div>
      <div class="subtitle">Dal lead alla vendita, sul totale del centro nel periodo selezionato.</div>
      <div class="funnel" id="mkFunnel"></div>
      <div class="funnel-kpis" id="mkFunnelKpis"></div>
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
  drawFunnel(mount);
}

export function onResize() { /* nessun grafico */ }
