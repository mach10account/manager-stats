// manager-stats · barra filtri condivisa (preset date Europe/Rome + select consulente)
// Stato globale {from, to, consulente}; evento 'filterchange' su document.
import { todayRome, dstr, esc } from './format.js';
import { loadCentri } from './data.js';

const state = { from: null, to: null, consulente: '' };

export function getFilters() { return { ...state }; }

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

  // select consulente (popolata dall'anagrafica centri)
  const sel = document.getElementById('consulenteSelect');
  if (sel) {
    sel.onchange = () => { state.consulente = sel.value; dispatch(); };
    try {
      const centri = await loadCentri();
      const names = [...new Set(centri.map(c => c.consulente).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
      sel.innerHTML = '<option value="">Tutti i consulenti</option>' +
        names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    } catch (e) {
      sel.innerHTML = '<option value="">Tutti i consulenti</option>';
    }
  }

  // default: 30 giorni, senza dispatch (il primo render lo fa il router)
  const def = document.querySelector('#datePresets button[data-days="30"]');
  if (def) def.classList.add('active');
  setRange(30, true);
}
