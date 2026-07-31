// manager-stats · Sezione Accessi — chi vede cosa (solo amministratori)
//
// Il blocco vero sta nel database: ogni tabella ha una policy RLS che interroga
// public.ms_puo(area) e, per i dati marketing, public.ms_centri_scope(). Questo
// pannello scrive soltanto in public.ms_accessi, via le RPC ms_lista_utenti /
// ms_imposta_sezioni / ms_imposta_scope, che a loro volta rifiutano il chiamante
// non-admin. Nascondere la voce di menu è comodità, non sicurezza.
import { supabase } from '../supabase.js';
import { esc } from '../format.js';

const SEZIONI = [
  { key: 'panoramica', label: 'Panoramica' },
  { key: 'coorti',     label: 'Coorti' },
  { key: 'beauty',     label: 'Beauty' },
  { key: 'vendita',    label: 'Vendita' },
];

let UTENTI = [];
let CENTRI = [];       // { notion_id, nome, consulente, media_buyer } per le select + picker
let CONSULENTI = [];   // email distinte da centri.consulente
let MEDIA_BUYER = [];  // email distinte da centri.media_buyer
let _mount = null;

const dataLeggibile = iso => !iso ? 'mai' :
  new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });

// modalità visibilità: '' = tutti · 'c:<email>' = centri del consulente
// · 'm:<email>' = centri del media buyer · 'picker' = allowlist esplicita
const modoDi = u => u.consulente ? 'c:' + u.consulente
  : u.media_buyer ? 'm:' + u.media_buyer
  : (Array.isArray(u.centri_visibili) && u.centri_visibili.length ? 'picker' : '');

function celleVede(u, i) {
  const admin = u.sezioni.includes('admin');
  if (admin) return '<td><span class="ac-tutti">Tutti (admin)</span></td>';
  const modo = u._modo ?? modoDi(u);
  const opt = (val, label) =>
    `<option value="${esc(val)}" ${modo === val ? 'selected' : ''}>${esc(label)}</option>`;
  const opzioni = ['<option value="">Tutti i centri</option>']
    .concat(CONSULENTI.map(c => opt('c:' + c, 'Consulente: ' + c)))
    .concat(MEDIA_BUYER.map(m => opt('m:' + m, 'Media buyer: ' + m)))
    .concat([opt('picker', 'Solo centri scelti…')]);
  const n = (u._centri ?? u.centri_visibili ?? []).length;
  return `<td><select data-i="${i}" class="ac-vede">${opzioni.join('')}</select>
    ${modo === 'picker' ? `<div class="ac-npicked">${n} centr${n === 1 ? 'o' : 'i'} selezionat${n === 1 ? 'o' : 'i'}</div>` : ''}</td>`;
}

function pannelloPicker(u, i) {
  if ((u._modo ?? modoDi(u)) !== 'picker') return '';
  const scelti = new Set(u._centri ?? u.centri_visibili ?? []);
  const righe = CENTRI.map(c => `
    <label class="ac-centro" data-nome="${esc((c.nome || '').toLowerCase())}">
      <input type="checkbox" data-i="${i}" data-id="${c.notion_id}" ${scelti.has(c.notion_id) ? 'checked' : ''}>
      <span>${esc(c.nome || '(senza nome)')}</span>
      <span class="ac-centro-cons">${esc(c.consulente || '')}</span>
    </label>`).join('');
  return `<tr class="ac-picker-row"><td colspan="${SEZIONI.length + 5}">
    <div class="ac-picker">
      <input type="search" class="ac-cerca" data-i="${i}" placeholder="Cerca centro…">
      <div class="ac-lista">${righe}</div>
    </div></td></tr>`;
}

