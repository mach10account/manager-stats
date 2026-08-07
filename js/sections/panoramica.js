// manager-stats · Sezione Panoramica — KPI azienda + tabella per-centro
import { supabase } from '../supabase.js';
import { loadCentri, centriMap } from '../data.js';
import { getFilters } from '../filters.js';
import { navigate } from '../router.js';
// ?v= su tables.js: labelConInfo è un export NUOVO. Senza, un browser con
// tables.js ancora in cache (max-age 600) importerebbe un modulo che non ce
// l'ha e la sezione non si monterebbe affatto. tables.js non ha stato di
// modulo, quindi la doppia copia con le altre sezioni non fa danno.
import { renderTable, renderKpiGroups, labelConInfo } from '../tables.js?v=bench1';
import { fmt, eur, eur2, ratio, safeDiv, pctFrac, esc } from '../format.js';

// ROAS colorato: verde se >= 1 (in utile), rosso se < 1 — il numero resta l'informazione
const roasCell = v => (v === null || v === undefined || isNaN(v)) ? '—'
  : `<span class="${v >= 1 ? 'val-good' : 'val-bad'}">${ratio(v)}</span>`;

// ── benchmark ────────────────────────────────────────────────────────────────
// Gli standard dell'agenzia. Rosso appena il valore è PEGGIO del benchmark:
// niente fasce intermedie, o sei allo standard o non ci sei. Il numero non si
// tocca, si colora soltanto — come già fa il ROAS.
// Valore vuoto (nessun lead, nessuna spesa) resta "—" e non si colora: non
// avere il dato non è un risultato negativo.
// `dec` = decimali con cui la cella mostra il numero. Il colore si decide sul
// valore MOSTRATO, non su quello grezzo: un CPL di 7,40 stampato "7 €" e scritto
// in rosso sotto un benchmark "≤ 7 €" sembrerebbe un errore della dashboard.
// Le percentuali si stampano intere (pctFrac), cioè 2 decimali di frazione.
const BM = {
  cpl: { max: 7, dec: 2, txt: '≤ 7 €',
    info: 'Benchmark: CPL fino a 7 €. Rosso sopra. Si calcola come spesa ads ÷ lead FB '
      + '(i lead dichiarati da Facebook, non quelli poi validati in Notion).' },
  cpa: { max: 40, dec: 0, txt: '≤ 40 €',
    info: 'Benchmark: CPA fino a 40 €. Rosso sopra. Si calcola come spesa ads ÷ appuntamenti fissati '
      + 'nel periodo — costo per appuntamento preso, non per appuntamento presentato.' },
  cps: { max: 90, dec: 0, txt: '≤ 90 €',
    info: 'Benchmark: CPS fino a 90 €. Rosso sopra. Si calcola come spesa ads ÷ presenze: '
      + 'quanto costa una persona che si presenta davvero in centro.' },
  pct_risposta: { min: 0.60, dec: 2, txt: '≥ 60%',
    info: 'Benchmark: almeno il 60% dei lead risponde. Rosso sotto. Si calcola come lead che hanno '
      + 'risposto ÷ lead reali; la risposta è quella registrata sulle chiamate del CRM.' },
  pct_prenotazione: { min: 0.18, dec: 2, txt: '≥ 18%',
    info: 'Benchmark: almeno il 18% dei lead prende appuntamento. Rosso sotto. Si calcola come '
      + 'appuntamenti fissati ÷ lead reali, non sui lead FB: il setter lavora quelli veri.' },
  pct_show: { min: 0.45, dec: 2, txt: '≥ 45%',
    info: 'Benchmark: almeno il 45% degli appuntamenti si presenta. Rosso sotto. Si calcola come '
      + 'presenze ÷ (presenze + no show), quindi solo sugli appuntamenti arrivati a scadenza.' },
};
const fuoriBench = (v, b) => {
  const p = Math.pow(10, b.dec);
  const m = Math.round(v * p) / p;
  return (b.max !== undefined && m > b.max) || (b.min !== undefined && m < b.min);
};
// fmt di una colonna con benchmark
const bench = (key, base) => v => (v === null || v === undefined || isNaN(v)) ? '—'
  : (fuoriBench(v, BM[key]) ? `<span class="val-bad">${base(v)}</span>` : base(v));
