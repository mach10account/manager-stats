-- Sauron · tab Marketing (porting della pagina Marketing del CFO Cockpit)
--
-- fin_marketing = specchio del tracker "KPI MARKETING & VENDITE 2026" del foglio
-- KPI ALL 3 (1 riga = 1 mese). Lo scrive n8n (WF-M9, service_role); l'app lo
-- legge e basta: e' il dato UFFICIALE dei mesi chiusi + il budget ADV di ogni mese
-- (unico numero che nessun'altra fonte in Supabase conosce).
-- fin_vendita = i numeri di Referral/Rinnovi/Upsell che nessuna fonte automatica
-- conosce (n. call, rinnovi 90/180/360): si scrivono dall'app, come fin_costi.

create table if not exists public.fin_marketing (
  mese             text primary key check (mese ~ '^\d{4}-\d{2}$'),
  budget_adv       numeric,
  lead             integer,
  app_fissati      integer,
  app_da_svolgere  integer,
  app_presentati   integer,
  chiusure         integer,
  ticket_medio     numeric,
  valore_contratti numeric,
  cash_incassato   numeric,
  fonte            text default 'KPI ALL 3',
  synced_at        timestamptz default now()
);
comment on table public.fin_marketing is
  'Tracker KPI MARKETING & VENDITE 2026 (foglio KPI ALL 3), 1 riga = 1 mese. Sync n8n. Solo admin.';

create table if not exists public.fin_vendita (
  mese          text primary key check (mese ~ '^\d{4}-\d{2}$'),
  ref_n         integer,
  ref_contr     numeric,
  ref_incassato numeric,
  rin_call      integer,
  rin_chiusura  integer,
  rin_90        integer,
  rin_180       integer,
  rin_360       integer,
  up_call       integer,
  up_chiusure   integer,
  note          text,
  aggiornato_a  timestamptz default now()
);
comment on table public.fin_vendita is
  'KPI vendita inseriti a mano (referral, call di rinnovo/upsell): il resto arriva da GHL e Notion. Solo admin.';

alter table public.fin_marketing enable row level security;
alter table public.fin_vendita   enable row level security;

-- stesso schema di fin_incassi/fin_costi: 'finance' non ha ramo in ms_puo,
-- quindi passa solo chi ha 'admin'.
drop policy if exists authenticated_read on public.fin_marketing;
create policy authenticated_read on public.fin_marketing
  for select to authenticated using ((select public.ms_puo('finance')));

drop policy if exists finance_all on public.fin_vendita;
create policy finance_all on public.fin_vendita
  for all to authenticated
  using ((select public.ms_puo('finance')))
  with check ((select public.ms_puo('finance')));

grant select on public.fin_marketing to authenticated;
grant select, insert, update, delete on public.fin_vendita to authenticated;

-- Funnel mensile per il tab Marketing, in DUE convenzioni:
--
-- 1) per MESE DI CREAZIONE dell'opportunita' (lead/app_*/chiusure): e' la stessa
--    regola del foglio KPI ALL 3 (COUNTIFS per mese sulla tab OPPORTUNITIES) →
--    il mese in corso e' confrontabile con lo storico ufficiale.
-- 2) per MESE DI CAMBIO STAGE (colonne st_*): "cosa e' successo questo mese",
--    la stessa convenzione della sezione Vendita (api_set_funnel).
--
-- Diritti dell'invocante (come le altre api_*): legge v_set_opportunita e
-- v_set_chiamate, protette da ms_puo('vendita') → di fatto solo admin.
create or replace function public.api_fin_marketing_mesi()
returns table (
  mese text,
  lead integer, app_fissati integer, app_da_svolgere integer, app_presentati integer,
  chiusure integer, valore_chiusure numeric,
  chiamati integer, risposte integer,
  st_non_risposto integer, st_da_richiamare integer, st_scarti integer,
  st_app_fissati integer, st_app_da_svolgere integer, st_show integer, st_noshow integer,
  st_chiusure integer, st_contrattualizzato numeric, st_incassato numeric
)
language sql
stable
as $function$
with mesi as (
  select to_char(d, 'YYYY-MM') as mese
  from generate_series(date '2026-01-01',
                       date_trunc('month', (now() at time zone 'Europe/Rome'))::date,
                       interval '1 month') d
),
opp as (select * from public.v_set_opportunita),
crea as (
  select to_char(creata_a at time zone 'Europe/Rome', 'YYYY-MM') as mese,
         count(*)::int as lead,
         count(*) filter (where conta_appuntamento)::int as app_fissati,
         count(*) filter (where bucket = 'fissato' and status = 'open')::int as app_da_svolgere,
         count(*) filter (where conta_show)::int as app_presentati,
         count(*) filter (where bucket in ('chiuso_firmato','chiuso_pagato'))::int as chiusure,
         coalesce(sum(valore) filter (where bucket in ('chiuso_firmato','chiuso_pagato')), 0) as valore_chiusure
  from opp group by 1
),
stg as (
  select to_char(cambio_stage_a at time zone 'Europe/Rome', 'YYYY-MM') as mese,
         count(*) filter (where bucket = 'non_risposto')::int as st_non_risposto,
         count(*) filter (where bucket = 'da_richiamare')::int as st_da_richiamare,
         count(*) filter (where bucket = 'scarto')::int as st_scarti,
         count(*) filter (where conta_appuntamento)::int as st_app_fissati,
         count(*) filter (where bucket = 'fissato' and status = 'open')::int as st_app_da_svolgere,
         count(*) filter (where conta_show)::int as st_show,
         count(*) filter (where bucket = 'noshow')::int as st_noshow,
         count(*) filter (where bucket in ('chiuso_firmato','chiuso_pagato'))::int as st_chiusure,
         coalesce(sum(valore) filter (where bucket in ('chiuso_firmato','chiuso_pagato')), 0) as st_contrattualizzato,
         coalesce(sum(valore) filter (where bucket = 'chiuso_pagato'), 0) as st_incassato
  from opp group by 1
),
ch as (
  select to_char(giorno, 'YYYY-MM') as mese,
         count(distinct ghl_contact_id)::int as chiamati,
         count(*) filter (where e_risposta)::int as risposte
  from public.v_set_chiamate group by 1
)
select m.mese,
       coalesce(c.lead, 0), coalesce(c.app_fissati, 0), coalesce(c.app_da_svolgere, 0),
       coalesce(c.app_presentati, 0), coalesce(c.chiusure, 0), coalesce(c.valore_chiusure, 0),
       coalesce(h.chiamati, 0), coalesce(h.risposte, 0),
       coalesce(s.st_non_risposto, 0), coalesce(s.st_da_richiamare, 0), coalesce(s.st_scarti, 0),
       coalesce(s.st_app_fissati, 0), coalesce(s.st_app_da_svolgere, 0), coalesce(s.st_show, 0),
       coalesce(s.st_noshow, 0), coalesce(s.st_chiusure, 0),
       coalesce(s.st_contrattualizzato, 0), coalesce(s.st_incassato, 0)
