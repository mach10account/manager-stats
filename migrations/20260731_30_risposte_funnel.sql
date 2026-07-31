-- manager-stats · Migration 30 · "Risposte" nel funnel marketing
--
-- ⚠️ La definizione NON si inventa: e' la stessa della sezione **Beauty**
-- (vista `agg_coorte_centro_giorno`, modalita' "per data inserimento lead"):
--     count(*) filter (where coalesce(esiti.is_answered, false))
-- dove l'esito e' quello dell'ULTIMA chiamata CRM4 del lead. `esiti.is_answered`
-- e' gia' curata nel warehouse chiamate: unica fonte di verita', un solo posto
-- da correggere se cambia la classificazione.
--
-- Aggancio marketing → CRM4: `mkt_leads.crm4_lead_id` = `calls.campaign_contact_id`
-- (copertura 18.650/18.661 = 99,9% sui 90 gg).
--
-- Una prima versione derivava le risposte dall'ESITO Notion (mkt_esiti.is_risposta):
-- scartata su indicazione di Leo. La colonna e' stata rimossa per non lasciare in
-- giro un campo che sembra pilotare il funnel e invece non fa nulla.
--
-- Sui 90 gg al 31/07/2026: 11.097 risposte su 18.754 lead = 59,2%.

alter table public.mkt_esiti drop column if exists is_risposta;

-- ── viste: colonna risposte in coda (CREATE OR REPLACE ammette solo append) ──
create or replace view public.agg_mkt_ad_giorno with (security_invoker = on) as
with app_per_lead as (
  select lead_id,
         count(*)                                as n_app,
         bool_or(show_status = 'SHOW')           as has_show,
         bool_or(pacchetto = 'SI')               as has_vendita,
         sum(coalesce(ammontare_oggi, 0))        as ricavo,
         sum(case when pacchetto = 'SI' then coalesce(valore_pacchetto, 0) else 0 end) as potenziale
  from public.appuntamenti
  where lead_id is not null
  group by 1
)
select
  m.centro_id,
  (m.creazione at time zone 'Europe/Rome')::date as giorno,
  m.ad_account,
  m.campaign_id, max(m.campaign_name) as campaign_name,
  m.adset_id,    max(m.adset_name)    as adset_name,
  m.ad_id,       max(m.ad_name)       as ad_name,
  count(*)                                            as lead,
  count(*) filter (where ap.lead_id is not null)      as lead_con_appuntamento,
  coalesce(sum(ap.n_app), 0)                          as appuntamenti,
  count(*) filter (where ap.has_show)                 as presenze,
  count(*) filter (where ap.has_vendita)              as vendite,
  coalesce(sum(ap.ricavo), 0)                         as ricavo,
  coalesce(sum(ap.potenziale), 0)                     as potenziale,
  count(*) filter (where coalesce(es.is_answered, false)) as risposte
from public.mkt_leads m
left join app_per_lead ap on ap.lead_id = m.notion_id
left join lateral (
  select ca.deal_status_id from public.calls ca
  where ca.campaign_contact_id = m.crm4_lead_id
  order by ca.start_date desc limit 1
) uc on true
left join public.esiti es on es.deal_status_id = uc.deal_status_id
group by m.centro_id, 2, m.ad_account, m.campaign_id, m.adset_id, m.ad_id;

-- ⚠️ PERFORMANCE: il ramo "spesa FB senza lead" verificava l'assenza con
-- `not exists (select 1 from agg_mkt_ad_giorno ...)`, che costringe a
-- MATERIALIZZARE l'intera aggregazione (58k lead) anche quando la query filtra
-- un solo centro e un mese. Con la LATERAL su calls dentro la vista, quel ramo
-- passava da ~600ms a 2,3s. La condizione equivalente si esprime direttamente su
-- mkt_leads (stesso insieme di coppie ad_id×giorno) e usa mkt_leads_ad_idx.
-- Query del drill-down misurata: 2.296ms → 305ms.
create or replace view public.v_drilldown_ad with (security_invoker = on) as
select g.centro_id, g.giorno, g.ad_account, g.campaign_id, g.campaign_name,
       g.adset_id, g.adset_name, g.ad_id, g.ad_name,
       g.lead, g.lead_con_appuntamento, g.appuntamenti, g.presenze, g.vendite,
       g.ricavo, g.potenziale,
       f.spend, f.impressions, f.clicks, f.fb_leads,
       g.risposte
from public.agg_mkt_ad_giorno g
left join public.fb_insights_ad f on f.ad_id = g.ad_id and f.giorno = g.giorno
union all
select coalesce(a.centro_id, m.centro_id), f.giorno, f.ad_account_id, f.campaign_id, f.campaign_name,
       f.adset_id, f.adset_name, f.ad_id, f.ad_name,
       0::bigint, 0::bigint, 0::numeric, 0::bigint, 0::bigint,
       0::numeric, 0::numeric,
       f.spend, f.impressions, f.clicks, f.fb_leads,
       0::bigint
from public.fb_insights_ad f
left join public.fb_account_map m on m.ad_account_id = f.ad_account_id
left join public.fb_campaign_attr_giorno a
       on a.campaign_id = f.campaign_id and a.giorno = f.giorno
where not exists (select 1 from public.mkt_leads ml
                   where ml.ad_id = f.ad_id
                     and (ml.creazione at time zone 'Europe/Rome')::date = f.giorno)
  and (f.campaign_id is null
   or f.campaign_id not in (select campaign_id from public.fb_campaign_class where is_sv = false))
  and coalesce(a.centro_id, m.centro_id) is not null;

-- Verifica: WEIGHT INSTITUTE luglio = 73 lead → 54 risposte (74%) → 35 app
-- → 20 presenze → 11 vendite.
