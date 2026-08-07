// manager-stats · bootstrap: auth, router, filtri, montaggio sezioni
import { signIn, signOut, scartaSessioneLocale, onAuthStateChange, requireSession, isAuthError, supabase } from './supabase.js';
import { setTrackUser, track } from './track.js';
import { initFilters, filtroConsulenteUtile } from './filters.js';
import { startRouter, parseHash, navigate } from './router.js';
import { initModal } from './modal.js';
import { loadFreshness, clearCentriCache, loadPersone } from './data.js';
import { esc } from './format.js';
import { initAssistente, resetAssistente } from './assistente.js?v=2';   // ?v da bumpare quando cambia assistente.js
import * as idle from './idle.js?v=1';   // ?v da bumpare quando cambia idle.js

import * as panoramica from './sections/panoramica.js?v=bench2';   // ?v da bumpare quando cambia panoramica.js
import * as marketing from './sections/marketing.js';
import * as coorti from './sections/coorti.js';
import * as beauty from './sections/beauty.js';
import * as vendita from './sections/vendita.js';
import * as sauron from './sections/sauron.js?v=48';   // ?v da bumpare quando cambia sauron.js (vedi nota in index.html)
import * as accessi from './sections/accessi.js';
import * as task from './sections/task.js';

// l'ordine conta: la prima sezione consentita è quella su cui si atterra
const sections = {
  '/panoramica': panoramica,
  '/marketing': marketing,
  '/coorti': coorti,
  '/beauty': beauty,
  '/vendita': vendita,
  '/sauron': sauron,
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
  '/sauron': 'finance',         // il permesso resta 'finance' (RLS/ms_puo): non si assegna dal pannello Accessi, di fatto solo admin
  '/task': 'task',              // 'task' non si assegna: ms_mie_sezioni() la dà a ogni utente attivo
  '/accessi': 'admin',
};
// vecchi nomi delle sezioni: i link salvati continuano a funzionare
const ALIAS = { '/chiamate': '/beauty', '/finance': '/sauron' };

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
let loginConPassword = false;  // vero solo tra il submit del form e il SIGNED_IN che ne consegue
let inRecupero = false;        // vero finché la schermata "scegli la password" è a schermo
let avvisoLogin = null;        // messaggio da mostrare al prossimo showLogin() (link scaduto)

// ── auth UI ───────────────────────────────────────────────────────────────────
function showLogin() {
  $('shell').classList.add('hidden');
  $('recupero').classList.add('hidden');
  $('login').classList.remove('hidden');
  if (avvisoLogin) { $('loginError').textContent = avvisoLogin; avvisoLogin = null; }
  accessTracked = false; // un nuovo login nella stessa tab conta come nuovo ACCESSO
  idle.stop();           // solo il timer: i timbri li azzera chi esce davvero (vedi sessioneScaduta / Esci)

  // Se nella stessa tab entra un altro utente, boot() deve rigirare: altrimenti si
  // porterebbe dietro i permessi (e la nav) di chi c'era prima.
  booted = false;
  bootPromise = null;
  MIE_SEZIONI = [];
  lastTrackedPath = null;
  clearCentriCache();
  resetAssistente();   // la conversazione non deve sopravvivere al cambio utente

  const pw = $('loginPassword');
  if (pw) pw.value = '';
}

// Chiusura automatica. Si torna al login SUBITO, prima di toccare la rete:
// signOut() può metterci parecchio (o non tornare affatto) e nel frattempo i
// dati resterebbero a schermo. La revoca lato server è comunque necessaria —
// svuotare solo localStorage lascerebbe valido un refresh token già copiato.
async function sessioneScaduta(motivo) {
  idle.azzera();
  clearCentriCache();
  showLogin();
  const err = $('loginError');
  if (err) err.textContent = motivo === 'inattivita'
    ? 'Sessione chiusa per inattività. Accedi di nuovo.'
    : 'Sessione scaduta per durata massima. Accedi di nuovo.';
  track('SCADENZA', motivo);
  const res = await signOut();
  if (res && res.error) scartaSessioneLocale();
}