from mesi m
left join crea c on c.mese = m.mese
left join stg  s on s.mese = m.mese
left join ch   h on h.mese = m.mese
order by m.mese
$function$;

grant execute on function public.api_fin_marketing_mesi() to authenticated;

-- seed dal foglio al 2026-08-04 (poi ci pensa il sync n8n)
insert into public.fin_marketing (mese,budget_adv,lead,app_fissati,app_da_svolgere,app_presentati,chiusure,ticket_medio,valore_contratti,cash_incassato,fonte) values
 ('2026-01',5000,253,null,null,null,19,2500,47500,null,'KPI ALL 3 (seed)'),
 ('2026-02',11593,553,170,null,null,25,2500,62500,8625,'KPI ALL 3 (seed)'),
 ('2026-03',12200,400,196,null,88,26,2700,70200,6100,'KPI ALL 3 (seed)'),
 ('2026-04',12973,371,140,null,58,22,2509,55198,7083,'KPI ALL 3 (seed)'),
 ('2026-05',15396,473,106,null,47,15,3000,45000,null,'KPI ALL 3 (seed)'),
 ('2026-06',10300.93,227,59,6,40,12,3333,40000,13540,'KPI ALL 3 (seed)'),
 ('2026-07',9281.70,203,48,13,18,3,3400,10200,6700,'KPI ALL 3 (seed)'),
 ('2026-08',1327.57,27,1,1,0,0,0,0,0,'KPI ALL 3 (seed)')
on conflict (mese) do nothing;
