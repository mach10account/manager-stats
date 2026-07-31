// manager-stats · Sezione Task — le task del team
//
// Chi vede cosa lo decide il database (ms_team: stesso team = almeno un centro in
// comune; admin vede tutti). Qui si disegna soltanto: tab Arretrate / Oggi /
// Prossime / Completate, riga task, pannello di dettaglio con stato, esito e note.
// La barra Periodo in alto è nascosta da app.js: una task arretrata deve restare
// visibile qualunque intervallo di date sia selezionato.
import { supabase } from '../supabase.js';
import { loadCentri } from '../data.js';
import { navigate } from '../router.js';
import { esc, todayRome, dstr } from '../format.js';

const CATEGORIE = ['Operativa', 'Chiamata', 'Controllo', 'Riunione'];
const STATI = [['todo', 'Da fare'], ['doing', 'In corso'], ['done', 'Fatto']];
const ESITI = [['none', 'Nessuno'], ['ok', 'Ok'], ['review', 'Da rivedere']];
const TABS = [['arretrate', 'Arretrate'], ['oggi', 'Oggi'], ['prossime', 'Prossime'], ['completate', 'Completate']];

let TASKS = [];
let PERSONE = [];     // { user_id, nome, email } — le persone del mio team
let CENTRI = [];      // anagrafica (già filtrata dallo scope dell'utente)
let ME = null;        // { id, nome }
let tab = 'oggi';
let chi = 'tutti';    // 'tutti' | user_id
let aperta = null;    // id della task nel pannello di dettaglio
let _mount = null;

const OGGI = () => dstr(todayRome());
const nomeDi = id => (PERSONE.find(p => p.user_id === id) || {}).nome || '—';
const oraBreve = t => t ? String(t).slice(0, 5) : '';
const dataBreve = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) : '';
const arretrata = t => t.stato !== 'done' && t.data < OGGI();
const etichetta = (lista, k) => (lista.find(x => x[0] === k) || [, '—'])[1];

// ── dati ─────────────────────────────────────────────────────────────────────
async function carica() {
  const [t, p] = await Promise.all([supabase.rpc('ms_task_lista'), supabase.rpc('ms_persone')]);
  if (t.error) throw t.error;
  if (p.error) throw p.error;
  TASKS = t.data || [];
  PERSONE = p.data || [];
  // i centri servono solo alla tendina del form: chi non ha sezioni di statistiche
  // non li può leggere, e va benissimo così (task senza centro).
  try { CENTRI = await loadCentri(); } catch (e) { CENTRI = []; }
}

function bucket(t) {
  if (t.stato === 'done') return 'completate';
  if (t.data < OGGI()) return 'arretrate';
  if (t.data === OGGI()) return 'oggi';
  return 'prossime';
}

function visibili() {
  return TASKS.filter(t => chi === 'tutti' || t.assegnata_a === chi);
}

// ── riga ─────────────────────────────────────────────────────────────────────
function rigaTask(t) {
  const ora = oraBreve(t.ora_inizio);
  const quando = tab === 'oggi'
    ? (ora ? `<b>${ora}</b>${t.ora_fine ? '<small>–' + oraBreve(t.ora_fine) + '</small>' : ''}` : '<span class="tk-noora">—</span>')
    : `<b>${dataBreve(t.data)}</b>${ora ? '<small>' + ora + '</small>' : ''}`;
  const chip = (cls, testo) => `<span class="tk-chip ${cls}">${esc(testo)}</span>`;
  const meta = [
    chip('tk-cat cat-' + t.categoria.toLowerCase(), t.categoria),
    chip('tk-pers', t.assegnato_nome),
    t.centro_nome ? chip('tk-centro', t.centro_nome) : '',
    arretrata(t) ? chip('tk-late', 'Arretrata') : '',
    t.n_note ? `<span class="tk-note">${t.n_note} not${t.n_note === 1 ? 'a' : 'e'}</span>` : '',
  ].join('');
  return `<button class="tk-row" data-id="${t.id}">
    <span class="tk-time">${quando}</span>
    <span class="tk-body">
      <span class="tk-title">${esc(t.titolo)}</span>
      <span class="tk-meta">${meta}</span>
    </span>
    ${chip('tk-stato st-' + t.stato, etichetta(STATI, t.stato))}
    ${t.esito === 'none' ? '' : chip('tk-esito es-' + t.esito, etichetta(ESITI, t.esito))}
    <span class="tk-min">${t.minuti ? t.minuti + '′' : ''}</span>
    <span class="tk-caret">›</span>
  </button>`;
}

