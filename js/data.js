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
      .select('notion_id,nome,fb_ad_account_id,agenzia,stato_attivita,consulente')
      .range(lo, hi));
  _centriById = new Map(_centri.map(c => [c.notion_id, c]));
  return _centri;
}

export function centriMap() { return _centriById || new Map(); }
export function clearCentriCache() { _centri = null; _centriById = null; }

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
