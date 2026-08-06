// manager-stats · assistente AI (bolla flottante, presente in ogni sezione)
//
// Parla con la edge function ms-assistente passando la sessione dell'utente:
// i permessi li applica il database, qui non c'è nessun controllo da fare.
// Il contesto (sezione aperta, periodo, consulente) viaggia con la domanda,
// così "questo mese" e "questo centro" significano quello che l'utente vede.
//
// ⚠️ Niente handler inline (onerror=, onclick=): la CSP in index.html non ha
// 'unsafe-inline' in script-src, quindi non verrebbero mai eseguiti. L'avatar
// si precarica una volta sola e si ripiega su un glifo se il file manca.
import { supabase } from './supabase.js';
import { getFilters } from './filters.js';
import { esc } from './format.js';
import { track } from './track.js';

const AVATAR = './assets/assistente.png';
const MAX_STORICO = 12;          // coppie domanda/risposta tenute in conversazione

const SEZIONI = {
  '/panoramica': 'Panoramica (KPI per centro)',
  '/marketing': 'Drill-down marketing di un centro',
  '/coorti': 'Coorti mensili dei lead',
  '/beauty': 'Beauty — chiamate CRM4 dei centri',
  '/vendita': 'Vendita — setter B2B',
  '/task': 'Task del team',
  '/sauron': 'Sauron — finance',
  '/accessi': 'Accessi e team',
};

const SPUNTI = [
  'Come si fa l\'onboarding di un cliente nuovo?',
  'Cosa faccio se il cliente non manda i dati?',
  'Quali miei centri sono sotto target questo mese?',
];

let storico = [];        // messaggi della conversazione a schermo
let chatId = null;       // conversazione corrente lato server (null = non ancora creata)
let vistaStorico = false;
let aperto = false;
let inCorso = false;
let montato = false;
let avatarOk = false;

const $ = s => document.querySelector(s);

function avatarHtml(cls) {
  return avatarOk
    ? `<img src="${AVATAR}" alt="" class="${cls}">`
    : `<span class="${cls} as-fallback" aria-hidden="true">AI</span>`;
}

function precaricaAvatar() {
  const img = new Image();
  img.addEventListener('load', () => {
    avatarOk = true;
    const b = $('#asBolla');
    if (b) b.innerHTML = avatarHtml('as-bolla-img');
    const h = $('#asHeadAvatar');
    if (h && h.parentNode) {
      const nuovo = document.createElement('img');
      nuovo.id = 'asHeadAvatar';
      nuovo.className = 'as-avatar';
      nuovo.alt = '';
      nuovo.src = AVATAR;
      h.parentNode.replaceChild(nuovo, h);
    }
    disegnaMessaggi();
  });
  img.src = AVATAR;
}

/** Markdown minimale, applicato DOPO l'escape: niente HTML dal modello. */
function md(testo) {
  const righe = esc(testo).split('\n');
  let out = '';
  let inLista = false;
  for (const rigaGrezza of righe) {
    const riga = rigaGrezza.trimEnd();
    const voce = riga.match(/^\s*[-*•]\s+(.*)$/);
    const num = riga.match(/^\s*\d+[.)]\s+(.*)$/);
    if (voce || num) {
      if (!inLista) { out += '<ul>'; inLista = true; }
      out += '<li>' + inline((voce || num)[1]) + '</li>';
      continue;
    }
    if (inLista) { out += '</ul>'; inLista = false; }
    if (!riga.trim()) continue;
    const tit = riga.match(/^#{1,4}\s+(.*)$/);
    if (tit) { out += '<p class="as-tit">' + inline(tit[1]) + '</p>'; continue; }
    out += '<p>' + inline(riga) + '</p>';
  }
  if (inLista) out += '</ul>';
  return out || '<p></p>';
}

function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // [F1.P03] → pillola: è il riferimento alla procedura, deve saltare all'occhio
    .replace(/\[([A-Z]\d(?:\.P[\d.]+)?)\]/g, '<span class="as-cod">$1</span>');
}