// etichetta di colonna con la ⓘ: la soglia si legge in hover, l'intestazione
// resta pulita (la tabella ha già venti colonne)
const lblBench = (key, label) => labelConInfo(label, BM[key].info);

let sort = { key: 'spesa', dir: -1 };
let search = '';
let _rows = [];   // aggregati per centro (per re-sort / re-filter senza refetch)

const cols = [
  { key: 'centro',           label: 'Centro' },
  { key: 'spesa',            label: 'Spesa',        fmt: eur },
  { key: 'lead_fb',          label: 'Lead FB',      fmt: fmt },
  { key: 'lead_reali',       label: 'Lead reali',   fmt: fmt },
  { key: 'pct_risposta',     label: lblBench('pct_risposta', '% Risposta'),     fmt: bench('pct_risposta', pctFrac) },
  { key: 'cpl',              label: lblBench('cpl', 'CPL'),                     fmt: bench('cpl', eur2) },
  { key: 'appuntamenti',     label: 'App.',         fmt: fmt },
  { key: 'pct_prenotazione', label: lblBench('pct_prenotazione', '% Prenot.'),  fmt: bench('pct_prenotazione', pctFrac) },
  { key: 'cpa',              label: lblBench('cpa', 'CPA'),                     fmt: bench('cpa', eur) },
  { key: 'presenze',         label: 'Presenze',     fmt: fmt },
  { key: 'non_presentati',   label: 'No show',      fmt: fmt },
  { key: 'pct_show',         label: lblBench('pct_show', '% Show'),             fmt: bench('pct_show', pctFrac) },
  { key: 'cps',              label: lblBench('cps', 'CPS'),                     fmt: bench('cps', eur) },
  { key: 'pacchetti',        label: 'Pacchetti',    fmt: fmt },
  { key: 'cpv',              label: 'CPV',          fmt: eur },
  { key: 'ricavo',           label: 'Ricavo',       fmt: eur },
  { key: 'roas',             label: 'ROAS',         fmt: roasCell },
  { key: 'potenziale',       label: 'Potenziale',   fmt: eur },
  { key: 'roas_pot',         label: 'ROAS pot.',    fmt: ratio },
  { key: 'pct_chiusura',     label: '% Chiusura',   fmt: pctFrac },
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
  // risposte e appuntamenti si misurano sui LEAD REALI, non sui lead FB: i lead
  // FB sono quelli dichiarati da Facebook, i reali quelli che esistono davvero
  // in Notion ed è su quelli che il setter lavora.
  r.pct_risposta     = safeDiv(r.risposte, r.lead_reali);
  r.pct_prenotazione = safeDiv(r.appuntamenti, r.lead_reali);
  return r;
}

// Le righe arrivano dalla RPC già aggregate per centro sul periodo: qui restano
// solo la coercizione a numero e la riga "(senza centro)" per i lead orfani.
const NUM = ['spesa', 'impression', 'lead_fb', 'lead_reali', 'risposte', 'appuntamenti', 'presenze', 'non_presentati', 'pacchetti', 'ricavo', 'potenziale'];
function normalizza(r) {
  const a = { centro_id: r.centro_id || null, centro: r.centro || '(senza centro)', consulente: r.consulente || null };
  for (const k of NUM) a[k] = (+r[k] || 0);
  return deriveRatios(a);
}

