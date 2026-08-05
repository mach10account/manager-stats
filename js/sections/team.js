// manager-stats · Team (tab dentro Accessi, solo admin)
//
// L'anagrafica delle persone: un nome, i ruoli, e TUTTE le forme con cui la
// persona compare nei dati (email di Notion e varianti di nome degli incassi).
// Serve perché nelle dashboard si leggeva "smnalessandrini@gmail.com": su 31
// email-persona solo 3 hanno un login, quindi il nome non poteva venire da lì.
//
// ⚠️ Qui si cambiano solo le ETICHETTE: le email restano le chiavi dei filtri e
// dello scoping (ms_accessi.consulente). Collegare due email a una persona NON
// dà accesso ai centri dell'altra — quello si imposta nella tab Login.
//
// Scritture: tutte via RPC security definer con guardia admin (migration 44).
import { supabase } from '../supabase.js';
import { esc } from '../format.js';
import { clearPersoneCache, loadPersone } from '../data.js';

let _mount = null;
let PERSONE = [];
let ORFANI = [];
let UTENTI = [];

const RUOLI = [
  ['PM', 'Project manager'], ['BEAUTY', 'Beauty specialist'], ['MEDIA_BUYER', 'Media buyer'],
  ['VENDITORE', 'Venditore'], ['SETTER', 'Setter'], ['STAFF', 'Staff'],
];

const TEAM_HTML = `
  <div class="card" id="tmOrfaniCard" hidden>
    <div class="mk-head">
      <h2 style="margin-right:auto">Da collegare <span id="tmOrfaniN" class="tk-count"></span></h2>
      <button class="tk-btn" id="tmSync">Cerca persone nuove</button>
    </div>
    <div class="subtitle">Nomi ed email che nei dati ci sono ma non sono ancora di nessuno.
      Finché questa lista è vuota, in nessuna dashboard compare un valore senza nome —
      e quando il sync notturno porta una persona nuova, il giorno dopo la trovi qui.</div>
    <div class="table-scroll"><table class="mt-table" id="tmOrfani"></table></div>
  </div>

  <div class="card" id="tmDaConfCard" hidden>
    <h2>Da confermare <span id="tmDaConfN" class="tk-count"></span></h2>
    <div class="subtitle">Collegamenti che ho dedotto io dal cognome: il nome negli incassi
      corrisponde a una sola email e viceversa. Controllali e confermali.</div>
    <div class="table-scroll"><table class="mt-table" id="tmDaConf"></table></div>
  </div>

  <div class="card">
    <div class="mk-head">
      <h2 style="margin-right:auto">Persone <span id="tmN" class="tk-count"></span></h2>
      <label class="tm-toggle"><input type="checkbox" id="tmExMembri"> Mostra chi è uscito</label>
      <button class="tk-btn tk-btn-pri" id="tmNuova">Aggiungi persona</button>
    </div>
    <div class="subtitle">Il <strong>nome</strong> qui è quello che si legge in tutte le sezioni.
      Le <strong>email e i nomi collegati</strong> sono le forme con cui la persona compare nei dati:
      aggiungerne una la fa riconoscere anche lì. Chi ha il nome ancora dedotto è segnalato.</div>
    <div class="table-scroll"><table class="mt-table" id="tmTable"></table></div>
    <div id="tmStatus" class="status loading">Caricamento anagrafica…</div>
  </div>`;

// ── disegno ──────────────────────────────────────────────────────────────────
const optPersone = (sel) => PERSONE.filter(p => p.attivo)
  .map(p => `<option value="${p.id}"${p.id === sel ? ' selected' : ''}>${esc(p.nome)}</option>`).join('');

