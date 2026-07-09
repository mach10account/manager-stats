// manager-stats · bootstrap: auth, router, filtri, montaggio sezioni
import { signIn, signOut, onAuthStateChange, requireSession, isAuthError } from './supabase.js';
import { initFilters } from './filters.js';
import { startRouter, parseHash } from './router.js';
import { initModal } from './modal.js';
import { loadFreshness, clearCentriCache } from './data.js';

import * as panoramica from './sections/panoramica.js';
import * as marketing from './sections/marketing.js';
import * as coorti from './sections/coorti.js';
import * as chiamate from './sections/chiamate.js';

const sections = {
  '/panoramica': panoramica,
  '/marketing': marketing,
  '/coorti': coorti,
  '/chiamate': chiamate,
};

const $ = id => document.getElementById(id);
let booted = false;
let bootPromise = null;
let currentPath = '/panoramica';

// ── auth UI ───────────────────────────────────────────────────────────────────
function showLogin() {
  $('shell').classList.add('hidden');
  $('login').classList.remove('hidden');
  const pw = $('loginPassword');
  if (pw) pw.value = '';
}

async function showApp() {
  $('login').classList.add('hidden');
  $('shell').classList.remove('hidden');
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
  initModal();
  await initFilters();                         // popola consulente + range default (no dispatch)
  document.addEventListener('filterchange', () => renderCurrent());
  window.addEventListener('resize', debounce(() => {
    const sec = sections[currentPath];
    if (sec && sec.onResize) sec.onResize();
  }, 200));
  refreshFreshness();
  startRouter(route => {
    currentPath = sections[route.path] ? route.path : '/panoramica';
    highlightNav(currentPath);
    renderCurrent();
  });
}

// ── render della sezione corrente ─────────────────────────────────────────────
function renderCurrent() {
  const route = parseHash();
  const path = sections[route.path] ? route.path : '/panoramica';
  currentPath = path;
  highlightNav(path);
  const mount = $('app');
  mount.innerHTML = '<div class="status">Caricamento…</div>';
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
    const { error } = await signIn(email, password);
    btn.disabled = false; btn.textContent = 'Accedi';
    if (error) { err.textContent = 'Credenziali non valide'; }
    // il successo è gestito da onAuthStateChange (SIGNED_IN)
  });
  $('logout').addEventListener('click', async () => {
    await signOut();
    clearCentriCache();
    showLogin();
  });
}

// ── avvio ─────────────────────────────────────────────────────────────────────
let resolved = false;
function resolve(session) { if (session) showApp(); else showLogin(); }

initAuthUI();
onAuthStateChange((event, session) => {
  resolved = true;
  // Copre tutti i casi, incluso INITIAL_SESSION con session=null (primo accesso, non loggato)
  if (session) showApp();
  else showLogin();
});
// rete di sicurezza se INITIAL_SESSION non scatta
setTimeout(async () => { if (!resolved) resolve(await requireSession()); }, 1200);