function draw(mount) {
  let rows = _rows;
  if (search) rows = rows.filter(r => r.centro.toLowerCase().includes(search));

  // KPI azienda dai totali del range, raggruppati a funnel: investimento → appuntamenti → vendite
  const T = { spesa: 0, lead_fb: 0, appuntamenti: 0, presenze: 0, non_presentati: 0, pacchetti: 0, ricavo: 0 };
  for (const r of rows) for (const k of Object.keys(T)) T[k] += (+r[k] || 0);
  const roas = safeDiv(T.ricavo, T.spesa);
  // stessi benchmark della tabella, sui totali del periodo: un KPI in cima
  // verde e la stessa colonna rossa sotto sarebbero due messaggi diversi
  const cplT = safeDiv(T.spesa, T.lead_fb);
  const cpaT = safeDiv(T.spesa, T.appuntamenti);
  const showT = safeDiv(T.presenze, T.presenze + T.non_presentati);
  const toneBench = (key, v) => (v === null || v === undefined || isNaN(v)) ? undefined
    : (fuoriBench(v, BM[key]) ? 'bad' : 'good');
  renderKpiGroups(mount.querySelector('#pnKpi'), [
    { step: 1, title: 'Investimento', tiles: [
      { label: 'Spesa ads', value: eur(T.spesa), hero: true },
      { label: 'Lead FB',   value: fmt(T.lead_fb) },
      { label: 'CPL',       value: eur2(cplT), tone: toneBench('cpl', cplT),
        sub: 'spesa / lead FB · benchmark ' + BM.cpl.txt },
    ] },
    { step: 2, title: 'Appuntamenti', tiles: [
      { label: 'Appuntamenti', value: fmt(T.appuntamenti), hero: true },
      { label: 'CPA',      value: eur(cpaT), tone: toneBench('cpa', cpaT),
        sub: 'spesa / app. · benchmark ' + BM.cpa.txt },
      { label: 'Presenze', value: fmt(T.presenze) },
      { label: '% Show',   value: pctFrac(showT), tone: toneBench('pct_show', showT),
        sub: 'su presenze + no show · benchmark ' + BM.pct_show.txt },
    ] },
    { step: 3, title: 'Vendite', tiles: [
      { label: 'Ricavo', value: eur(T.ricavo), hero: true },
      { label: 'ROAS',   value: ratio(roas), sub: 'ricavo / spesa',
        tone: roas === null ? undefined : (roas >= 1 ? 'good' : 'bad') },
      { label: 'Pacchetti',  value: fmt(T.pacchetti) },
      { label: '% Chiusura', value: pctFrac(safeDiv(T.pacchetti, T.presenze)), sub: 'pacchetti / presenze' },
    ] },
  ]);

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
    <div class="kpi-groups" id="pnKpi"></div>
    <div class="card">
      <h2>Per centro</h2>
      <div class="subtitle">Nel periodo selezionato · KPI ricalcolati sui totali. Clicca una riga per il dettaglio Campagne / Adset / Ad.</div>
      <input type="search" id="pnSearch" placeholder="Cerca centro…" value="${esc(search)}">
      <div class="table-scroll"><table id="pnTable"></table></div>
    </div>
    <div id="pnStatus" class="status loading">Caricamento dati…</div>`;

  mount.querySelector('#pnSearch').oninput = e => { search = e.target.value.toLowerCase(); draw(mount); };

  // UNA chiamata aggregata (RPC sopra v_panoramica_centro) al posto della
  // paginazione per giorno: ogni pagina di fetchAll ricalcolava l'intera vista
  // e sotto carico sforava statement_timeout (57014). L'aggregato per centro
  // lo facevamo comunque qui in JS: ora lo fa il DB, in un giro solo.
  const { data, error } = await supabase.rpc('api_panoramica_centro', { p_from: f.from, p_to: f.to });
  if (error) throw error;

  let rows = (data || []).map(normalizza);
  if (f.consulente) rows = rows.filter(r => r.consulente === f.consulente);
  // il media buyer non e' nella vista: si passa dall'anagrafica centri
  if (f.mediaBuyer) {
    try { await loadCentri(); } catch (e) { /* anagrafica non disponibile */ }
    const map = centriMap();
    rows = rows.filter(r => {
      const c = map.get(r.centro_id);
      return c && c.media_buyer === f.mediaBuyer;
    });
  }
  _rows = rows;

  const st = mount.querySelector('#pnStatus');
  if (!st) return;   // render obsoleto: l'utente ha cambiato sezione durante il caricamento
  st.remove();
  if (!_rows.length) {
    mount.querySelector('#pnTable').innerHTML = '';
    mount.querySelector('#pnKpi').innerHTML = '<div class="status">Nessun dato nel periodo selezionato.</div>';
    return;
  }
  draw(mount);
}

export function onResize() { /* nessun grafico */ }