async function showApp(session) {
  $('login').classList.add('hidden');
  $('recupero').classList.add('hidden');
  $('shell').classList.remove('hidden');
  // Una password appena digitata è la prova di presenza più forte che ci sia:
  // i timbri di una sessione morta senza passare da azzera() (token revocato
  // da un altro device: signOut è globale) non devono poterla respingere,
  // altrimenti il primo login "fallisce" sempre e solo il secondo entra.
  if (loginConPassword) { loginConPassword = false; idle.azzera(); }
  // se la sessione è già oltre i limiti si esce qui, senza montare nulla
  const scaduta = idle.start(session && session.user ? session.user.id : null, sessioneScaduta);
  if (scaduta) { sessioneScaduta(scaduta); return; }
  if (!accessTracked) {
    accessTracked = true;
    track('ACCESSO');
    // timbro di presenza per la colonna "Ultimo accesso" del pannello Accessi:
    // auth.users.last_sign_in_at si muove solo al reinserimento della password,
    // e chi resta loggato non la muove mai più (migration 37).
    supabase.rpc('ms_ping').then(() => {}, () => {});
  }
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
  // la mappa email/nome-sporco → nome va caricata PRIMA di disegnare qualsiasi
  // cosa: nomeDi() è sincrono, e con la mappa vuota si vedrebbero le email
  await loadPersone();
  await initFilters();                         // popola consulente + range default (no dispatch)
  document.addEventListener('filterchange', () => renderCurrent());
  window.addEventListener('resize', debounce(() => {
    const sec = sections[currentPath];
    if (sec && sec.onResize) sec.onResize();
  }, 200));
  refreshFreshness();
  // dopo i filtri: l'assistente legge il periodo selezionato per dare senso a
  // "questo mese" nelle domande
  initAssistente();
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
  // In Sauron la vista è mensile: il selettore mese sta dentro la sezione.
  const filterBar = $('filterBar');
  if (filterBar) filterBar.classList.toggle('hidden', path === '/task' || path === '/sauron');
  mount.innerHTML = '<div class="status loading">Caricamento…</div>';
  Promise.resolve()
    .then(() => sections[path].render(mount, route.params))
    .catch(err => {
      if (isAuthError(err)) { showLogin(); return; }
      mount.innerHTML = `<div class="status">Errore: ${esc(err && err.message ? err.message : err)}</div>`;
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
    // il flag va alzato PRIMA dell'await: supabase-js notifica SIGNED_IN (→ showApp)
    // prima che signIn risolva
    loginConPassword = true;
    const { data, error } = await signIn(email, password);
    btn.disabled = false; btn.textContent = 'Accedi';
    if (error) { loginConPassword = false; err.textContent = 'Credenziali non valide'; }
    else {
      setTrackUser(data && data.session && data.session.user ? data.session.user.email : email);
      track('LOGIN');
    }
    // il successo è gestito da onAuthStateChange (SIGNED_IN)
  });
  $('logout').addEventListener('click', async () => {
    track('LOGOUT');
    idle.azzera();                 // uscita voluta: via anche i timbri
    const res = await signOut();
    if (res && res.error) scartaSessioneLocale();
    clearCentriCache();
    showLogin();
  });
}