// ── disegno ──────────────────────────────────────────────────────────────────
function disegna() {
  const lista = visibili();
  const conta = {};
  for (const [k] of TABS) conta[k] = 0;
  for (const t of lista) conta[bucket(t)]++;

  _mount.querySelectorAll('.tk-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
    b.querySelector('.tk-count').textContent = conta[b.dataset.tab];
  });

  const righe = lista.filter(t => bucket(t) === tab).sort((a, b) => {
    const ka = a.data + (a.ora_inizio || '99'), kb = b.data + (b.ora_inizio || '99');
    return tab === 'completate' ? kb.localeCompare(ka) : ka.localeCompare(kb);
  });

  _mount.querySelector('#tkList').innerHTML = righe.length
    ? righe.map(rigaTask).join('')
    : `<div class="tk-vuoto">${chi === 'tutti'
        ? 'Nessuna task qui.'
        : 'Nessuna task qui per ' + esc(nomeDi(chi)) + '.'}</div>`;

  _mount.querySelectorAll('.tk-row').forEach(r => {
    r.onclick = () => { aperta = +r.dataset.id; disegnaPannello(); };
  });
}

function disegnaPannello() {
  const box = _mount.querySelector('#tkPanel');
  const scrim = _mount.querySelector('#tkScrim');
  const t = TASKS.find(x => x.id === aperta);
  if (!t) { box.classList.remove('open'); scrim.classList.remove('open'); box.innerHTML = ''; return; }

  const seg = (nome, opzioni, val) => `<div class="tk-seg">${opzioni.map(([k, l]) =>
    `<button data-${nome}="${k}" class="${val === k ? 'sel' : ''}">${l}</button>`).join('')}</div>`;
  const riga = (k, v) => `<div class="tk-dett"><span>${k}</span><span>${v}</span></div>`;
  const orario = oraBreve(t.ora_inizio)
    ? oraBreve(t.ora_inizio) + (t.ora_fine ? '–' + oraBreve(t.ora_fine) : '') : '—';
  const puoEliminare = t.creata_da === ME.id || t.assegnata_a === ME.id;

  box.innerHTML = `
    <div class="tk-panel-head">
      <button class="tk-x" id="tkClose" title="Chiudi">✕</button>
      <div class="tk-kick">Task${arretrata(t) ? ' · arretrata' : ''}</div>
      <h3>${esc(t.titolo)}</h3>
      <div class="tk-panel-meta">
        <span class="tk-chip tk-cat cat-${t.categoria.toLowerCase()}">${esc(t.categoria)}</span>
        <span class="tk-chip tk-pers">${esc(t.assegnato_nome)}</span>
        ${t.centro_id ? `<button class="tk-chip tk-centro tk-centro-link" id="tkCentro">${esc(t.centro_nome || 'centro')} →</button>` : ''}
      </div>
    </div>
    <div class="tk-panel-body">
      <div class="tk-sez"><div class="tk-lab">Stato</div>${seg('stato', STATI, t.stato)}</div>
      <div class="tk-sez"><div class="tk-lab">Esito</div>${seg('esito', ESITI, t.esito)}</div>
      <div class="tk-sez">
        <div class="tk-lab">Dettagli</div>
        ${riga('Assegnata a', esc(t.assegnato_nome))}
        ${riga('Tipo attività', esc(t.categoria))}
        ${riga('Data', t.data.split('-').reverse().join('/'))}
        ${riga('Orario', orario + (t.minuti ? ' · ' + t.minuti + '′' : ''))}
        ${riga('Centro', esc(t.centro_nome || '—'))}
        ${riga('Creata da', esc(t.creatore_nome))}
        ${t.descrizione ? `<div class="tk-descr">${esc(t.descrizione)}</div>` : ''}
      </div>
      <div class="tk-sez">
        <div class="tk-lab">Note</div>
        <div id="tkNote" class="tk-note-list"><div class="tk-note-vuote">Carico le note…</div></div>
        <textarea id="tkNotaTesto" rows="2" placeholder="Aggiungi una nota, un link, un riferimento…"></textarea>
        <div class="tk-azioni">
          <button class="tk-btn" id="tkAddNota">Aggiungi nota</button>
          <button class="tk-btn tk-btn-ghost" id="tkEdit">Modifica</button>
          ${puoEliminare ? '<button class="tk-btn tk-btn-danger" id="tkDel">Elimina</button>' : ''}
        </div>
        <div class="tk-msg" id="tkPanelMsg"></div>
      </div>
    </div>`;
  box.classList.add('open');
  scrim.classList.add('open');

  box.querySelector('#tkClose').onclick = chiudiPannello;
  const centroBtn = box.querySelector('#tkCentro');
  if (centroBtn) centroBtn.onclick = () => navigate('/marketing?centro=' + encodeURIComponent(t.centro_id));
  box.querySelectorAll('[data-stato]').forEach(b =>
    b.onclick = () => salvaCampo(t.id, { stato: b.dataset.stato }));
  box.querySelectorAll('[data-esito]').forEach(b =>
    b.onclick = () => salvaCampo(t.id, { esito: b.dataset.esito }));
  box.querySelector('#tkEdit').onclick = () => apriForm(t);
  const del = box.querySelector('#tkDel');
  if (del) del.onclick = () => elimina(t.id);
  box.querySelector('#tkAddNota').onclick = () => aggiungiNota(t.id);

  caricaNote(t.id);
}

