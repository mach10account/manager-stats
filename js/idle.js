// manager-stats · scadenza della sessione lato client
//
// Le sessioni Supabase di questo progetto non scadono da sole: il refresh token
// si rinnova all'infinito (auth.sessions.not_after è null su tutte le righe),
// quindi un token copiato da localStorage varrebbe per sempre. Qui la sessione
// si chiude dopo un periodo di inattività e comunque dopo un tetto massimo dal
// primo accesso. Il timebox lato server è a pagamento sul piano attuale: questa
// è la difesa che possiamo permetterci, ed è comunque quella che accorcia la
// finestra utile di un token rubato da "per sempre" a mezza giornata.
//
// Si ragiona per TIMESTAMP, mai per countdown: un setInterval non scatta mentre
// il portatile dorme, e al risveglio il conteggio sarebbe sbagliato per difetto.
//
// I timbri stanno in localStorage sotto un'unica chiave, insieme all'id
// dell'utente: più tab dello stesso browser si tengono vive a vicenda, e un
// utente diverso nella stessa tab riparte da orologi puliti senza ereditare
// (né azzerare) quelli di chi c'era prima.

const CHIAVE = 'ms_sessione';

// Ritoccabili: sono le due manopole di tutto il file.
export const IDLE_MS     = 90 * 60 * 1000;        // 90 min senza toccare nulla
export const ASSOLUTO_MS = 12 * 60 * 60 * 1000;   // 12 ore dal primo accesso, comunque

// Volutamente NON c'è pointermove: un urto al trackpad (o un mouse-jiggler)
// terrebbe viva la sessione all'infinito. Contano i gesti veri.
const EVENTI = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
const OGNI_MS = 30 * 1000;                        // ogni quanto si ricontrolla
const THROTTLE_MS = 10 * 1000;                    // ogni quanto si riscrive il timbro

let timer = null;
let onScaduta = null;
let utente = null;
let ultimoScritto = 0;

function leggi() {
  try {
    const s = JSON.parse(localStorage.getItem(CHIAVE) || 'null');
    return s && s.uid ? s : null;
  } catch (e) { return null; }
}

function scrivi(s) {
  try { localStorage.setItem(CHIAVE, JSON.stringify(s)); } catch (e) { /* storage negato */ }
}

// Quanto manca alla scadenza, o il motivo se è già passata.
function scadenza(s) {
  if (!s) return null;
  const adesso = Date.now();
  // un orologio di sistema spostato indietro non deve regalare tempo
  const inizio = Math.min(s.inizio || adesso, adesso);
  const ultima = Math.min(s.attivita || adesso, adesso);
  if (adesso - ultima >= IDLE_MS) return 'inattivita';
  if (adesso - inizio >= ASSOLUTO_MS) return 'durata';
  return null;
}

function segnalaAttivita() {
  if (!utente) return;
  const adesso = Date.now();
  if (adesso - ultimoScritto < THROTTLE_MS) return;
  ultimoScritto = adesso;
  const s = leggi();
  if (!s || s.uid !== utente) return;
  s.attivita = adesso;
  scrivi(s);
}

function controlla() {
  if (!utente) return;
  const s = leggi();
  // la chiave è sparita (altra tab uscita, storage ripulito): si esce anche qui
  const motivo = !s || s.uid !== utente ? 'durata' : scadenza(s);
  if (!motivo) return;
  const cb = onScaduta;
  stop();
  if (cb) cb(motivo);
}

// Tornare sulla tab NON conta come attività: il portatile può essersi
// risvegliato dopo ore. È però il momento giusto per ricontrollare subito,
// senza aspettare il prossimo giro del timer.
function alRitorno() {
  if (!document.hidden) controlla();
}

// Arma il timer per l'utente indicato.
// Torna null se la sessione è valida, oppure il motivo se è GIÀ scaduta (in quel
// caso non arma niente: tocca al chiamante portare l'utente al login).
export function start(uid, callback) {
  if (!uid) return null;                 // senza utente non si sorveglia niente
  if (utente === uid) return null;       // già armato: TOKEN_REFRESHED rientra qui ogni ora
  const adesso = Date.now();
  let s = leggi();
  // Utente diverso (o primo accesso) → orologi nuovi. Stesso utente → si
  // RIPRENDONO i timbri esistenti così come sono.
  const nuova = !s || s.uid !== uid;
  if (nuova) s = { uid: uid, inizio: adesso, attivita: adesso };
  const motivo = scadenza(s);
  if (motivo) return motivo;

  utente = uid;
  onScaduta = callback;
  ultimoScritto = adesso;
  // Solo un accesso NUOVO conta come attività. Una ricarica no: altrimenti
  // basterebbe un F5 ogni tanto per non scadere mai, e una tab ripristinata
  // all'avvio del browser fingerebbe che ci sia qualcuno davanti allo schermo.
  if (nuova) scrivi(s);
  EVENTI.forEach(e => document.addEventListener(e, segnalaAttivita, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', alRitorno);
  window.addEventListener('focus', alRitorno);
  timer = setInterval(controlla, OGNI_MS);
  return null;
}

// Smonta il timer ma NON tocca i timbri: showLogin() parte anche per un 401
// isolato in una tab, e in quel caso il tetto delle 12 ore non va perso.
export function stop() {
  if (!utente) return;
  utente = null;
  onScaduta = null;
  clearInterval(timer);
  timer = null;
  EVENTI.forEach(e => document.removeEventListener(e, segnalaAttivita, { capture: true }));
  document.removeEventListener('visibilitychange', alRitorno);
  window.removeEventListener('focus', alRitorno);
}

// Uscita vera (bottone Esci o scadenza): via anche i timbri, così il prossimo
// accesso riparte da zero invece di trovarsi già scaduto.
export function azzera() {
  stop();
  try { localStorage.removeItem(CHIAVE); } catch (e) { /* storage negato */ }
}