function contesto() {
  const grezzo = location.hash || '';
  const path = grezzo.replace(/^#/, '').split('?')[0] || '/panoramica';
  const f = getFilters();
  const c = {};
  if (SEZIONI[path]) c.sezione = SEZIONI[path];
  if (f.from && f.to) c.periodo = `dal ${f.from} al ${f.to}`;
  if (f.consulente) c.consulente = f.consulente;
  // il drill-down porta il centro nell'hash: #/marketing?centro=Nome
  const q = grezzo.split('?')[1];
  if (q) {
    const centro = new URLSearchParams(q).get('centro');
    if (centro) c.centro = centro;
  }
  return c;
}

// ── storico delle conversazioni ──────────────────────────────────────────────
// Le conversazioni si leggono direttamente da PostgREST: la RLS le lega a chi
// ha fatto login, quindi non serve passare dalla edge function.
function quando(iso) {
  const d = new Date(iso);
  const oggi = new Date();
  const stessoGiorno = d.toDateString() === oggi.toDateString();
  if (stessoGiorno) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
}

async function disegnaStorico() {
  const box = $('#asMsg');
  if (!box) return;
  box.innerHTML = '<div class="as-vuoto"><p>Carico le conversazioni…</p></div>';
  let righe = [];
  try {
    const { data, error } = await supabase
      .from('ms_chat')
      .select('id,titolo,aggiornata_il')
      .order('aggiornata_il', { ascending: false })
      .limit(40);
    if (error) throw error;
    righe = data || [];
  } catch (e) {
    box.innerHTML = '<div class="as-vuoto"><p>Non riesco a caricare lo storico (' +
      esc(e && e.message ? e.message : e) + ').</p></div>';
    return;
  }
  if (!righe.length) {
    box.innerHTML = '<div class="as-vuoto"><p>Nessuna conversazione salvata. Scrivimi qualcosa e la ritrovi qui.</p></div>';
    return;
  }
  box.innerHTML = '<div class="as-lista">' + righe.map(r =>
    '<div class="as-voce' + (r.id === chatId ? ' corrente' : '') + '">' +
      '<button type="button" class="as-voce-apri" data-chat="' + esc(r.id) + '">' +
        '<span class="as-voce-tit">' + esc(r.titolo) + '</span>' +
        '<span class="as-voce-data">' + esc(quando(r.aggiornata_il)) + '</span>' +
      '</button>' +
      '<button type="button" class="as-voce-del" data-del="' + esc(r.id) + '" title="Elimina">✕</button>' +
    '</div>').join('') + '</div>';

  box.querySelectorAll('[data-chat]').forEach(b =>
    b.addEventListener('click', () => apriConversazione(b.dataset.chat)));
  box.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      const id = b.dataset.del;
      b.disabled = true;
      try {
        const { error } = await supabase.from('ms_chat').delete().eq('id', id);
        if (error) throw error;
        if (id === chatId) { chatId = null; storico = []; }
        disegnaStorico();
      } catch (e) { b.disabled = false; }
    }));
}

async function apriConversazione(id) {
  const box = $('#asMsg');
  box.innerHTML = '<div class="as-vuoto"><p>Apro la conversazione…</p></div>';
  try {
    const { data, error } = await supabase
      .from('ms_chat_messaggio')
      .select('ruolo,testo,fonti')
      .eq('chat_id', id)
      .order('id', { ascending: true });
    if (error) throw error;
    storico = (data || []).map(m => ({ ruolo: m.ruolo, testo: m.testo, fonti: m.fonti || [] }));
    chatId = id;
    vistaStorico = false;
    aggiornaTestata();
    disegnaMessaggi();
  } catch (e) {
    box.innerHTML = '<div class="as-vuoto"><p>Non riesco ad aprirla (' +
      esc(e && e.message ? e.message : e) + ').</p></div>';
  }
}

function aggiornaTestata() {
  const b = $('#asStorico');
  if (b) b.classList.toggle('attivo', vistaStorico);
}

function disegnaMessaggi() {
  const box = $('#asMsg');
  if (!box) return;
  if (vistaStorico) return;   // la lista ha la precedenza finché è aperta

  if (!storico.length && !inCorso) {
    box.innerHTML =
      '<div class="as-vuoto">' +
      avatarHtml('as-avatar-big') +
      '<p>Chiedimi come funziona una procedura, oppure cosa dicono i tuoi numeri.</p>' +
      '<div class="as-spunti">' +
      SPUNTI.map(s => '<button type="button" data-spunto="' + esc(s) + '">' + esc(s) + '</button>').join('') +
      '</div></div>';
    box.querySelectorAll('[data-spunto]').forEach(b =>
      b.addEventListener('click', () => { $('#asInput').value = b.dataset.spunto; invia(); }));
    return;
  }

  box.innerHTML = storico.map(m => {
    if (m.ruolo === 'utente') {
      return '<div class="as-riga as-io"><div class="as-bolla">' + esc(m.testo) + '</div></div>';
    }
    const fonti = m.fonti && m.fonti.length
      ? '<div class="as-fonti">Fonti: ' + m.fonti.map(f => esc(f)).join(' · ') + '</div>'
      : '';
    return '<div class="as-riga as-lui">' + avatarHtml('as-avatar') +
      '<div class="as-bolla as-testo">' + md(m.testo) + fonti + '</div></div>';
  }).join('') + (inCorso
    ? '<div class="as-riga as-lui">' + avatarHtml('as-avatar') +
      '<div class="as-bolla as-attesa"><span></span><span></span><span></span></div></div>'
    : '');
  box.scrollTop = box.scrollHeight;
}