function disegnaOrfani() {
  const card = _mount.querySelector('#tmOrfaniCard');
  const el = _mount.querySelector('#tmOrfani');
  if (!card || !el) return;
  card.hidden = false;
  _mount.querySelector('#tmOrfaniN').textContent = ORFANI.length;
  if (!ORFANI.length) {
    el.innerHTML = '<tbody><tr><td class="mt-vuoto">Nessuno: ogni valore nei dati ha la sua persona. 🎉</td></tr></tbody>';
    return;
  }
  el.innerHTML = `
    <thead><tr><th>Valore nei dati</th><th>Dove</th><th>Righe</th><th>Persona</th><th></th></tr></thead>
    <tbody>${ORFANI.map(o => `
      <tr data-chiave="${esc(o.chiave)}">
        <td><b>${esc(o.valore)}</b> <span class="tm-tipo">${o.tipo === 'email' ? 'email' : 'nome'}</span></td>
        <td class="tm-fonte">${esc(o.fonti || '')}</td>
        <td class="tm-num">${o.righe}</td>
        <td><select class="cell-sel tm-assegna">
          <option value="">— scegli —</option>${optPersone(null)}
        </select></td>
        <td class="tm-azioni">
          <button class="tk-btn tm-crea">Crea persona</button>
          <button class="tk-btn tm-ignora" title="Non è una persona: non chiedermelo più">Ignora</button>
        </td>
      </tr>`).join('')}</tbody>`;

  el.querySelectorAll('tr[data-chiave]').forEach(tr => {
    const chiave = tr.dataset.chiave;
    const o = ORFANI.find(x => x.chiave === chiave);
    tr.querySelector('.tm-assegna').onchange = e => {
      if (e.target.value) assegna(o.valore, e.target.value, o.tipo);
    };
    tr.querySelector('.tm-crea').onclick = () => creaDaOrfano(o);
    tr.querySelector('.tm-ignora').onclick = () => assegna(o.valore, null, o.tipo);
  });
}

function disegnaDaConfermare() {
  const card = _mount.querySelector('#tmDaConfCard');
  const el = _mount.querySelector('#tmDaConf');
  if (!card || !el) return;
  const righe = [];
  for (const p of PERSONE) {
    for (const a of (p.alias || [])) if (!a.confermato) righe.push({ p, a });
  }
  card.hidden = righe.length === 0;
  if (!righe.length) return;
  _mount.querySelector('#tmDaConfN').textContent = righe.length;
  el.innerHTML = `
    <thead><tr><th>Nome trovato nei dati</th><th>Collegato a</th><th></th></tr></thead>
    <tbody>${righe.map(r => `
      <tr data-chiave="${esc(r.a.chiave)}" data-persona="${r.p.id}">
        <td><b>${esc(r.a.valore)}</b></td>
        <td>${esc(r.p.nome)}</td>
        <td class="tm-azioni">
          <button class="tk-btn tm-conferma">Confermo</button>
          <button class="tk-btn tm-stacca">No, staccalo</button>
        </td>
      </tr>`).join('')}</tbody>`;
  el.querySelectorAll('tr[data-chiave]').forEach(tr => {
    tr.querySelector('.tm-conferma').onclick = () =>
      assegna(tr.querySelector('b').textContent, tr.dataset.persona, 'nome');
    tr.querySelector('.tm-stacca').onclick = () => rimuoviAlias(tr.dataset.chiave);
  });
}

