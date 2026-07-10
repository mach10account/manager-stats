-- manager-stats · mapping curato ad account FB → centro (pattern centro_map/mkt_esiti: editabile da Table Editor).
-- Priorità seed: majority-vote lead ≥90% → anagrafica centri se univoca → NULL (nota per revisione).
-- Seed 2026-07-10: 273 account, 269 mappati (135 da lead, 134 da anagrafica), 4 CONDIVISI a NULL
-- (di cui pesano: SKIN MEDIC RHO|SARONNO €4.3k, Diamond|NATUR BELLE x2 €1.7k — da assegnare a mano).
create table public.fb_account_map (
  ad_account_id text primary key,
  centro_id     uuid references public.centri(notion_id),
  note          text
);
alter table public.fb_account_map enable row level security;
create policy authenticated_read on public.fb_account_map for select to authenticated using (true);

with lead_votes as (
  select ad_account, centro_id, count(*) as n
  from public.mkt_leads
  where ad_account is not null and centro_id is not null
  group by 1, 2
),
lead_winner as (
  select distinct on (ad_account)
         ad_account, centro_id, n,
         n::numeric / sum(n) over (partition by ad_account) as share
  from lead_votes
  order by ad_account, n desc
),
centri_acc as (
  select fb_ad_account_id as ad_account_id,
         (array_agg(notion_id))[1] as centro_id,
         count(*) as n_centri
  from public.centri
  where fb_ad_account_id is not null
  group by 1
),
all_accounts as (
  select fb_ad_account_id as ad_account_id from public.centri where fb_ad_account_id is not null
  union
  select ad_account_id from public.fb_insights_ad where ad_account_id is not null
  union
  select ad_account from public.mkt_leads where ad_account is not null
)
insert into public.fb_account_map (ad_account_id, centro_id, note)
select a.ad_account_id,
       case
         when lw.share >= 0.9 then lw.centro_id
         when ca.n_centri = 1 then ca.centro_id
         else null
       end,
       case
         when lw.share >= 0.9 then 'auto: lead majority ' || round(lw.share * 100) || '%'
         when ca.n_centri = 1 then 'auto: unico centro con questo account'
         when ca.n_centri > 1 then 'CONDIVISO tra ' || ca.n_centri || ' centri - verificare'
         when lw.ad_account is not null then 'AMBIGUO: lead majority ' || round(lw.share * 100) || '% - verificare'
         else 'account senza centro in anagrafica'
       end
from all_accounts a
left join lead_winner lw on lw.ad_account = a.ad_account_id
left join centri_acc  ca on ca.ad_account_id = a.ad_account_id;
