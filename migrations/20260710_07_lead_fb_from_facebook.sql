-- 2026-07-10 · "Lead FB" della Panoramica passa da perf_giorno (foglio) a Facebook ad-level,
-- ma FILTRATO SOLO SUI LEAD [SV] (moduli Salone Vincente), NON il raw fb_leads.
--
-- PERCHÉ IL FILTRO: il raw fb_insights_ad.fb_leads (action_type 'lead', corretto in WF-M5) conta i lead di
-- TUTTI i moduli dell'account, inclusi hiring/selezioni (moduli non-[SV]). Il foglio conta solo i moduli con
-- [SV] nel nome. Verifica apr→lug 2026: raw FB coperti = 28.530, di cui ~7.600 su ad che NON generano alcun
-- lead nel CRM = non-[SV]. La parte [SV] (ad presenti in mkt_leads) = 20.916 ≈ perf 22.496 ≈ CRM 22.383.
--
-- DEFINIZIONE [SV] (proxy via CRM): un ad è [SV] se compare in public.mkt_leads (ha generato ≥1 lead nel CRM
-- Salone Vincente). I lead hiring non entrano in mkt_leads → i loro ad restano esclusi. Limite noto: un ad [SV]
-- con 0 atterraggi storici verrebbe escluso (raro), e un eventuale lead hiring mal-attribuito includerebbe il suo ad.
-- Filtro applicato SOLO al conteggio lead; spesa/impression restano su TUTTI gli ad (come mig.06) → nota: il CPL
-- eredita la spesa hiring (invariato vs oggi; per un CPL [SV] pulito filtrare anche la spesa — follow-up).
--
-- Verifica del risultato di questa vista (apr→lug): lead_fb totale = 22.357 (FB-[SV] coperti 20.916 + fallback
-- perf 1.441) vs perf attuale 22.496 = differenza 0,6%. Firma 23 colonne INVARIATA → frontend non toccato.
--
-- ROLLBACK: ri-applicare il corpo v_panoramica_centro della migration 20260710_06 (lead_fb da perf_giorno).

create or replace view public.v_panoramica_centro with (security_invoker = on) as
with covered as (
  -- account "coperti da FB" = mappati UNIVOCAMENTE a un centro E con dati reali in fb_insights_ad.
  select m.ad_account_id
  from public.fb_account_map m
  where m.centro_id is not null
    and exists (select 1 from public.fb_insights_ad f where f.ad_account_id = m.ad_account_id)
),
sv_ads as (
  -- ad [SV] = ad che hanno generato almeno un lead nel CRM (mkt_leads = leads Salone Vincente)
  select distinct ad_id from public.mkt_leads where ad_id is not null
),
fb_centro as (
  -- SPESA + impression: TUTTI gli ad degli account coperti (come mig.06)
  select m.centro_id, f.giorno,
         sum(coalesce(f.spend, 0))       as spesa,
         sum(coalesce(f.impressions, 0)) as impression
  from public.fb_insights_ad f
  join public.fb_account_map m on m.ad_account_id = f.ad_account_id and m.centro_id is not null
  group by 1, 2
),
perf_spend_fallback as (
  -- spesa/impression fallback (Forbidden + condivisi) dal mirror Notion
  select p.centro_id, p.giorno,
         sum(coalesce(p.spesa_ads, 0))  as spesa,
         sum(coalesce(p.impression, 0)) as impression
  from public.perf_giorno p
  left join public.centri c on c.notion_id = p.centro_id
  where c.fb_ad_account_id is null
     or c.fb_ad_account_id not in (select ad_account_id from covered)
  group by 1, 2
),
spend as (
  select centro_id, giorno, sum(spesa) as spesa, sum(impression) as impression
  from (select * from fb_centro union all select * from perf_spend_fallback) u
  group by 1, 2
),
fb_leadfb_sv as (
  -- LEAD: solo ad [SV] (in mkt_leads), account coperti
  select m.centro_id, f.giorno,
         sum(coalesce(f.fb_leads, 0)) as lead_fb
  from public.fb_insights_ad f
  join public.fb_account_map m on m.ad_account_id = f.ad_account_id and m.centro_id is not null
  where f.ad_id in (select ad_id from sv_ads)
  group by 1, 2
),
perf_leadfb_fallback as (
  -- LEAD fallback: perf (già [SV]) per Forbidden + condivisi
  select p.centro_id, p.giorno,
         sum(coalesce(p.lead_fb, 0)) as lead_fb
  from public.perf_giorno p
  left join public.centri c on c.notion_id = p.centro_id
  where c.fb_ad_account_id is null
     or c.fb_ad_account_id not in (select ad_account_id from covered)
  group by 1, 2
),
leadfb as (
  select centro_id, giorno, sum(lead_fb) as lead_fb
  from (select * from fb_leadfb_sv union all select * from perf_leadfb_fallback) u
  group by 1, 2
)
select
  centro_id, giorno,
  c.nome as centro, c.consulente, c.stato_attivita,
  coalesce(s.spesa, 0)::numeric             as spesa,
  coalesce(s.impression, 0)::numeric        as impression,
  coalesce(lf.lead_fb, 0)::bigint           as lead_fb,
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
from spend s
full join public.agg_mkt_centro_giorno w using (centro_id, giorno)
full join leadfb lf using (centro_id, giorno)
left join public.centri c on c.notion_id = centro_id;
