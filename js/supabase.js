// manager-stats · client Supabase + auth
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.47.10/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export async function requireSession() {
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export function onAuthStateChange(cb) {
  return supabase.auth.onAuthStateChange(cb);
}

// Errore di SESSIONE (jwt scaduto/assente) → forza il re-login.
// NB: "permission denied" NON va qui. Da quando esistono gli accessi per sezione
// (ms_accessi) è un errore di autorizzazione, non di autenticazione: trattarlo come
// sessione scaduta manderebbe l'utente in loop login → sezione negata → login.
export function isAuthError(err) {
  if (!err) return false;
  const code = String(err.code || err.status || '');
  const msg = String(err.message || '').toLowerCase();
  return code === 'PGRST301' || code === '401' ||
         msg.includes('jwt') || msg.includes('not authenticated');
}
