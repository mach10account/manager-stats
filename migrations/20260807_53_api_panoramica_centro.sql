-- 2026-08-07 · PERFORMANCE · RPC api_panoramica_centro: la Panoramica scarica un
-- aggregato per centro in UNA chiamata invece di paginare v_panoramica_centro.
--
-- Perché: fetchAll paginava la vista a blocchi da 1000 righe e OGNI pagina ricalcolava
-- l'intera vista da zero (30 giorni ≈ 3 pagine, 90 ≈ 8) — sotto carico una pagina
-- costava 10s e la successiva sforava statement_timeout=15s → 57014 a schermo.
-- La sezione poi aggregava comunque per centro in JS: la granularità giornaliera
-- scaricata non serviva a niente. Qui si aggrega direttamente nel DB.
--
-- La funzione fa SOLO select+group by SOPRA la vista viva: nessuna definizione di KPI
-- duplicata (se cambia la vista, cambia anche questo risultato) e nessun modello di
-- permessi nuovo — funzione invoker + vista invoker ⇒ la RLS (ms_puo/ms_centri_scope)
-- si propaga da sola, come per tutte le api_*.
--
-- Misurato impersonando l'utente (30 giorni): 11,0s prima della migration 52,
-- 4,46s dopo, in una sola statement. Il frontend (panoramica.js) passa alla RPC
-- nello stesso deploy; la vista resta com'è per l'assistente e il drill-down.
--
-- ROLLBACK: drop function public.api_panoramica_centro(date, date);
--   (il frontend pre-RPC continua a funzionare: la vista non cambia)

create or replace function public.api_panoramica_centro(p_from date, p_to date)
returns table(
  centro_id uuid, centro text, consulente text,
  spesa numeric, impression numeric, lead_fb numeric, lead_reali numeric,
  risposte numeric, appuntamenti numeric, presenze numeric, non_presentati numeric,
  pacchetti numeric, ricavo numeric, potenziale numeric
)
language sql stable as $$
  select v.centro_id, max(v.centro), max(v.consulente),
         sum(v.spesa), sum(v.impression), sum(v.lead_fb), sum(v.lead_reali),
         sum(v.risposte), sum(v.appuntamenti), sum(v.presenze), sum(v.non_presentati),
         sum(v.pacchetti), sum(v.ricavo), sum(v.potenziale)
  from public.v_panoramica_centro v
  where v.giorno between p_from and p_to
  group by v.centro_id
$$;

grant execute on function public.api_panoramica_centro(date, date) to authenticated;
revoke execute on function public.api_panoramica_centro(date, date) from anon;
