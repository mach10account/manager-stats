-- Sauron · tab Marketing: una sola riga di inserimento per mese, tutto il resto
-- della pagina (KPI, funnel, grafico, tabella) si calcola da qui.
-- Sostituisce fin_mkt_spesa/fin_mkt_contatti della migration 42, nate stamattina
-- e mai usate (0 righe): il disegno è cambiato prima che ci scrivesse qualcuno.
-- RLS come fin_costi: 'finance' non ha un ramo in ms_puo → passa solo l'admin.

drop table if exists public.fin_mkt_contatti;
drop table if exists public.fin_mkt_spesa;

create table if not exists public.fin_mkt_mese (
  mese           text primary key,               -- 'YYYY-MM'
  budget_meta    numeric,
  budget_google  numeric,
  impressioni    numeric,
  click          numeric,
  lead           numeric,
  contatti       numeric,
  app_fissati    numeric,
  show_up        numeric,
  trial          numeric,
  clienti_chiusi numeric,
  fatturato      numeric,                        -- fatturato generato nel mese
  incasso        numeric,                        -- di cui incassato subito
  agg_at         timestamptz not null default now()
);

alter table public.fin_mkt_mese enable row level security;

drop policy if exists finance_all on public.fin_mkt_mese;
create policy finance_all on public.fin_mkt_mese
  for all using ((select ms_puo('finance'))) with check ((select ms_puo('finance')));

grant select, insert, update, delete on public.fin_mkt_mese to authenticated;
