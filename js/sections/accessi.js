// manager-stats · Sezione Accessi — chi vede cosa (solo amministratori)
//
// Il blocco vero sta nel database: ogni tabella ha una policy RLS che interroga
// public.ms_puo(area). Questo pannello scrive soltanto in public.ms_accessi, via
// le RPC ms_lista_utenti / ms_imposta_sezioni, che a loro volta rifiutano il
// chiamante non-admin. Nascondere la voce di menu è comodità, non sicurezza.
import { supabase } from '../supabase.js';
import { esc } from '../format.js';

const SEZIONI = [
  { key: 'panoramica', label: 'Panoramica' },
  { key: 'coorti',     label: 'Coorti' },
  { key: 'beauty',     label: 'Beauty' },
  { key: 'vendita',    label: 'Vendita' },
];

let UTENTI = [];
let _mount = null;

const dataLeggibile = iso => !iso ? 'mai' :
  new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });

function disegna() {
  const tb = _mount.querySelector('#acTable');
  tb.innerHTML =
    '<thead><tr><th>Utente</th>' +
    SEZIONI.map(s => `<th>${s.label}</th>`).join('') +
    '<th>Admin</th><th>Ultimo accesso</th><th></th></tr></thead><tbody>' +
    UTENTI.map((u, i) => {
      const admin = u.sezioni.includes('admin');
      const cella = s => `<td><input type="checkbox" data-i="${i}" data-sez="${s}"
        ${u.sezioni.includes(s) ? 'checked' : ''} ${admin ? 'disabled' : ''}></td>`;
      return `<tr>
        <td class="name">${esc(u.email || u.user_id)}</td>
        ${SEZIONI.map(s => cella(s.key)).join('')}
        <td><input type="checkbox" data-i="${i}" data-sez="admin" ${admin ? 'checked' : ''}></td>
        <td>${dataLeggibile(u.ultimo_accesso)}</td>
        <td><button class="ac-save" data-i="${i}">Salva</button>
            <span class="ac-msg" data-i="${i}"></span></td>
      </tr>`;
    }).join('') + '</tbody>';

  tb.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.onchange = () => {
      const u = UTENTI[+cb.dataset.i];
      const sez = cb.dataset.sez;
      u.sezioni = cb.checked ? [...new Set([...u.sezioni, sez])] : u.sezioni.filter(s => s !== sez);
      if (sez === 'admin') disegna();   // admin implica tutto: le altre caselle si disabilitano
    };
  });

  tb.querySelectorAll('button.ac-save').forEach(b => {
    b.onclick = async () => {
      const i = +b.dataset.i;
      const u = UTENTI[i];
      const msg = tb.querySelector(`.ac-msg[data-i="${i}"]`);
      b.disabled = true; msg.textContent = 'Salvo…'; msg.className = 'ac-msg';
      const { data, error } = await supabase.rpc('ms_imposta_sezioni',
        { p_user: u.user_id, p_sezioni: u.sezioni });
      b.disabled = false;
      if (error) { msg.textContent = error.message; msg.className = 'ac-msg val-bad'; return; }
      u.sezioni = Array.isArray(data) ? data : u.sezioni;
      msg.textContent = 'Salvato'; msg.className = 'ac-msg val-good';
      setTimeout(() => { if (msg.textContent === 'Salvato') msg.textContent = ''; }, 2500);
    };
  });
}

export async function render(mount) {
  _mount = mount;
  mount.innerHTML = `
    <div class="card">
      <h2>Accessi</h2>
      <div class="subtitle">Chi vede quali sezioni. <strong>Admin</strong> vede tutto, comprese le sezioni
        future e questo pannello. Chi non ha nessuna casella spuntata entra ma non vede nulla.
        Il blocco è applicato dal database: nascondere una voce di menu non basterebbe.</div>
      <div class="table-scroll"><table id="acTable"></table></div>
      <div id="acStatus" class="status loading">Caricamento utenti…</div>
    </div>`;

  const { data, error } = await supabase.rpc('ms_lista_utenti');
  const st = mount.querySelector('#acStatus');
  if (!st) return;                                   // render obsoleto
  if (error) {
    st.textContent = 'Non hai i permessi per gestire gli accessi.';
    st.classList.remove('loading');
    return;
  }
  UTENTI = (data || []).map(u => ({ ...u, sezioni: Array.isArray(u.sezioni) ? [...u.sezioni] : [] }));
  st.remove();
  disegna();
}

export function onResize() { /* nessun grafico */ }
