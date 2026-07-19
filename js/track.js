// manager-stats · tracciamento utilizzo (fire-and-forget verso n8n → Sheet "MANAGER STATS · LOG UTILIZZO")
const TRACK_URL = 'https://n8n.srv1035791.hstgr.cloud/webhook/manager-stats-usage-31f0ad08-e48c';
const SID = Math.random().toString(36).slice(2, 10);
let email = null;

export function setTrackUser(e) { email = e || null; }

export function track(evento, pagina) {
  if (!email) return;
  const payload = JSON.stringify({
    email,
    evento,
    pagina: pagina || '',
    ua: navigator.userAgent,
    sid: SID,
  });
  // text/plain = niente preflight CORS; sendBeacon sopravvive alla chiusura della pagina
  try {
    const blob = new Blob([payload], { type: 'text/plain' });
    if (!(navigator.sendBeacon && navigator.sendBeacon(TRACK_URL, blob))) {
      fetch(TRACK_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: payload, keepalive: true }).catch(() => {});
    }
  } catch (err) { /* il tracciamento non deve mai bloccare l'app */ }
}