function disegnaPersone() {
  const el = _mount.querySelector('#tmTable');
  if (!el) return;
  const mostraEx = _mount.querySelector('#tmExMembri').checked;
  const righe = PERSONE.filter(p => mostraEx || p.attivo);
  _mount.querySelector('#tmN').textContent = righe.length;

  el.innerHTML = `
    <thead><tr>
      <th>Nome</th><th>Ruoli</th><th>Email e nomi collegati</th>
      <th>Telefono</th><th>Centri</th><th>Login</th><th>Nel team</th><th></th>
    </tr></thead>
    <tbody>${righe.map(p => {
      const centri = [
        p.centri_pm ? p.centri_pm + ' PM' : '',
        p.centri_beauty ? p.centri_beauty + ' beauty' : '',
        p.centri_mb ? p.centri_mb + ' MB' : '',
      ].filter(Boolean).join(' · ');
      return `
      <tr data-id="${p.id}"${p.attivo ? '' : ' class="tm-uscito"'}>
        <td><div class="tm-col tm-col-nome">
          <input class="cell-inp tm-nome" value="${esc(p.nome)}" placeholder="Nome e cognome">
          ${p.nome_auto ? '<div class="badge-nota" title="L\'ho dedotto io dall\'email o dagli incassi: controllalo">nome dedotto</div>' : ''}
        </div></td>
        <td><div class="tm-col tm-col-ruoli">${RUOLI.map(([k, l]) =>
          `<button class="tm-chip${(p.ruoli || []).includes(k) ? ' on' : ''}" data-ruolo="${k}" title="${esc(l)}">${esc(l)}</button>`).join('')}</div></td>
        <td><div class="tm-col tm-col-alias">
          ${(p.alias || []).map(a => `<span class="tm-chip alias${a.confermato ? '' : ' da-conf'}">
            ${esc(a.valore)}<button class="tm-x" data-chiave="${esc(a.chiave)}" title="Stacca">✕</button></span>`).join('')}
          <input class="tm-add" placeholder="+ email o nome">
        </div></td>
        <td><input class="cell-inp tm-tel" value="${esc(p.telefono || '')}" placeholder="+39…"></td>
        <td class="tm-num">${esc(centri || '—')}</td>
        <td>${p.login_email
          ? `<span class="tm-login">${esc(p.login_email)}</span>`
          : `<div class="tm-col"><select class="cell-sel tm-login-sel"><option value="">— nessuno —</option>${
              UTENTI.filter(u => !PERSONE.some(x => x.user_id === u.user_id))
                .map(u => `<option value="${u.user_id}">${esc(u.email)}</option>`).join('')}</select>
              <button class="tk-btn tm-invita">Invita</button></div>`}</td>
        <td><input type="checkbox" class="tm-attivo"${p.attivo ? ' checked' : ''}></td>
        <td class="tm-azioni">${(p.alias || []).length === 0 && !p.user_id
          ? '<button class="tk-btn tm-elimina">Elimina</button>' : ''}</td>
      </tr>`;
    }).join('')}</tbody>`;

  el.querySelectorAll('tr[data-id]').forEach(tr => {
    const id = tr.dataset.id;
    tr.querySelector('.tm-nome').onchange = e => salva(id, { p_nome: e.target.value });
    tr.querySelector('.tm-attivo').onchange = e => salva(id, { p_attivo: e.target.checked });
    tr.querySelector('.tm-tel').onchange = e => salva(id, { p_telefono: e.target.value });
    tr.querySelectorAll('.tm-chip[data-ruolo]').forEach(b => {
      b.onclick = () => {
        const p = PERSONE.find(x => x.id === id);
        const attuali = new Set(p.ruoli || []);
        if (attuali.has(b.dataset.ruolo)) attuali.delete(b.dataset.ruolo); else attuali.add(b.dataset.ruolo);
        salva(id, { p_ruoli: [...attuali] });
      };
    });
    tr.querySelectorAll('.tm-x').forEach(b => { b.onclick = () => rimuoviAlias(b.dataset.chiave); });
    const add = tr.querySelector('.tm-add');
    if (add) add.onchange = () => { if (add.value.trim()) assegna(add.value, id, null); };
    const ls = tr.querySelector('.tm-login-sel');
    if (ls) ls.onchange = () => { if (ls.value) collegaLogin(id, ls.value); };
    const inv = tr.querySelector('.tm-invita');
    if (inv) inv.onclick = () => apriInvito(PERSONE.find(x => x.id === id));
    const del = tr.querySelector('.tm-elimina');
    if (del) del.onclick = () => elimina(id);
  });
}

