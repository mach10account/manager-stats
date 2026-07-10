-- 2026-07-10 · Panoramica → warehouse. La sezione Panoramica smette di copiare il riassunto
-- notturno di Notion (perf_giorno) e calcola dai dati grezzi. Firma della vista INVARIATA
-- (23 colonne, stessi tipi) → frontend non toccato.
--
-- Fonti nuove:
--   spesa/impression ← fb_insights_ad via fb_account_map (spesa reale, più completa del foglio:
--     recupera i centri che O8F perdeva per id sbagliato/dedup/zeri fail-open — es. famiglia Skin Medic).
--     FALLBACK perf_giorno per i centri il cui account non è MAI comparso in fb_insights_ad:
--     13 account rispondono 403 a TUTTI i token (revoca lato cliente, date diverse apr→lug 2026;
--     anche O8F ci scrive zeri fail-open da allora) → la loro spesa storica esiste SOLO nel mirror
--     Notion. Se FB riapre l'accesso, l'account entra in `covered` e la vista si auto-corregge.
--   lead_fb ← perf_giorno (definizione "Numero Lead Facebook" del foglio, denominatore del CPL noto).
--     NON da fb_insights_ad: la col fb_leads somma 4 action_type che si SOVRAPPONGONO (lead +
--     onsite_conversion.lead_grouped + leadgen_grouped) → doppio/triplo conteggio (59k vs 22k reali,
--     verificato apr→lug 2026). Da spostare su FB solo dopo aver corretto il conteggio a monte (WF-M5).
--   lead_reali ← conteggio VIVO da mkt_leads (via agg_mkt_centro_giorno) — niente più snapshot 01:00.
--   appuntamenti ← appuntamenti_presi (per DATA PRESA, gated ESITO classe 'appuntamento' — migration 04).
--     Verifica bucketing vs perf (apr/mag/giu): gated-presa -9%/-3%/+5%, gated-svolto -31%/+5%/+6%,
--     raw-presa +16%/+38%/+52% → presa gated è il match giusto di TOTALE APPUNTAMENTI.
--   presenze/no_show/pacchetti/ricavo/potenziale ← agg_mkt_centro_giorno (per data_appuntamento, gated).
--
-- ROLLBACK: ri-eseguire il CREATE OR REPLACE con il corpo di v_panoramica_centro_parity
-- (= corpo vecchio, congelato qui sotto; originale in 20260708_01_mkt_warehouse.sql:239).

create view public.v_panoramica_centro_parity with (security_invoker = on) as
select
  centro_id, giorno,
  c.nome as centro, c.consulente, c.stato_attivita,
  coalesce(s.spesa, 0)               as spesa,
  coalesce(s.impression, 0)          as impression,
  coalesce(s.lead_fb, 0)             as lead_fb,
  coalesce(s.lead_reali_perf, 0)     as lead_reali,
  coalesce(s.appuntamenti_perf, 0)   as appuntamenti,
  coalesce(s.presenze_perf, 0)       as presenze,
  coalesce(s.non_presentati_perf, 0) as non_presentati,
  coalesce(s.pacchetti_perf, 0)      as pacchetti,
  coalesce(s.ricavo_perf, 0)         as ricavo,
  coalesce(s.potenziale_perf, 0)     as potenziale,
  coalesce(w.lead_reali, 0)          as wh_lead_reali,
  coalesce(w.appuntamenti_presi, 0)  as wh_appuntamenti_presi,
  coalesce(w.appuntamenti_svolti, 0) as wh_appuntamenti_svolti,
  coalesce(w.presenze, 0)            as wh_presenze,
  coalesce(w.no_show, 0)             as wh_no_show,
  coalesce(w.pacchetti, 0)           as wh_pacchetti,
  coalesce(w.ricavo, 0)              as wh_ricavo,
  coalesce(w.potenziale, 0)          as wh_potenziale
from public.agg_spend_centro_giorno s
full join public.agg_mkt_centro_giorno w using (centro_id, giorno)
left join public.centri c on c.notion_id = centro_id;

create or replace view public.v_panoramica_centro with (security_invoker = on) as
with covered as (
  -- account "coperti da FB" = (a) mappati UNIVOCAMENTE a un centro E (b) con dati reali in fb_insights_ad.
  -- Esclude: condivisi/ambigui (centro_id NULL, il foglio li ripartisce meglio) e i 13 Forbidden
  -- (mappati ma SENZA righe FB → altrimenti cadrebbero nel buco: né FB né fallback). Tutti costoro → perf.
  select m.ad_account_id
  from public.fb_account_map m
  where m.centro_id is not null
    and exists (select 1 from public.fb_insights_ad f where f.ad_account_id = m.ad_account_id)
),
fb_centro as (
  -- spesa reale FB ad-level, solo per account attribuiti a UN centro (no doppio conteggio coi condivisi)
  select m.centro_id, f.giorno,
         sum(coalesce(f.spend, 0))       as spesa,
         sum(coalesce(f.impressions, 0)) as impression
  from public.fb_insights_ad f
  join public.fb_account_map m on m.ad_account_id = f.ad_account_id and m.centro_id is not null
  group by 1, 2
),
perf_fallback as (
  -- centri il cui account non è coperto da FB (13 Forbidden + account condivisi/ambigui):
  -- spesa dal mirror Notion (che per i condivisi è più preciso di FB, la ripartisce per centro)
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
  from (
    select * from fb_centro
    union all
    select * from perf_fallback
  ) u
  group by 1, 2
),
leadfb as (
  -- Lead FB = definizione foglio (perf_giorno), NON la somma FB (double-count). Vale per tutti i centri.
  select centro_id, giorno, sum(coalesce(lead_fb, 0)) as lead_fb
  from public.perf_giorno
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