function chiudiPannello() { aperta = null; disegnaPannello(); }

async function caricaNote(id) {
  const box = _mount.querySelector('#tkNote');
  const { data, error } = await supabase.rpc('ms_task_note', { p_task: id });
  if (!box || aperta !== id) return;
  if (error) { box.innerHTML = `<div class="tk-note-vuote">Errore: ${esc(error.message)}</div>`; return; }
  box.innerHTML = (data && data.length)
    ? data.map(n => `<div class="tk-nota">
        <div class="tk-nota-meta">${esc(n.autore_nome)} · ${new Date(n.creata_a).toLocaleString('it-IT',
          { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
        <div class="tk-nota-testo">${esc(n.testo)}</div></div>`).join('')
    : '<div class="tk-note-vuote">Nessuna nota.</div>';
}

// ── scritture ────────────────────────────────────────────────────────────────
function messaggio(sel, testo, ok) {
  const el = _mount.querySelector(sel);
  if (!el) return;
  el.textContent = testo;
  el.className = 'tk-msg' + (ok === true ? ' val-good' : ok === false ? ' val-bad' : '');
  if (ok === true) setTimeout(() => { if (el.textContent === testo) el.textContent = ''; }, 2500);
}

async function ricarica() {
  const { data, error } = await supabase.rpc('ms_task_lista');
  if (error) throw error;
  TASKS = data || [];
}

async function salvaCampo(id, patch) {
  const { error } = await supabase.from('ms_task').update(patch).eq('id', id);
  if (error) { messaggio('#tkPanelMsg', error.message, false); return; }
  await ricarica();
  disegna();
  disegnaPannello();
}

async function aggiungiNota(id) {
  const ta = _mount.querySelector('#tkNotaTesto');
  const testo = (ta.value || '').trim();
  if (!testo) { ta.focus(); return; }
  const { error } = await supabase.from('ms_task_nota').insert({ task_id: id, testo });
  if (error) { messaggio('#tkPanelMsg', error.message, false); return; }
  ta.value = '';
  await ricarica();
  disegna();
  caricaNote(id);
}

