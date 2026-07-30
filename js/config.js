// manager-stats · configurazione pubblica (URL + anon key sono pubblici by design)
export const SUPABASE_URL = 'https://ueejjgocuvmmkxsogdvu.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_YtGwRUwqcVGWF-ai_fTQcg_m1-Df5eP';

// versione supabase-js pinnata (ESM da CDN)
export const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.47.10/+esm';

// proxy n8n per le note lead (GHL): verifica il login Supabase + permesso vendita,
// poi legge le note col PIT che sta nelle credenziali n8n (mai esposto al browser)
export const NOTE_PROXY_URL = 'https://n8n.srv1035791.hstgr.cloud/webhook/ms-note-lead-b4e7';
