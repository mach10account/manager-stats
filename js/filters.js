// manager-stats · barra filtri condivisa (preset date Europe/Rome + select consulente)
// Stato globale {from, to, consulente}; evento 'filterchange' su document.
import { todayRome, dstr, esc } from './format.js';
import { loadCentri, nomeDi } from './data.js';

const state = { from: null, to: null, consulente: '', mediaBuyer: '' };

// Consulente e Media buyer servono solo a chi ne vede piu' di uno: per chi e'
// limitato ai propri centri (migration 27/29) la tendina avrebbe una voce sola.
// Deciso in initFilters sui centri effettivamente leggibili.
let utile = { consulente: true, mediaBuyer: true };

export function getFilters() { return { ...state }; }
export function filtroConsulenteUtile() { return utile.consulente || utile.mediaBuyer; }

function dispatch() {
  document.dispatchEvent(new CustomEvent('filterchange', { detail: getFilters() }));
}

function computeRange(days) {
  const now = todayRome();
  let to = dstr(now);
  let from;
  if (days === 'mtd') {
    from = to.slice(0, 8) + '01';
  } else if (days === 'ieri') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    from = to = dstr(y);
  } else if (days === 'lastm') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last  = new Date(now.getFullYear(), now.getMonth(), 0);
    from = dstr(first); to = dstr(last);
  } else {
    const f = new Date(now);
    f.setDate(f.getDate() - (days === 0 ? 0 : days - 1));
    from = dstr(f);
  }
  return { from, to };
}

// default sincrono del range (ultimi 30g): se un render parte prima di initFilters()
// lo stato ha già date valide, mai null → niente 400 "invalid input syntax for type date".
Object.assign(state, computeRange(30));

function setRange(days, silent) {
  const { from, to } = computeRange(days);
  state.from = from; state.to = to;
  const fd = document.getElementById('fromDate');
  const td = document.getElementById('toDate');
  if (fd) fd.value = from;
  if (td) td.value = to;
  if (!silent) dispatch();
}

export async function initFilters() {
  // preset date
  document.querySelectorAll('#datePresets button[data-days]').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#datePresets button[data-days]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const v = b.dataset.days;
      setRange(/^\d+$/.test(v) ? +v : v);
    };
  });
  const apply = document.getElementById('applyCustom');
  if (apply) apply.onclick = () => {
    const f = document.getElementById('fromDate').value;
    const t = document.getElementById('toDate').value;
    if (!f || !t) return;
    document.querySelectorAll('#datePresets button[data-days]').forEach(x => x.classList.remove('active'));
    state.from = f; state.to = t;
    dispatch();
  };

  // select Consulente e Media buyer (popolate dall'anagrafica centri, gia'
  // filtrata dalla RLS: chi vede un solo nome non ha bisogno della tendina)
  const sel = document.getElementById('consulenteSelect');
  const selMb = document.getElementById('mediaBuyerSelect');
  if (sel) sel.onchange = () => { state.consulente = sel.value; dispatch(); };
  if (selMb) selMb.onchange = () => { state.mediaBuyer = selMb.value; dispatch(); };

  // ⚠️ il VALUE resta l'email di centri.*: è la chiave con cui filtrano le
  // sezioni (r.consulente === f.consulente) e con cui lo scoping fa i suoi join.
  // Si traduce solo l'etichetta, e si ordina per quella.
  const riempi = (el, campo, etichettaTutti, centri) => {
    const names = [...new Set(centri.map(c => c[campo]).filter(Boolean))]
      .map(v => ({ v, l: nomeDi(v) }))
      .sort((a, b) => a.l.localeCompare(b.l));
    if (el) {
      el.innerHTML = `<option value="">${etichettaTutti}</option>` +
        names.map(n => `<option value="${esc(n.v)}">${esc(n.l)}</option>`).join('');
    }
    return names.length > 1;
  };

  try {
    const centri = await loadCentri();
    utile.consulente = riempi(sel, 'consulente', 'Tutti i consulenti', centri);
    utile.mediaBuyer = riempi(selMb, 'media_buyer', 'Tutti i media buyer', centri);
  } catch (e) {
    if (sel) sel.innerHTML = '<option value="">Tutti i consulenti</option>';
    if (selMb) selMb.innerHTML = '<option value="">Tutti i media buyer</option>';
  }
  // ogni coppia etichetta+tendina sparisce da sola se inutile
  for (const [id, on] of [['consulenteSelect', utile.consulente], ['mediaBuyerSelect', utile.mediaBuyer]]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.closest('label').classList.toggle('hidden', !on);
    const cap = el.closest('label').previousElementSibling;
    if (cap && cap.classList.contains('filter-cap')) cap.classList.toggle('hidden', !on);
  }

  // default: 30 giorni, senza dispatch (il primo render lo fa il router)
  const def = document.querySelector('#datePresets button[data-days="30"]');
  if (def) def.classList.add('active');
  setRange(30, true);
}
