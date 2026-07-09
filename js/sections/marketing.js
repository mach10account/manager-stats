// manager-stats · Sezione Marketing — drill-down Campagna → Adset → Ad
import { supabase } from '../supabase.js';
import { fetchAll, loadCentri, centriMap } from '../data.js';
import { getFilters } from '../filters.js';
import { navigate } from '../router.js';
import { renderTable } from '../tables.js';
import { fmt, eur, eur2, ratio, pctFrac, safeDiv, esc } from '../format.js';

let sort = { key: 'lead', dir: -1 };
let _ctx = null;   // { rows, params } per re-sort senza refetch

const levelCols = [
  { key: 'nome',                  label: 'Nome' },
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
    // spend: somma solo i giorni con dato FB reale; resta null se l'ad non è in fb_insights_ad (mai zeri sintetici)
    if (r.spend !== null && r.spend !== undefined) a.spend = (a.spend || 0) + (+r.spend || 0);
  }
  return [...m.values()].map(a => {
    a.pct_app = safeDiv(a.lead_con_appuntamento, a.lead);
    a.cpl  = a.spend === null ? null : safeDiv(a.spend, a.lead);    // costo per lead attribuito
    a.roas = a.spend === null ? null : safeDiv(a.ricavo, a.spend);  // ricavo / spesa
    return a;
  });
}

function drawBreadcrumb(mount, params) {
  const parts = [];
  parts.push(`<a href="#" data-nav="camp">Campagne</a>`);
  if (params.campaign) {
    const name = _ctx.campName || params.campaign;
    parts.push(`<span class="bc-sep">›</span><a href="#" data-nav="adset">${esc(name)}</a>`);
  }
  if (params.adset) {
    const name = _ctx.adsetName || params.adset;
    parts.push(`<span class="bc-sep">›</span><span class="bc-cur">${esc(name)}</span>`);
  }
  const el = mount.querySelector('#mkBreadcrumb');
  el.innerHTML = parts.join(' ');
  el.querySelector('[data-nav="camp"]').onclick = e => { e.preventDefault(); navigate('/marketing', keepCentro(params)); };
  const ba = el.querySelector('[data-nav="adset"]');
  if (ba) ba.onclick = e => { e.preventDefault(); navigate('/marketing', { ...keepCentro(params), campaign: params.campaign }); };
}

function keepCentro(params) {
  return params.centro ? { centro: params.centro } : {};
}

function draw(mount) {
  const { rows, params } = _ctx;
  let level, idKey, nameKey, nextParam;
  if (!params.campaign) { level = 'campaign'; idKey = 'campaign_id'; nameKey = 'campaign_name'; nextParam = 'campaign'; }
  else if (!params.adset) { level = 'adset'; idKey = 'adset_id'; nameKey = 'adset_name'; nextParam = 'adset'; }
  else { level = 'ad'; idKey = 'ad_id'; nameKey = 'ad_name'; nextParam = null; }

  const grouped = groupBy(rows, idKey, nameKey);
  drawBreadcrumb(mount, params);

  renderTable(mount.querySelector('#mkTable'), levelCols, grouped, sort,
    k => { sort = { key: k, dir: sort.key === k ? -sort.dir : -1 }; draw(mount); },
    {
      barKey: 'lead',
      rowLink: r => !!(nextParam && r._id),
      onRowClick: r => {
        if (!nextParam || !r._id) return;
        const p = { ...keepCentro(params) };
        if (params.campaign) p.campaign = params.campaign;
        p[nextParam] = r._id;
        // memorizza i nomi per il breadcrumb
        if (nextParam === 'campaign') _ctx.campName = r.nome;
        if (nextParam === 'adset') _ctx.adsetName = r.nome;
        navigate('/marketing', p);
      },
    });
}

export async function render(mount, params) {
  const f = getFilters();
  const centro   = params.get('centro') || '';
  const campaign = params.get('campaign') || '';
  const adset    = params.get('adset') || '';
  const P = { centro, campaign, adset };

  let centroLabel = '';
  if (centro) {
    try { await loadCentri(); const c = centriMap().get(centro); if (c) centroLabel = c.nome; } catch (e) { /* auth error surfaced sotto */ }
  }

  mount.innerHTML = `
    <div class="card">
      <h2>Marketing — drill-down</h2>
      <div class="subtitle">${centroLabel ? 'Centro: <b>' + esc(centroLabel) + '</b> · ' : ''}Attribuzione per-lead · costi FB a livello ad (— = ad senza spesa FB nel periodo) · nel periodo selezionato.</div>
      <div class="breadcrumb" id="mkBreadcrumb"></div>
      <div class="table-scroll"><table id="mkTable"></table></div>
    </div>
    <div id="mkStatus" class="status">Caricamento dati…</div>`;

  let rows = await fetchAll((lo, hi) => {
    let q = supabase.from('v_drilldown_ad')
      .select('centro_id,giorno,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,lead,lead_con_appuntamento,appuntamenti,presenze,vendite,ricavo,potenziale,spend')
      .gte('giorno', f.from).lte('giorno', f.to);
    if (centro) q = q.eq('centro_id', centro);
    return q.range(lo, hi);
  });

  // filtro consulente (v_drilldown_ad non ha consulente → via mappa centri)
  if (f.consulente) {
    try { await loadCentri(); } catch (e) { /* ignore */ }
    const map = centriMap();
    rows = rows.filter(r => { const c = map.get(r.centro_id); return c && c.consulente === f.consulente; });
  }
  // livelli inferiori: filtra al ramo scelto
  if (campaign) rows = rows.filter(r => (r.campaign_id || '') === campaign);
  if (adset)    rows = rows.filter(r => (r.adset_id || '') === adset);

  _ctx = { rows, params: P, campName: '', adsetName: '' };
  // ricava i nomi per il breadcrumb dal dataset filtrato
  if (campaign && rows.length) _ctx.campName = rows[0].campaign_name;
  if (adset && rows.length)    _ctx.adsetName = rows[0].adset_name;

  const st = mount.querySelector('#mkStatus');
  if (!st) return;   // render obsoleto: l'utente ha cambiato sezione durante il caricamento
  st.remove();
  if (!rows.length) {
    drawBreadcrumb(mount, P);
    mount.querySelector('#mkTable').innerHTML = '<tbody><tr><td class="name">Nessun dato nel periodo / ramo selezionato.</td></tr></tbody>';
    return;
  }
  draw(mount);
}

export function onResize() { /* nessun grafico */ }