async function invia() {
  const input = $('#asInput');
  const testo = (input.value || '').trim();
  if (!testo || inCorso) return;
  input.value = '';
  input.style.height = 'auto';
  // scrivere mentre si guarda lo storico riporta alla conversazione
  vistaStorico = false;
  aggiornaTestata();
  storico.push({ ruolo: 'utente', testo });
  inCorso = true;
  disegnaMessaggi();
  aggiornaInvio();
  track('ASSISTENTE', testo.slice(0, 60));

  try {
    const messaggi = storico.slice(-MAX_STORICO * 2).map(m => ({ ruolo: m.ruolo, testo: m.testo }));
    const { data, error } = await supabase.functions.invoke('ms-assistente', {
      body: { messaggi, contesto: contesto(), chat_id: chatId },
    });
    if (error) throw error;
    if (data && data.chat_id) chatId = data.chat_id;
    if (data && data.errore) {
      storico.push({ ruolo: 'assistente', testo: 'Non ha funzionato: ' + data.errore });
    } else {
      storico.push({
        ruolo: 'assistente',
        testo: (data && data.risposta) || 'Nessuna risposta.',
        fonti: (data && data.fonti) || [],
      });
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    storico.push({
      ruolo: 'assistente',
      testo: 'Non sono riuscito a rispondere (' + msg + '). Riprova fra poco.',
    });
  } finally {
    inCorso = false;
    disegnaMessaggi();
    aggiornaInvio();
  }
}

function aggiornaInvio() {
  const b = $('#asInvia');
  if (b) b.disabled = inCorso;
}

function apri(vero) {
  aperto = vero;
  const p = $('#asPannello');
  const b = $('#asBolla');
  if (!p || !b) return;
  p.classList.toggle('aperto', aperto);
  b.classList.toggle('attivo', aperto);
  b.setAttribute('aria-expanded', aperto ? 'true' : 'false');
  if (aperto) {
    disegnaMessaggi();
    setTimeout(() => { const i = $('#asInput'); if (i) i.focus(); }, 60);
  }
}

export function initAssistente() {
  if (montato) return;
  montato = true;

  const host = document.createElement('div');
  host.id = 'asHost';
  host.innerHTML = `
    <button id="asBolla" type="button" aria-expanded="false" title="Assistente">${avatarHtml('as-bolla-img')}</button>
    <section id="asPannello" aria-label="Assistente">
      <header class="as-head">
        <span id="asHeadAvatar" class="as-avatar as-fallback" aria-hidden="true">AI</span>
        <div class="as-head-txt">
          <strong>Assistente</strong>
          <span>procedure e dati della piattaforma</span>
        </div>
        <button id="asStorico" type="button" title="Conversazioni salvate">Storico</button>
        <button id="asPulisci" type="button" title="Nuova conversazione">Nuova</button>
        <button id="asChiudi" type="button" title="Chiudi">✕</button>
      </header>
      <div id="asMsg" class="as-msg"></div>
      <form id="asForm" class="as-foot">
        <textarea id="asInput" rows="1" placeholder="Scrivi la tua domanda…"></textarea>
        <button id="asInvia" type="submit" title="Invia">↑</button>
      </form>
    </section>`;
  document.body.appendChild(host);

  $('#asBolla').addEventListener('click', () => apri(!aperto));
  $('#asChiudi').addEventListener('click', () => apri(false));
  $('#asStorico').addEventListener('click', () => {
    vistaStorico = !vistaStorico;
    aggiornaTestata();
    if (vistaStorico) disegnaStorico(); else disegnaMessaggi();
  });
  // "Nuova" stacca dalla conversazione salvata: la successiva domanda ne apre
  // un'altra invece di accodarsi a quella vecchia.
  $('#asPulisci').addEventListener('click', () => {
    storico = [];
    chatId = null;
    vistaStorico = false;
    aggiornaTestata();
    disegnaMessaggi();
  });
  $('#asForm').addEventListener('submit', e => { e.preventDefault(); invia(); });

  const input = $('#asInput');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); invia(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 130) + 'px';
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && aperto) apri(false); });

  disegnaMessaggi();
  precaricaAvatar();
}

/** Chiamata al logout: la conversazione non deve sopravvivere al cambio utente. */
export function resetAssistente() {
  storico = [];
  chatId = null;
  vistaStorico = false;
  apri(false);
  aggiornaTestata();
  disegnaMessaggi();
}