async function elimina(id) {
  if (!confirm('Eliminare questa task? L\'operazione non si può annullare.')) return;
  const { error } = await supabase.from('ms_task').delete().eq('id', id);
  if (error) { messaggio('#tkPanelMsg', error.message, false); return; }
  aperta = null;
  await ricarica();
  disegna();
  disegnaPannello();
}

// ── form crea / modifica ─────────────────────────────────────────────────────
function apriForm(t) {
  const box = _mount.querySelector('#tkForm');
  const opt = (v, l, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(l)}</option>`;
  const persone = PERSONE.map(p => opt(p.user_id, p.user_id === ME.id ? p.nome + ' (io)' : p.nome,
    t ? t.assegnata_a === p.user_id : p.user_id === ME.id)).join('');
  const centri = [opt('', '— nessun centro', !t || !t.centro_id)]
    .concat(CENTRI.slice().sort((a, b) => (a.nome || '').localeCompare(b.nome || ''))
      .map(c => opt(c.notion_id, c.nome || '(senza nome)', t && t.centro_id === c.notion_id))).join('');
  const cat = CATEGORIE.map(c => opt(c, c, t ? t.categoria === c : c === 'Operativa')).join('');

  box.innerHTML = `<div class="modal-card tk-form-card">
    <div class="modal-head"><h3>${t ? 'Modifica task' : 'Assegna una task'}</h3>
      <button class="modal-close" id="tkFormX" title="Chiudi">✕</button></div>
    <div class="modal-sub">${t ? 'Le modifiche sono visibili subito a tutto il team.'
      : 'La task compare subito nella lista della persona a cui la assegni.'}</div>
    <div class="tk-campi">
      <label class="tk-campo tk-largo">Titolo
        <input type="text" id="fTitolo" maxlength="200" placeholder="Cosa va fatto"
               value="${t ? esc(t.titolo) : ''}"></label>
      <label class="tk-campo">Assegna a<select id="fAss">${persone}</select></label>
      <label class="tk-campo">Tipo attività<select id="fCat">${cat}</select></label>
      <label class="tk-campo tk-largo">Centro (facoltativo)<select id="fCentro">${centri}</select></label>
      <label class="tk-campo">Data<input type="date" id="fData" value="${t ? t.data : OGGI()}"></label>
      <label class="tk-campo">Minuti<input type="number" id="fMin" min="1" max="1440" step="5"
             value="${t && t.minuti ? t.minuti : ''}" placeholder="30"></label>
      <label class="tk-campo">Inizio<input type="time" id="fIni" value="${t ? oraBreve(t.ora_inizio) : ''}"></label>
      <label class="tk-campo">Fine<input type="time" id="fFin" value="${t ? oraBreve(t.ora_fine) : ''}"></label>
      <label class="tk-campo tk-largo">Note iniziali (facoltative)
        <textarea id="fDescr" rows="2" placeholder="Contesto, link, cosa serve">${t && t.descrizione ? esc(t.descrizione) : ''}</textarea></label>
    </div>
    <div class="tk-azioni tk-azioni-form">
      <span class="tk-msg" id="tkFormMsg"></span>
      <button class="tk-btn tk-btn-ghost" id="tkFormAnnulla">Annulla</button>
      <button class="tk-btn tk-btn-pri" id="tkFormSalva">${t ? 'Salva' : 'Assegna'}</button>
    </div>
  </div>`;
  box.classList.remove('hidden');
  box.querySelector('#fTitolo').focus();

  const chiudi = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  box.querySelector('#tkFormX').onclick = chiudi;
  box.querySelector('#tkFormAnnulla').onclick = chiudi;
  box.onclick = e => { if (e.target === box) chiudi(); };
  box.querySelector('#tkFormSalva').onclick = () => salvaForm(t, chiudi);
}

async function salvaForm(t, chiudi) {
  const v = id => _mount.querySelector('#' + id).value;
  const titolo = v('fTitolo').trim();
  if (!titolo) { messaggio('#tkFormMsg', 'Serve un titolo.', false); return; }

  const ini = v('fIni') || null, fin = v('fFin') || null;
  let minuti = v('fMin') ? +v('fMin') : null;
  if (!minuti && ini && fin) {                       // durata dedotta dagli orari
    const m = (a) => +a.slice(0, 2) * 60 + +a.slice(3, 5);
    const d = m(fin) - m(ini);
    if (d > 0) minuti = d;
  }
  const riga = {
    titolo,
    assegnata_a: v('fAss'),
    centro_id: v('fCentro') || null,
    data: v('fData') || OGGI(),
    ora_inizio: ini, ora_fine: fin, minuti,
    categoria: v('fCat'),
    descrizione: v('fDescr').trim() || null,
  };

  const btn = _mount.querySelector('#tkFormSalva');
  btn.disabled = true;
  const { error } = t
    ? await supabase.from('ms_task').update(riga).eq('id', t.id)
    : await supabase.from('ms_task').insert(riga);
  btn.disabled = false;
  if (error) { messaggio('#tkFormMsg', error.message, false); return; }

  chiudi();
  await ricarica();
  if (!t) { tab = bucket({ ...riga, stato: 'todo' }); }   // porta l'utente dove è finita la task
  disegna();
  if (aperta) disegnaPannello();
}

// ── montaggio ────────────────────────────────────────────────────────────────
export async function render(mount) {
  _mount = mount;
  aperta = null;
  mount.innerHTML = `
    <div class="card">
      <div class="mk-head">
        <h2>Task</h2>
        <button class="tk-btn tk-btn-pri" id="tkNuova">+ Assegna task</button>
      </div>
      <div class="subtitle">Le task tue e delle persone con cui condividi i centri.
        Chiunque può assegnarne una a chiunque del team; stato ed esito li può aggiornare chi la vede.</div>
      <div class="tk-barra">
        <div class="lead-tabs tk-tabs">${TABS.map(([k, l]) =>
          `<button data-tab="${k}">${l} <span class="tk-count">0</span></button>`).join('')}</div>
        <label class="consulente-wrap tk-chi">Persona
          <select id="tkChi"><option value="tutti">Tutto il team</option></select></label>
      </div>
      <div id="tkList"></div>
    </div>
    <div class="tk-scrim" id="tkScrim"></div>
    <aside class="tk-panel" id="tkPanel"></aside>
    <div class="modal-overlay hidden" id="tkForm"></div>
    <div id="tkStatus" class="status loading">Caricamento task…</div>`;

  const sessione = await supabase.auth.getSession();
  const utente = sessione.data.session ? sessione.data.session.user : null;
  await carica();

  const st = mount.querySelector('#tkStatus');
  if (!st) return;                                   // render obsoleto: sezione cambiata
  st.remove();

  ME = { id: utente ? utente.id : null };
  ME.nome = nomeDi(ME.id);

  const sel = mount.querySelector('#tkChi');
  sel.innerHTML = '<option value="tutti">Tutto il team</option>' + PERSONE.map(p =>
    `<option value="${p.user_id}">${esc(p.user_id === ME.id ? p.nome + ' (io)' : p.nome)}</option>`).join('');
  sel.value = chi = (chi !== 'tutti' && PERSONE.some(p => p.user_id === chi)) ? chi : 'tutti';
  sel.onchange = () => { chi = sel.value; disegna(); };

  mount.querySelectorAll('.tk-tabs button').forEach(b =>
    b.onclick = () => { tab = b.dataset.tab; disegna(); });
  mount.querySelector('#tkNuova').onclick = () => apriForm(null);
  mount.querySelector('#tkScrim').onclick = chiudiPannello;

  // se non c'è niente per oggi ma ci sono arretrati, parti da lì
  const conta = k => TASKS.filter(t => bucket(t) === k).length;
  if (!conta('oggi') && conta('arretrate')) tab = 'arretrate';

  disegna();
}

export function onResize() { /* nessun grafico */ }
