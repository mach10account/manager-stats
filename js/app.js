// manager-stats · bootstrap: auth, router, filtri, montaggio sezioni
import { signIn, signOut, onAuthStateChange, requireSession, isAuthError, supabase } from './supabase.js';
import { setTrackUser, track } from './track.js';
import { initFilters, filtroConsulenteUtile } from './filters.js';
import { startRouter, parseHash, navigate } from './router.js';
import { initModal } from './modal.js';
import { loadFreshness, clearCentriCache } from './data.js';

import * as panoramica from './sections/panoramica.js';
import * as marketing from './sections/marketing.js';
import * as coorti from './sections/coorti.js';
import * as beauty from './sections/beauty.js';
import * as vendita from './sections/vendita.js';
import * as finance from './sections/finance.js';
import * as accessi from './sections/accessi.js';
import * as task from './sections/task.js';

// l'ordine conta: la prima sezione consentita è quella su cui si atterra
const sections = {
  '/panoramica': panoramica,
  '/marketing': marketing,
  '/coorti': coorti,
  '/beauty': beauty,
  '/vendita': vendita,
  '/finance': finance,
  '/task': task,
  '/accessi': accessi,
};

// path → permesso richiesto (stessa chiave di data-sezione in index.html)
const permessoDi = {
  '/panoramica': 'panoramica',
  '/marketing': 'panoramica',   // il drill-down centro è parte della Panoramica (voce nav rimossa)
  '/coorti': 'coorti',
  '/beauty': 'beauty',
  '/vendita': 'vendita',
  '/finance': 'finance',        // 'finance' non si assegna dal pannello Accessi: di fatto solo admin
  '/task': 'task',              // 'task' non si assegna: ms_mie_sezioni() la dà a ogni utente attivo
  '/accessi': 'admin',
};
const ALIAS = { '/chiamate': '/beauty' };   // la sezione si chiamava Chiamate: i vecchi link continuano a funzionare

let MIE_SEZIONI = [];
const isAdmin = () => MIE_SEZIONI.includes('admin');
const puo = sez => isAdmin() || MIE_SEZIONI.includes(sez);
const pathConsentito = p => !!sections[p] && puo(permessoDi[p]);
const primoConsentito = () => Object.keys(sections).find(pathConsentito) || null;

const $ = id => document.getElementById(id);
let booted = false;
let bootPromise = null;
let currentPath = '/panoramica';
let accessTracked = false;
let lastTrackedPath = null;

// ── auth UI ───────────────────────────────────────────────────────────────────
function showLogin() {
  $('shell').classList.add('hidden');
  $('login').classList.remove('hidden');
  accessTracked = false; // un nuovo login nella stessa tab conta come nuovo ACCESSO

  // Se nella stessa tab entra un altro utente, boot() deve rigirare: altrimenti si
  // porterebbe dietro i permessi (e la nav) di chi c'era prima.
  booted = false;
  bootPromise = null;
  MIE_SEZIONI = [];
  lastTrackedPath = null;
  clearCentriCache();

  const pw = $('loginPassword');
  if (pw) pw.value = '';
}

async function showApp() {
  $('login').classList.add('hidden');
  $('shell').classList.remove('hidden');
  if (!accessTracked) { accessTracked = true; track('ACCESSO'); }
  if (!booted) {
    booted = true;
    bootPromise = boot();
    await bootPromise;
  } else {
    // un secondo evento auth (INITIAL_SESSION → TOKEN_REFRESHED/SIGNED_IN) può arrivare
    // mentre il primo boot è ancora in corso: aspetta che initFilters() abbia impostato il
    // range, altrimenti renderCurrent parte con date null → 400 "date: null".
    await bootPromise;
    refreshFreshness();
    renderCurrent();
  }
}

async function boot() {
  await caricaPermessi();                      // prima di tutto: decide cosa esiste per questo utente
  initModal();
  await initFilters();                         // popola consulente + range default (no dispatch)
  document.addEventListener('filterchange', () => renderCurrent());
  window.addEventListener('resize', debounce(() => {
    const sec = sections[currentPath];
    if (sec && sec.onResize) sec.onResize();
  }, 200));
  refreshFreshness();
  startRouter(() => renderCurrent());
}

