// manager-stats · accesso dati (paginazione PostgREST, cache anagrafica, freshness)
import { supabase } from './supabase.js';

const PAGE = 1000;

// PostgREST tronca a 1000 righe: pagina con .range() finché una pagina è "corta".
// factory: (lo, hi) => supabase.from(view).select(...).range(lo, hi)  (query builder monouso!)
export async function fetchAll(factory) {
  let lo = 0;
  let out = [];
  for (;;) {
    const hi = lo + PAGE - 1;
    const { data, error } = await factory(lo, hi);
    if (error) throw error;
    if (!data || !data.length) break;
    out = out.concat(data);
    if (data.length < PAGE) break;
    lo += PAGE;
  }
  return out;
}

// ── anagrafica centri (caricata una volta per sessione) ──────────────────────
let _centri = null;
let _centriById = null;

export async function loadCentri() {
  if (_centri) return _centri;
  _centri = await fetchAll((lo, hi) =>
    supabase.from('centri')
      .select('notion_id,nome,fb_ad_account_id,agenzia,stato_attivita,consulente,media_buyer')
      .range(lo, hi));
  _centriById = new Map(_centri.map(c => [c.notion_id, c]));
  return _centri;
}

export function centriMap() { return _centriById || new Map(); }
export function clearCentriCache() { _centri = null; _centriById = null; clearPersoneCache(); }

// ── anagrafica persone: da email o nome sporco al nome vero ──────────────────
// Nei dati la stessa persona compare in tre forme: email (centri.*, da Notion),
// nome pulito e nome sporco ("VALENTINA", "matteo carasso", "Giada,Giada").
// ms_persona_alias tiene insieme le tre forme; qui se ne carica la mappa una
// volta per sessione. ⚠️ Si traducono solo le ETICHETTE: le email restano le
// chiavi dei filtri e dello scoping (ms_accessi.consulente), non si toccano.
let _nomi = null;                             // chiave normalizzata → { nome, persona_id }

const key = s => {
  const k = String(s === null || s === undefined ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
  return k || null;
};

let _attive = null;                           // persona_id delle persone ancora nel team

export async function loadPersone() {
  if (_nomi) return _nomi;
  const { data, error } = await supabase.from('v_ms_nomi').select('chiave,nome,persona_id,attivo,ruoli');
  // un errore qui non deve impedire il render: si ripiega sui valori grezzi
  const righe = error ? [] : (data || []);
  _nomi = new Map(righe.map(r => [r.chiave, r]));
  _attive = new Set(righe.filter(r => r.attivo).map(r => r.persona_id));
  return _nomi;
}

export function clearPersoneCache() { _nomi = null; _attive = null; }

// chi è uscito dal team non occupa più un posto nei conti di capienza, ma il suo
// nome continua a risolversi ovunque nello storico
export function personaAttiva(pid) { return !_attive || !pid ? true : _attive.has(pid); }

// il ruolo dichiarato in anagrafica. Serve a segnalare le incoerenze: se su Notion
// un centro ha come consulente qualcuno che project manager non è, il numero non
// va nascosto — va mostrato con un avviso.
export function personaHaRuolo(raw, ruolo) {
  const r = (_nomi || new Map()).get(key(raw));
  if (!r || !Array.isArray(r.ruoli)) return true;   // in dubbio non si segnala niente
  return r.ruoli.indexOf(ruolo) !== -1;
}

// I rollup Notion arrivano anche come liste ("Vito ,Simone Alessandrini") e come
// array: si risolve pezzo per pezzo e si deduplica. Quello che non si conosce
// resta com'è — mai una casella vuota al posto di un valore che esiste.
export function nomeDi(raw) {
  if (raw === null || raw === undefined || raw === '') return raw;
  const pezzi = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map(v => String(v).trim()).filter(Boolean);
  if (!pezzi.length) return raw;
  const m = _nomi || new Map();
  const out = [];
  for (const p of pezzi) {
    const r = m.get(key(p));
    const n = r ? r.nome : p;
    if (out.indexOf(n) === -1) out.push(n);
  }
  return out.join(', ');
}

// chiave di aggregazione: due email della stessa persona devono fare UNA riga.
// Senza persona in anagrafica si ripiega sul valore normalizzato, così la riga
// resta a sé e non finisce a ingrossare "(non assegnato)".
export function personaDi(raw) {
  const r = (_nomi || new Map()).get(key(raw));
  return r ? r.persona_id : null;
}

export function chiavePersona(raw) {
  return personaDi(raw) || key(raw);
}

// ── freshness ────────────────────────────────────────────────────────────────
export async function loadFreshness() {
  const { data, error } = await supabase.from('v_freshness').select('fonte,aggiornato_a');
  if (error) throw error;
  let max = null;
  for (const r of (data || [])) {
    if (r.aggiornato_a && (!max || r.aggiornato_a > max)) max = r.aggiornato_a;
  }
  return max;
}