// ── link di recupero password / primo accesso ─────────────────────────────────
// Il link che riceve l'utente passa da Supabase, che lo verifica e rimanda qui
// col token nel FRAMMENTO: #access_token=…&refresh_token=…&type=recovery.
// detectSessionInUrl è false di proposito (il routing è a hash, non deve
// litigarci): il frammento lo leggiamo qui, una volta sola, all'avvio.
function frammentoAuth() {
  const grezzo = String(location.hash || '').replace(/^#\/?/, '');
  // ⚠️ Portatore NOSTRO: .../#th=<token_hash>. Serve perché il giro standard di
  // Supabase (verify → 302 sull'app col token nel frammento) rispetta la lista
  // degli indirizzi di ritorno del progetto: finché lì non c'è l'indirizzo di
  // manager-stats, Supabase scarta il redirect chiesto e rimanda al Site URL —
  // che è ancora il "http://localhost:3000" di fabbrica, cioè il nulla.
  // Con il token_hash il giro lo chiude il browser (verifyOtp), senza redirect.
  if (/^th=/.test(grezzo)) {
    const th = decodeURIComponent(grezzo.slice(3));
    return th ? { token_hash: th } : null;
  }
  if (grezzo.indexOf('access_token=') < 0 && grezzo.indexOf('error') < 0) return null;
  const p = new URLSearchParams(grezzo);
  // link già usato o scaduto: Supabase rimanda qui con error/error_description
  if (p.get('error') || p.get('error_code')) {
    return { errore: p.get('error_description') || p.get('error_code') || p.get('error') };
  }
  const tipo = p.get('type');
  if (!p.get('access_token')) return null;
  if (tipo !== 'recovery' && tipo !== 'invite' && tipo !== 'signup') return null;
  return { access_token: p.get('access_token'), refresh_token: p.get('refresh_token') || '' };
}

// il token non deve restare nella barra degli indirizzi né nella cronologia
function pulisciFrammento() {
  try { history.replaceState(null, '', location.pathname + location.search); }
  catch (e) { location.hash = ''; }
}

async function avviaRecupero(fr) {
  pulisciFrammento();
  const { data, error } = fr.token_hash
    ? await supabase.auth.verifyOtp({ token_hash: fr.token_hash, type: 'recovery' })
    : await supabase.auth.setSession({
      access_token: fr.access_token,
      refresh_token: fr.refresh_token,
    });
  if (error || !data || !data.session) {
    inRecupero = false;
    avvisoLogin = 'Il link non è più valido: è scaduto o è già stato usato. Chiedine un altro.';
    showLogin();
    return;
  }
  const mail = data.session.user ? data.session.user.email : '';
  setTrackUser(mail || null);
  $('login').classList.add('hidden');
  $('shell').classList.add('hidden');
  $('recupero').classList.remove('hidden');
  $('recEmail').textContent = mail || '';
  $('recError').textContent = '';
  $('recPassword').focus();
}

function initRecuperoUI() {
  $('recuperoForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('recError');
    const btn = $('recSubmit');
    const pw = $('recPassword').value;
    const pw2 = $('recPassword2').value;
    err.textContent = '';
    if (pw.length < 10) { err.textContent = 'Serve una password di almeno 10 caratteri.'; return; }
    if (pw !== pw2) { err.textContent = 'Le due password non sono uguali.'; return; }
    btn.disabled = true; btn.textContent = 'Salvo…';
    const { error } = await supabase.auth.updateUser({ password: pw });
    btn.disabled = false; btn.textContent = 'Salva ed entra';
    if (error) {
      err.textContent = isAuthError(error)
        ? 'Il link è scaduto mentre sceglievi la password. Chiedine un altro.'
        : (error.message || 'Non sono riuscito a salvare la password.');
      return;
    }
    $('recPassword').value = ''; $('recPassword2').value = '';
    track('PASSWORD');
    // scegliere una password vale quanto digitarla al login: i timbri di
    // inattività ripartono da adesso (vedi la nota in showApp)
    loginConPassword = true;
    inRecupero = false;
    const session = await requireSession();
    if (session) showApp(session); else showLogin();
  });
}

// ── avvio ─────────────────────────────────────────────────────────────────────
let resolved = false;
function resolve(session) {
  setTrackUser(session && session.user ? session.user.email : null);
  if (session) showApp(session); else showLogin();
}

initAuthUI();
initRecuperoUI();

// Va letto PRIMA che parta l'auth: se c'è un link di recupero, la schermata
// "scegli la password" ha la precedenza su login e app, e inRecupero deve
// essere già vero quando arriva il SIGNED_IN di setSession.
const FRAMMENTO = frammentoAuth();
if (FRAMMENTO && (FRAMMENTO.access_token || FRAMMENTO.token_hash)) inRecupero = true;
if (FRAMMENTO && FRAMMENTO.errore) {
  pulisciFrammento();
  avvisoLogin = 'Il link non è più valido (' + FRAMMENTO.errore + '). Chiedine un altro.';
}

onAuthStateChange((event, session) => {
  resolved = true;
  setTrackUser(session && session.user ? session.user.email : null);
  if (inRecupero) return;          // ci pensa avviaRecupero: qui non si cambia schermata
  // Copre tutti i casi, incluso INITIAL_SESSION con session=null (primo accesso, non loggato)
  if (session) showApp(session);
  else showLogin();
});
// rete di sicurezza se INITIAL_SESSION non scatta
setTimeout(async () => { if (!resolved && !inRecupero) resolve(await requireSession()); }, 1200);

if (FRAMMENTO && (FRAMMENTO.access_token || FRAMMENTO.token_hash)) avviaRecupero(FRAMMENTO);