// ── permessi ──────────────────────────────────────────────────────────────────
async function caricaPermessi() {
  try {
    const { data } = await supabase.rpc('ms_mie_sezioni');
    MIE_SEZIONI = Array.isArray(data) ? data : [];
  } catch (e) {
    MIE_SEZIONI = [];                          // in dubbio non si mostra nulla
  }
  document.querySelectorAll('#nav a[data-sezione]').forEach(a =>
    a.classList.toggle('hidden', !puo(a.dataset.sezione)));
}

// ── render della sezione corrente ─────────────────────────────────────────────
function renderCurrent() {
  const route = parseHash();
  const mount = $('app');

  let path = ALIAS[route.path] || route.path;
  if (!pathConsentito(path)) {
    const fallback = primoConsentito();
    if (!fallback) {                           // utente senza alcuna sezione assegnata
      highlightNav(null);
      mount.innerHTML = `<div class="card"><h2>Nessun accesso assegnato</h2>
        <div class="subtitle">Il tuo account è attivo ma non ha ancora nessuna sezione abilitata.
        Chiedi a Leo di assegnartele, poi ricarica la pagina.</div></div>`;
      return;
    }
    navigate(fallback);                        // ri-entra da hashchange
    return;
  }

  currentPath = path;
  if (path !== lastTrackedPath) { lastTrackedPath = path; track('PAGINA', path); }
  highlightNav(path === '/marketing' ? '/panoramica' : path);   // il drill-down evidenzia Panoramica
  // in Vendita il filtro Consulente non ha senso (i setter lavorano l'acquisizione,
  // non i centri); per chi vede un solo consulente e' una tendina a una voce
  const consulenteRow = $('consulenteRow');
  if (consulenteRow) consulenteRow.classList.toggle('hidden',
    path === '/vendita' || !filtroConsulenteUtile());
  // in Task i filtri in alto non servono: le tab (arretrate/oggi/prossime) sono
  // il filtro, e un preset "7 giorni" nasconderebbe le task arretrate.
  // In Finance la vista è mensile: il selettore mese sta dentro la sezione.
  const filterBar = $('filterBar');
  if (filterBar) filterBar.classList.toggle('hidden', path === '/task' || path === '/finance');
  mount.innerHTML = '<div class="status loading">Caricamento…</div>';
  Promise.resolve()
    .then(() => sections[path].render(mount, route.params))
    .catch(err => {
      if (isAuthError(err)) { showLogin(); return; }
      mount.innerHTML = `<div class="status">Errore: ${err && err.message ? err.message : err}</div>`;
      console.error(err);
    });
}

function highlightNav(path) {
  document.querySelectorAll('#nav a[data-path]').forEach(a =>
    a.classList.toggle('active', a.dataset.path === path));
}

async function refreshFreshness() {
  try {
    const max = await loadFreshness();
    if (max) {
      const d = new Date(max);
      $('freshness').textContent = 'aggiornato alle ' + d.toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    }
  } catch (e) { /* non bloccante */ }
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ── wiring login/logout ───────────────────────────────────────────────────────
function initAuthUI() {
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('loginError');
    err.textContent = '';
    const btn = $('loginSubmit');
    btn.disabled = true; btn.textContent = 'Accesso…';
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    const { data, error } = await signIn(email, password);
    btn.disabled = false; btn.textContent = 'Accedi';
    if (error) { err.textContent = 'Credenziali non valide'; }
    else {
      setTrackUser(data && data.session && data.session.user ? data.session.user.email : email);
      track('LOGIN');
    }
    // il successo è gestito da onAuthStateChange (SIGNED_IN)
  });
  $('logout').addEventListener('click', async () => {
    track('LOGOUT');
    await signOut();
    clearCentriCache();
    showLogin();
  });
}

// ── avvio ─────────────────────────────────────────────────────────────────────
let resolved = false;
function resolve(session) {
  setTrackUser(session && session.user ? session.user.email : null);
  if (session) showApp(); else showLogin();
}

initAuthUI();
onAuthStateChange((event, session) => {
  resolved = true;
  setTrackUser(session && session.user ? session.user.email : null);
  // Copre tutti i casi, incluso INITIAL_SESSION con session=null (primo accesso, non loggato)
  if (session) showApp();
  else showLogin();
});
// rete di sicurezza se INITIAL_SESSION non scatta
setTimeout(async () => { if (!resolved) resolve(await requireSession()); }, 1200);
