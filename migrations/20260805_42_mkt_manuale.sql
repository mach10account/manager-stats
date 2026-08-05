-- Sauron · tab Marketing rifatto sul prototipo "Cassetto Pieno" (Campagne Meta):
-- niente fonti automatiche, si scrive tutto a mano dalla dashboard.
--   fin_mkt_spesa    → 1 riga = 1 mese, s1..s5 = la spesa di ogni settimana
--   fin_mkt_contatti → 1 riga = 1 contatto generato dalle campagne in quel mese
-- I KPI della pagina (lead, costo per lead, appuntamenti) NON si salvano: si
-- ricalcolano da queste due tabelle, così non possono divergere da ciò che si vede.
-- RLS come fin_costi/fin_vendita: 'finance' non ha un ramo in ms_puo, quindi
-- passa solo chi è admin.

create table if not exists public.fin_mkt_spesa (
  mese   text primary key,                       -- 'YYYY-MM'
  s1     numeric,
  s2     numeric,
  s3     numeric,
  s4     numeric,
  s5     numeric,                                -- i mesi con cinque settimane
  agg_at timestamptz not null default now()
);

create table if not exists public.fin_mkt_contatti (
  id          uuid primary key default gen_random_uuid(),
  mese        text not null,                     -- 'YYYY-MM' del mese in cui è arrivato
  nome        text,
  telefono    text,
  data        date,
  trattamento text,
  esito       text not null default 'Da contattare',
  note        text,
  creato_at   timestamptz not null default now(),
  agg_at      timestamptz not null default now()
);
create index if not exists fin_mkt_contatti_mese_idx on public.fin_mkt_contatti (mese);

alter table public.fin_mkt_spesa    enable row level security;
alter table public.fin_mkt_contatti enable row level security;

drop policy if exists finance_all on public.fin_mkt_spesa;
create policy finance_all on public.fin_mkt_spesa
  for all using ((select ms_puo('finance'))) with check ((select ms_puo('finance')));

drop policy if exists finance_all on public.fin_mkt_contatti;
create policy finance_all on public.fin_mkt_contatti
  for all using ((select ms_puo('finance'))) with check ((select ms_puo('finance')));

grant select, insert, update, delete on public.fin_mkt_spesa    to authenticated;
grant select, insert, update, delete on public.fin_mkt_contatti to authenticated;