// ── scritture ────────────────────────────────────────────────────────────────
async function rpc(nome, args, msg) {
  const { data, error } = await supabase.rpc(nome, args);
  if (error) { alert(msg + ': ' + error.message); return null; }
  await ricarica();
  return data;
}

const salva = (id, campi) => rpc('ms_persona_salva', { p_id: id, ...campi }, 'Non sono riuscito a salvare');
const assegna = (valore, persona, tipo) =>
  rpc('ms_alias_assegna', { p_valore: valore, p_persona: persona || null, p_tipo: tipo || null },
      'Non sono riuscito a collegare');
const rimuoviAlias = chiave => rpc('ms_alias_rimuovi', { p_chiave: chiave }, 'Non sono riuscito a staccare');
const collegaLogin = (persona, user) =>
  rpc('ms_persona_collega_login', { p_persona: persona, p_user: user }, 'Non sono riuscito a collegare il login');

async function elimina(id) {
  const p = PERSONE.find(x => x.id === id);
  if (!confirm('Elimino "' + (p ? p.nome : '') + '" dall\'anagrafica? I dati storici non si toccano.')) return;
  await rpc('ms_persona_elimina', { p_id: id }, 'Non sono riuscito a eliminare');
}

async function nuovaPersona() {
  const nome = prompt('Nome e cognome della persona:');
  if (!nome || !nome.trim()) return;
  await rpc('ms_persona_salva', { p_nome: nome.trim() }, 'Non sono riuscito a creare la persona');
}

// da un valore orfano: crea la persona con quel nome (o col nome dedotto
// dall'email) e le attacca subito il valore
async function creaDaOrfano(o) {
  const suggerito = o.tipo === 'email' ? '' : o.valore;
  const nome = prompt('Nome e cognome per "' + o.valore + '":', suggerito);
  if (!nome || !nome.trim()) return;
  const { data, error } = await supabase.rpc('ms_persona_salva', { p_nome: nome.trim() });
  if (error) { alert('Non sono riuscito a creare la persona: ' + error.message); return; }
  await assegna(o.valore, data, o.tipo);
}

