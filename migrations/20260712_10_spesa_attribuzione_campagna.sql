-- 2026-07-12 · Spesa attribuita PER CAMPAGNA (dai lead, giorno per giorno) + drill-down completo.
--
-- Bug riportato (Skin Medic Ostia): riga cliente €2.921,60 (30gg) ma drill-down campagne €223,91.
-- Cause verificate sui dati:
--   1. L'account 1558613442185093 è multi-cliente: campagne [SV] di 15 centri diversi (Di Bisceglie,
--      Naturalmente Tu, Vanity, ZeroPeli, …). fb_account_map lo attribuiva 1:1 a Ostia → tutta la
--      spesa dell'account sulla sua riga, gli altri 14 centri a €0.
--   2. v_drilldown_ad era lead-driven: spesa agganciata solo su (ad, giorno) con ≥1 lead CRM creato
--      quel giorno → i giorni di spesa senza lead sparivano dal dettaglio campagne.
--
-- Fix:
--   1. fb_campaign_lead_giorno: centro majority per (campagna, giorno) dai lead CRM (mkt_leads).
--   2. fb_campaign_attr_giorno: per OGNI giorno (lead o sola spesa) di ogni campagna il centro
--      attribuito: majority del giorno se il giorno ha lead, altrimenti il giorno-lead più VICINO
--      (a parità vince il passato). Granularità GIORNO e non mese perché le campagne vengono
--      ri-puntate su centri diversi anche a metà mese (es. FORMA PURA: 1-12 giu→ITALIAESTETICA,
--      dal 25 giu→Ostia). Tutto a window function (niente nested loop su mkt_leads).
--   3. v_panoramica_centro (firma 23 colonne INVARIATA): fb_centro attribuisce per riga
--      centro = attribuzione campagna del giorno → fallback fb_account_map. Il join alla mappa
--      diventa LEFT: anche gli account CONDIVISI lasciati a centro_id NULL (es. RHO|SARONNO)
--      vengono ora attribuiti per campagna invece di essere ignorati dal ramo FB.
--      perf_fallback: regola invariata + guardia NOT EXISTS per (centro, giorno) già coperto dal
--      ramo FB (anti doppio-conteggio per i centri che ora ricevono spesa attribuita e hanno anche
--      righe Notion).
--   4. v_drilldown_ad (firma 20 colonne INVARIATA): righe lead identiche a oggi + righe FB-only
--      (spesa senza lead quel giorno, lead=0) con la stessa attribuzione campagna→centro e la
--      stessa esclusione is_sv=false → il totale campagne torna col totale della riga cliente.
--
-- Perimetro confermato da Leo (2026-07-12): ogni campagna al suo centro; regola classificatore
-- attuale (si escludono SOLO le campagne is_sv=false, le non classificate contano).
--
-- Edge accettati:
--   · Campagne senza alcun lead CRM su account multi-cliente → restano sul centro dell'account
--     (es. ~€130 "SV MANI DI FATA GIUGNO"/"- Copia" su Ostia); si auto-correggono al primo lead.
--     Ora almeno VISIBILI nel drill-down con lead=0.
--   · Giorno con lead di più centri sulla stessa campagna: la panoramica segue la majority del
--     giorno, il drill-down il centro di ogni lead (scarto raro e piccolo).
--   · Centri solo-Notion (fallback perf_giorno): drill-down senza dettaglio campagne, invariato.
--
-- ROLLBACK: v_panoramica_centro → corpo migration 20260710_09; v_drilldown_ad → corpo
-- migration 20260708_01 (riga 298, LEFT JOIN semplice);
-- drop view fb_campaign_attr_giorno; drop view fb_campaign_lead_giorno;

-- ── 1. centro majority per (campagna, giorno) dai lead CRM ──────────────────
drop view if exists public.fb_campaign_attr_mese;      -- prima iterazione (mese): troppo grossa
drop view if exists public.fb_campaign_centro_mese;
drop view if exists public.fb_campaign_attr_giorno;
drop view if exists public.fb_campaign_lead_giorno;

create view public.fb_campaign_lead_giorno with (security_invoker = on) as
select campaign_id, giorno, centro_id, n
from (
  select campaign_id,
         (creazione at time zone 'Europe/Rome')::date as giorno,
         centro_id,
         count(*) as n,
         row_number() over (
           partition by campaign_id, ((creazione at time zone 'Europe/Rome')::date)
           order by count(*) desc, centro_id            -- tie-break deterministico
         ) as rn
  from public.mkt_leads
  where campaign_id is not null and centro_id is not null
  group by 1, 2, 3
) t
where rn = 1;