function disegna() {
  const tb = _mount.querySelector('#acTable');
  tb.innerHTML =
    '<thead><tr><th>Utente</th><th>Nome</th>' +
    SEZIONI.map(s => `<th>${s.label}</th>`).join('') +
    '<th>Admin</th><th>Vede</th><th>Ultimo accesso</th><th></th></tr></thead><tbody>' +
    UTENTI.map((u, i) => {
      const admin = u.sezioni.includes('admin');
      const cella = s => `<td><input type="checkbox" data-i="${i}" data-sez="${s}"
        ${u.sezioni.includes(s) ? 'checked' : ''} ${admin ? 'disabled' : ''}></td>`;
      return `<tr>
        <td class="name">${esc(u.email || u.user_id)}</td>
        <td><input type="text" class="ac-nome" data-i="${i}" maxlength="80"
             value="${esc(u.nome || '')}" placeholder="Nome e cognome"></td>
        ${SEZIONI.map(s => cella(s.key)).join('')}
        <td><input type="checkbox" data-i="${i}" data-sez="admin" ${admin ? 'checked' : ''}></td>
        ${celleVede(u, i)}
        <td>${dataLeggibile(u.ultimo_accesso)}</td>
        <td><button class="ac-save" data-i="${i}">Salva</button>
            <span class="ac-msg" data-i="${i}"></span></td>
      </tr>` + pannelloPicker(u, i);
    }).join('') + '</tbody>';

  tb.querySelectorAll('input[type=checkbox][data-sez]').forEach(cb => {
    cb.onchange = () => {
      const u = UTENTI[+cb.dataset.i];
      const sez = cb.dataset.sez;
      u.sezioni = cb.checked ? [...new Set([...u.sezioni, sez])] : u.sezioni.filter(s => s !== sez);
      if (sez === 'admin') disegna();   // admin implica tutto: le altre caselle si disabilitano
    };
  });

  tb.querySelectorAll('input.ac-nome').forEach(inp => {
    inp.oninput = () => { UTENTI[+inp.dataset.i].nome = inp.value; };
  });

  tb.querySelectorAll('select.ac-vede').forEach(sel => {
    sel.onchange = () => {
      const u = UTENTI[+sel.dataset.i];
      u._modo = sel.value;
      if (u._modo === 'picker' && !u._centri) u._centri = [...(u.centri_visibili || [])];
      disegna();
    };
  });

  tb.querySelectorAll('.ac-picker input[type=checkbox]').forEach(cb => {
    cb.onchange = () => {
      const u = UTENTI[+cb.dataset.i];
      const set = new Set(u._centri ?? u.centri_visibili ?? []);
      cb.checked ? set.add(cb.dataset.id) : set.delete(cb.dataset.id);
      u._centri = [...set];
      const row = cb.closest('.ac-picker-row').previousElementSibling;
      const n = u._centri.length;
      const np = row.querySelector('.ac-npicked');
      if (np) np.textContent = `${n} centr${n === 1 ? 'o' : 'i'} selezionat${n === 1 ? 'o' : 'i'}`;
    };
  });

  tb.querySelectorAll('input.ac-cerca').forEach(inp => {
    inp.oninput = () => {
      const q = inp.value.trim().toLowerCase();
      inp.closest('.ac-picker').querySelectorAll('.ac-centro').forEach(l =>
        l.classList.toggle('hidden', q && !l.dataset.nome.includes(q)));
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
      if (error) { b.disabled = false; msg.textContent = error.message; msg.className = 'ac-msg val-bad'; return; }
      u.sezioni = Array.isArray(data) ? data : u.sezioni;

      const modo = u._modo ?? modoDi(u);
      const consulente = modo.startsWith('c:') ? modo.slice(2) : null;
      const mediaBuyer = modo.startsWith('m:') ? modo.slice(2) : null;
      const centri = modo === 'picker' ? (u._centri ?? u.centri_visibili ?? []) : [];
      const r2 = await supabase.rpc('ms_imposta_scope', {
        p_user: u.user_id, p_consulente: consulente,
        p_media_buyer: mediaBuyer, p_centri: centri,
      });
      if (r2.error) { b.disabled = false; msg.textContent = r2.error.message; msg.className = 'ac-msg val-bad'; return; }

      // il nome serve alla sezione Task: senza, si ripiega sulla email
      const r3 = await supabase.rpc('ms_imposta_nome', { p_user: u.user_id, p_nome: u.nome || null });
      b.disabled = false;
      if (r3.error) { msg.textContent = r3.error.message; msg.className = 'ac-msg val-bad'; return; }
      u.consulente = consulente;
      u.media_buyer = mediaBuyer;
      u.centri_visibili = modo === 'picker' && centri.length ? centri : null;

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
      <div class="subtitle">Chi vede quali sezioni e quali centri. <strong>Admin</strong> vede tutto.
        Il <strong>Nome</strong> è quello mostrato nella sezione Task (senza, si vede la email).
        La sezione <strong>Task</strong> non si assegna: ce l'hanno tutti gli utenti attivi.
        La colonna <strong>Vede</strong> limita i dati marketing: "Consulente: …" segue in automatico
        i centri assegnati su Notion; "Solo centri scelti" è la lista fissa per i media buyer.
        Il blocco è applicato dal database: nascondere una voce di menu non basterebbe.</div>
      <div class="table-scroll"><table id="acTable"></table></div>
      <div id="acStatus" class="status loading">Caricamento utenti…</div>
    </div>`;

  const [utenti, centri] = await Promise.all([
    supabase.rpc('ms_lista_utenti'),
    supabase.from('centri').select('notion_id,nome,consulente,media_buyer').order('nome'),
  ]);
  const st = mount.querySelector('#acStatus');
  if (!st) return;                                   // render obsoleto
  if (utenti.error) {
    st.textContent = 'Non hai i permessi per gestire gli accessi.';
    st.classList.remove('loading');
    return;
  }
  UTENTI = (utenti.data || []).map(u => ({ ...u, sezioni: Array.isArray(u.sezioni) ? [...u.sezioni] : [] }));
  CENTRI = centri.data || [];
  CONSULENTI = [...new Set(CENTRI.map(c => c.consulente).filter(Boolean))].sort();
  MEDIA_BUYER = [...new Set(CENTRI.map(c => c.media_buyer).filter(Boolean))].sort();
  st.remove();
  disegna();
}

export function onResize() { /* nessun grafico */ }
