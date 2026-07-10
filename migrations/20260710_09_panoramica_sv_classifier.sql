-- 2026-07-10 · v_panoramica_centro: spesa+impression+lead_fb filtrati col classificatore campagne [SV].
-- Sostituisce il proxy per-ad della migration 07 (lead_fb = ad presenti in mkt_leads) con fb_campaign_class:
-- una campagna è [SV] se un suo ad usa un modulo lead con [SV] nel nome (o ha lead nel CRM — seed 'crm').
-- REGOLA: si ESCLUDONO solo le campagne classificate is_sv=false. Le non-ancora-classificate CONTANO
-- (comportamento identico a prima della classificazione) e si auto-correggono retroattivamente appena
-- WF-M6 (daily 05:00) le classifica: il filtro è a query-time, niente riscritture di dati.
-- Numeratore (spesa) e denominatore (lead_fb) del CPL hanno ora lo STESSO perimetro.
-- Fallback perf_giorno per account Forbidden/condivisi invariato (account-level, include tutto: limite noto).
-- Firma 23 colonne INVARIATA → frontend non toccato.
--
-- ROLLBACK: ri-applicare il corpo della migration 20260710_07 (proxy per-ad su mkt_leads, spesa non filtrata).

create or replace view public.v_panoramica_centro with (security_invoker = on) as
with covered as (
  -- account "coperti da FB" = mappati UNIVOCAMENTE a un centro E con dati reali in fb_insights_ad
  select m.ad_account_id
  from public.fb_account_map m
  where m.centro_id is not null
    and exists (select 1 from public.fb_insights_ad f where f.ad_account_id = m.ad_account_id)
),
escluse as (
  -- campagne NON nostre (modulo senza [SV] / nessun modulo / override manuale)
  select campaign_id from public.fb_campaign_class where is_sv = false
),
fb_centro as (
  -- spesa + impression + lead FB delle campagne [SV] (o non ancora classificate), account coperti
  select m.centro_id, f.giorno,
         sum(coalesce(f.spend, 0))       as spesa,
         sum(coalesce(f.impressions, 0)) as impression,
         sum(coalesce(f.fb_leads, 0))    as lead_fb
  from public.fb_insights_ad f
  join public.fb_account_map m on m.ad_account_id = f.ad_account_id and m.centro_id is not null
  where f.campaign_id is null
     or f.campaign_id not in (select campaign_id from escluse)
  group by 1, 2
),
perf_fallback as (
  -- account non coperti (13 Forbidden + condivisi/ambigui): dal mirror Notion (già solo-[SV] per i lead)
  select p.centro_id, p.giorno,
         sum(coalesce(p.spesa_ads, 0))  as spesa,
         sum(coalesce(p.impression, 0)) as impression,
         sum(coalesce(p.lead_fb, 0))    as lead_fb
  from public.perf_giorno p
  left join public.centri c on c.notion_id = p.centro_id
  where c.fb_ad_account_id is null
     or c.fb_ad_account_id not in (select ad_account_id from covered)
  group by 1, 2
),
merged as (
  select centro_id, giorno,
         sum(spesa)      as spesa,
         sum(impression) as impression,
         sum(lead_fb)    as lead_fb
  from (
    select * from fb_centro
    union all
    select * from perf_fallback
  ) u
  group by 1, 2
)
select
  centro_id, giorno,
  c.nome as centro, c.consulente, c.stato_attivita,
  coalesce(s.spesa, 0)::numeric             as spesa,
  coalesce(s.impression, 0)::numeric        as impression,
  coalesce(s.lead_fb, 0)::bigint            as lead_fb,
  coalesce(w.lead_reali, 0)                 as lead_reali,
  coalesce(w.appuntamenti_presi, 0)         as appuntamenti,
  coalesce(w.presenze, 0)                   as presenze,
  coalesce(w.no_show, 0)                    as non_presentati,
  coalesce(w.pacchetti, 0)                  as pacchetti,
  coalesce(w.ricavo, 0)                     as ricavo,
  coalesce(w.potenziale, 0)                 as potenziale,
  coalesce(w.lead_reali, 0)                 as wh_lead_reali,
  coalesce(w.appuntamenti_presi, 0)         as wh_appuntamenti_presi,
  coalesce(w.appuntamenti_svolti, 0)        as wh_appuntamenti_svolti,
  coalesce(w.presenze, 0)                   as wh_presenze,
  coalesce(w.no_show, 0)                    as wh_no_show,
  coalesce(w.pacchetti, 0)                  as wh_pacchetti,
  coalesce(w.ricavo, 0)                     as wh_ricavo,
  coalesce(w.potenziale, 0)                 as wh_potenziale
from merged s
full join public.agg_mkt_centro_giorno w using (centro_id, giorno)
left join public.centri c on c.notion_id = centro_id;
