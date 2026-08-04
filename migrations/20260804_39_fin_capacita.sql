-- Capienza per persona, per ruolo delivery (project manager, beauty specialist,
-- media buyer). Scrivibile dalla sezione Sauron come fin_costi: e' un parametro
-- di direzione, non un dato che arriva da Notion.
-- Sostituisce il vecchio 35 fisso hardcoded in js/sections/sauron.js.
create table if not exists public.fin_capacita (
  ruolo      text    not null check (ruolo in ('PM','BEAUTY','MEDIA_BUYER')),
  nome       text    not null,
  capacita   integer not null check (capacita >= 0 and capacita <= 1000),
  updated_at timestamptz not null default now(),
  primary key (ruolo, nome)
);

alter table public.fin_capacita enable row level security;

drop policy if exists finance_all on public.fin_capacita;
create policy finance_all on public.fin_capacita for all
  using ((select ms_puo('finance'))) with check ((select ms_puo('finance')));

grant select, insert, update, delete on public.fin_capacita to authenticated;
