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

// Errore JWT / permessi → forza il re-login
export function isAuthError(err) {
  if (!err) return false;
  const code = String(err.code || err.status || '');
  const msg = String(err.message || '').toLowerCase();
  return code === 'PGRST301' || code === '401' ||
         msg.includes('jwt') || msg.includes('permission denied') ||
         msg.includes('not authenticated');
}
