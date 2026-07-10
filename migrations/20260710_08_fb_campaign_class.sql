-- 2026-07-10 · Classificatore campagne [SV] — tabella curata + vista di lavoro + seed CRM.
-- La nomenclatura delle CAMPAGNE non è affidabile; la definizione vera di [SV] è il nome del MODULO lead
-- (è ciò che gated l'ingestione nel CRM). Design Leo: appena una campagna nuova spende, si controlla se uno
-- dei suoi ad usa un modulo con [SV] nel nome → se sì, la campagna è "nostra" e i suoi dati contano tutti.
--
-- source:
--   'crm'     = seed automatico: la campagna ha ≥1 lead in mkt_leads → [SV] per definizione (zero chiamate FB,
--               robusto anche con ad/creative cancellati; ~metà delle campagne classificate gratis).
--   'form'    = WF-M6 ha risolto ad→modulo via FB: is_sv = il nome modulo contiene [SV].
--   'no_form' = nessun modulo lead trovato negli ad campionati (retargeting/brand/traffico) → is_sv=false.
--   'manual'  = override a mano dal Table Editor (WF-M6 usa ignore-duplicates: mai sovrascritto).
-- La vista v_panoramica_centro (migration 09) ESCLUDE le campagne is_sv=false; le non-ancora-classificate
-- contano (come oggi) e si auto-correggono retroattivamente alla classificazione (filtro a query-time).

create table public.fb_campaign_class (
  campaign_id   text primary key,
  is_sv         boolean not null,
  source        text not null check (source in ('crm','form','no_form','manual')),
  form_name     text,          -- il modulo [SV] trovato (o un esempio di modulo non-SV)
  campaign_name text,          -- denormalizzato per leggibilità nel Table Editor
  note          text,
  classified_at timestamptz not null default now()
);
alter table public.fb_campaign_class enable row level security;
create policy authenticated_read on public.fb_campaign_class for select to authenticated using (true);
-- (grant select automatico via default privileges della migration 03)

-- Vista di lavoro per WF-M6: campagne presenti in fb_insights_ad non ancora classificate,
-- con un campione di max 12 ad_id da cui risolvere il modulo.
create view public.v_campagne_da_classificare with (security_invoker = on) as
select f.campaign_id,
       max(f.campaign_name) as campaign_name,
       (array_agg(distinct f.ad_id))[1:12] as ad_ids
from public.fb_insights_ad f
where f.campaign_id is not null
  and not exists (select 1 from public.fb_campaign_class c where c.campaign_id = f.campaign_id)
group by f.campaign_id;

-- Seed: campagne con ≥1 lead nel CRM = [SV] per definizione (i loro lead sono passati dal modulo [SV]).
insert into public.fb_campaign_class (campaign_id, is_sv, source, campaign_name, note)
select c.campaign_id, true, 'crm', n.campaign_name, 'auto: ha lead nel CRM'
from (select distinct campaign_id from public.mkt_leads where campaign_id is not null) c
left join (
  select campaign_id, max(campaign_name) as campaign_name
  from public.fb_insights_ad
  where campaign_id is not null
  group by 1
) n on n.campaign_id = c.campaign_id
on conflict (campaign_id) do nothing;