// ── invito ad accedere ───────────────────────────────────────────────────────
// La Edge Function `ms-invita` crea l'utente con la service key (che non può
// stare qui: il sito è pubblico) e restituisce il link di accesso. Il link torna
// SEMPRE, anche quando il canale scelto consegna: è la via di fuga se non arriva.
function apriInvito(p) {
  if (!p) return;
  const mailSuggerita = (p.alias || []).filter(a => a.tipo === 'email').map(a => a.valore)[0] || '';
  const telSuggerito = p.telefono || '';
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `
    <div class="modal-card tm-invito">
      <div class="modal-head"><h3>Invita ${esc(p.nome)}</h3>
        <button class="modal-close" title="Chiudi">✕</button></div>
      <div class="modal-sub">Gli creo l'accesso a Manager Stats e gli mando il link per entrare
        e scegliersi la password. Le sezioni che vedrà si assegnano dopo, nella tab Login e permessi.</div>
      <div class="tk-campi">
        <label class="tk-campo tk-largo">Email<input type="email" id="tmInvEmail" value="${esc(mailSuggerita)}" placeholder="nome@dominio.it"></label>
        <label class="tk-campo tk-largo">Come glielo mando
          <select id="tmInvCanale">
            <option value="whatsapp">WhatsApp</option>
            <option value="email">Email</option>
            <option value="link">Solo il link, lo mando io</option>
          </select></label>
        <label class="tk-campo tk-largo" id="tmInvTelWrap">Telefono<input type="tel" id="tmInvTel" value="${esc(telSuggerito)}" placeholder="333 1234567"></label>
      </div>
      <div class="tm-invito-esito" id="tmInvEsito"></div>
      <div class="tk-azioni tk-azioni-form">
        <button class="tk-btn" id="tmInvAnnulla">Annulla</button>
        <button class="tk-btn tk-btn-pri" id="tmInvOk">Crea l'accesso</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const chiudi = () => ov.remove();
  ov.querySelector('.modal-close').onclick = chiudi;
  ov.querySelector('#tmInvAnnulla').onclick = chiudi;
  ov.onclick = e => { if (e.target === ov) chiudi(); };
  const canale = ov.querySelector('#tmInvCanale');
  const telWrap = ov.querySelector('#tmInvTelWrap');
  const aggiornaTel = () => { telWrap.style.display = canale.value === 'whatsapp' ? '' : 'none'; };
  canale.onchange = aggiornaTel;
  aggiornaTel();

  ov.querySelector('#tmInvOk').onclick = async () => {
    const btn = ov.querySelector('#tmInvOk');
    const esito = ov.querySelector('#tmInvEsito');
    btn.disabled = true;
    esito.textContent = 'Sto creando l\'accesso…';
    const { data, error } = await supabase.functions.invoke('ms-invita', {
      body: {
        email: ov.querySelector('#tmInvEmail').value.trim(),
        nome: p.nome,
        persona_id: p.id,
        canale: canale.value,
        telefono: ov.querySelector('#tmInvTel').value.trim(),
        sezioni: [],
      },
    });
    btn.disabled = false;
    if (error || (data && data.error)) {
      esito.className = 'tm-invito-esito val-bad';
      esito.textContent = (data && data.error) || error.message;
      return;
    }
    esito.className = 'tm-invito-esito';
    esito.innerHTML = `
      <div class="${data.avviso ? 'val-bad' : 'val-good'}">${
        data.avviso ? esc(data.avviso)
          : (data.inviato === 'whatsapp' ? 'Link mandato su WhatsApp.'
            : data.inviato === 'email' ? 'Email di invito partita.'
            : 'Accesso creato: copia il link e mandaglielo.')}</div>
      <input class="cell-inp tm-invito-link" readonly value="${esc(data.url || '')}">
      <button class="tk-btn" id="tmInvCopia">Copia il link</button>`;
    const copia = ov.querySelector('#tmInvCopia');
    if (copia) copia.onclick = () => {
      const inp = ov.querySelector('.tm-invito-link');
      inp.select();
      navigator.clipboard.writeText(inp.value).then(() => { copia.textContent = 'Copiato'; }, () => {});
    };
    await ricarica();
  };
}

// ── caricamento ──────────────────────────────────────────────────────────────
async function ricarica() {
  const [anag, orf, utenti] = await Promise.all([
    supabase.rpc('ms_anagrafica'),
    supabase.from('v_ms_alias_orfani').select('chiave,valore,tipo,fonti,righe').order('righe', { ascending: false }),
    supabase.rpc('ms_lista_utenti'),
  ]);
  if (anag.error) throw anag.error;
  PERSONE = anag.data || [];
  ORFANI = orf.data || [];
  UTENTI = (utenti.data || []).filter(u => u.email);
  clearPersoneCache();          // i nomi sono cambiati: le altre sezioni devono rileggerli
  await loadPersone();
  const st = _mount.querySelector('#tmStatus');
  if (st) st.remove();
  disegnaOrfani();
  disegnaDaConfermare();
  disegnaPersone();
}

export async function render(mount) {
  _mount = mount;
  mount.innerHTML = TEAM_HTML;
  mount.querySelector('#tmNuova').onclick = nuovaPersona;
  mount.querySelector('#tmExMembri').onchange = disegnaPersone;
  mount.querySelector('#tmSync').onclick = async () => {
    const n = await rpc('ms_persone_sync', {}, 'Non sono riuscito a cercare le persone nuove');
    if (n !== null) alert(n > 0 ? n + ' persone o collegamenti nuovi.' : 'Nessuna persona nuova.');
  };
  try {
    await ricarica();
  } catch (e) {
    const st = mount.querySelector('#tmStatus');
    if (st) { st.textContent = 'Non hai i permessi per gestire il team.'; st.classList.remove('loading'); }
  }
}
