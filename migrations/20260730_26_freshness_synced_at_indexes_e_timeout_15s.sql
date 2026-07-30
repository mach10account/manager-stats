-- v_freshness fa max(synced_at) su 6 tabelle: senza indice = 6 seq scan a OGNI
-- caricamento pagina (~1s in condizioni normali, >8s → 500 durante i picchi).
-- Con l'indice il planner usa un index-scan all'indietro (~1ms).
create index if not exists idx_calls_synced_at          on public.calls (synced_at);
create index if not exists idx_mkt_leads_synced_at      on public.mkt_leads (synced_at);
create index if not exists idx_appuntamenti_synced_at   on public.appuntamenti (synced_at);
create index if not exists idx_perf_giorno_synced_at    on public.perf_giorno (synced_at);
create index if not exists idx_fb_insights_ad_synced_at on public.fb_insights_ad (synced_at);
create index if not exists idx_centri_synced_at         on public.centri (synced_at);

-- Durante i picchi (sync n8n orari + utenti) l'istanza satura e le query oltre 8s
-- vengono uccise (57014 statement timeout). 15s dà respiro alle viste pesanti
-- senza tenere in coda le richieste troppo a lungo.
alter role authenticated set statement_timeout = '15s';
notify pgrst, 'reload config';