-- ── 2. attribuzione per (campagna, giorno): majority del giorno, poi il lead-day più vicino ──
create view public.fb_campaign_attr_giorno with (security_invoker = on) as
with giorni as (
  -- timeline per campagna: giorni con lead (centro valorizzato) ∪ giorni di sola spesa
  select l.campaign_id, l.giorno, l.centro_id
  from public.fb_campaign_lead_giorno l
  union all
  select s.campaign_id, s.giorno, null::uuid
  from (select distinct campaign_id, giorno
          from public.fb_insights_ad where campaign_id is not null) s
  where not exists (select 1 from public.fb_campaign_lead_giorno l
                     where l.campaign_id = s.campaign_id and l.giorno = s.giorno)
),
avanti as (  -- ultimo giorno-lead ≤ giorno (LOCF), via gruppi gaps-and-islands
  select campaign_id, giorno, centro_id,
         max(case when centro_id is not null then giorno end) over w as prev_giorno,
         count(centro_id) over w as grp_prev
  from giorni
  window w as (partition by campaign_id order by giorno
               rows between unbounded preceding and current row)
),
locf as (
  select campaign_id, giorno, centro_id, prev_giorno,
         first_value(centro_id) over (partition by campaign_id, grp_prev order by giorno) as prev_centro
  from avanti
),
indietro as (  -- primo giorno-lead ≥ giorno (NOCB), specchio del precedente
  select campaign_id, giorno, centro_id,
         min(case when centro_id is not null then giorno end) over w as next_giorno,
         count(centro_id) over w as grp_next
  from giorni
  window w as (partition by campaign_id order by giorno desc
               rows between unbounded preceding and current row)
),
nocb as (
  select campaign_id, giorno, next_giorno,
         first_value(centro_id) over (partition by campaign_id, grp_next order by giorno desc) as next_centro
  from indietro
)
select l.campaign_id, l.giorno,
       case
         when l.centro_id is not null                                   then l.centro_id   -- il giorno ha lead
         when l.prev_giorno is null                                     then n.next_centro -- spesa prima del 1° lead
         when n.next_giorno is null                                     then l.prev_centro -- spesa dopo l'ultimo lead
         when (l.giorno - l.prev_giorno) <= (n.next_giorno - l.giorno)  then l.prev_centro -- più vicino il passato
         else n.next_centro
       end as centro_id
from locf l
join nocb n using (campaign_id, giorno);

grant select on public.fb_campaign_lead_giorno to authenticated;
grant select on public.fb_campaign_attr_giorno to authenticated;

-- ── 3. v_panoramica_centro: spesa/impression/lead_fb attribuite per campagna ─
create or replace view public.v_panoramica_centro with (security_invoker = on) as
with covered as (
  -- account "coperti da FB" = mappati univocamente a un centro E con dati reali in fb_insights_ad
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
  -- spesa + impression + lead FB delle campagne [SV] (o non ancora classificate):
  -- centro = attribuzione per (campagna, giorno) dai lead, fallback mappa account.
  -- LEFT sulla mappa: recupera anche gli account condivisi lasciati a centro_id NULL.
  select coalesce(a.centro_id, m.centro_id) as centro_id, f.giorno,
         sum(coalesce(f.spend, 0))       as spesa,
         sum(coalesce(f.impressions, 0)) as impression,
         sum(coalesce(f.fb_leads, 0))    as lead_fb
  from public.fb_insights_ad f
  left join public.fb_account_map m on m.ad_account_id = f.ad_account_id
  left join public.fb_campaign_attr_giorno a
         on a.campaign_id = f.campaign_id and a.giorno = f.giorno
  where (f.campaign_id is null
     or f.campaign_id not in (select campaign_id from escluse))
    and coalesce(a.centro_id, m.centro_id) is not null
  group by 1, 2
),
perf_fallback as (
  -- account non coperti (13 Forbidden + condivisi/ambigui): dal mirror Notion (già solo-[SV] per i lead).
  -- Guardia NOT EXISTS: mai sommare Notion + FB sullo stesso (centro, giorno) ora che l'attribuzione
  -- per campagna può dare spesa FB anche a centri senza account coperto.
  select p.centro_id, p.giorno,
         sum(coalesce(p.spesa_ads, 0))  as spesa,
         sum(coalesce(p.impression, 0)) as impression,
         sum(coalesce(p.lead_fb, 0))    as lead_fb
  from public.perf_giorno p
  left join public.centri c on c.notion_id = p.centro_id
  where (c.fb_ad_account_id is null
     or c.fb_ad_account_id not in (select ad_account_id from covered))
    and not exists (select 1 from fb_centro fc
                     where fc.centro_id = p.centro_id and fc.giorno = p.giorno)
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

-- ── 4. v_drilldown_ad: righe lead (identiche a prima) + righe FB senza lead ──
create or replace view public.v_drilldown_ad with (security_invoker = on) as
select g.centro_id, g.giorno, g.ad_account, g.campaign_id, g.campaign_name,
       g.adset_id, g.adset_name, g.ad_id, g.ad_name,
       g.lead, g.lead_con_appuntamento, g.appuntamenti, g.presenze, g.vendite,
       g.ricavo, g.potenziale,
       f.spend, f.impressions, f.clicks, f.fb_leads
from public.agg_mkt_ad_giorno g
left join public.fb_insights_ad f on f.ad_id = g.ad_id and f.giorno = g.giorno
union all
-- giorni di spesa FB senza lead CRM: stessa attribuzione campagna→centro della panoramica,
-- stessa esclusione is_sv=false; lead=0 → nel drill-down la campagna appare con la spesa piena.
select coalesce(a.centro_id, m.centro_id), f.giorno, f.ad_account_id, f.campaign_id, f.campaign_name,
       f.adset_id, f.adset_name, f.ad_id, f.ad_name,
       0::bigint, 0::bigint, 0::numeric, 0::bigint, 0::bigint,
       0::numeric, 0::numeric,
       f.spend, f.impressions, f.clicks, f.fb_leads
from public.fb_insights_ad f
left join public.fb_account_map m on m.ad_account_id = f.ad_account_id
left join public.fb_campaign_attr_giorno a
       on a.campaign_id = f.campaign_id and a.giorno = f.giorno
where not exists (select 1 from public.agg_mkt_ad_giorno g
                   where g.ad_id = f.ad_id and g.giorno = f.giorno)
  and (f.campaign_id is null
   or f.campaign_id not in (select campaign_id from public.fb_campaign_class where is_sv = false))
  and coalesce(a.centro_id, m.centro_id) is not null;
