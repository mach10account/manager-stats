-- 2026-08-05 · FIX regressione · "Appuntamento fissato" nel drill-down Marketing torna a
-- contare SOLO dall'ESITO del lead (regola della migration 04 del 9/7).
--
-- Cosa era successo: la migration 30 (31/7, colonna "risposte") ha fatto CREATE OR REPLACE
-- di agg_mkt_ad_giorno partendo dal corpo della migration 01 (pre-gate) invece che dal corpo
-- vivo nel DB → il gate esiti è sparito e il drill-down contava come "appuntamento fissato"
-- qualsiasi lead con un record collegato in DATABASE APPUNTAMENTI (anche DISDETTO, attesa
-- acconto, non interessato). Coorti (mkt_lead_coorte) e riconciliazione (agg_mkt_centro_giorno)
-- non erano regredite.
--
-- Regola ripristinata, identica a Coorti: conta mkt_esiti.class = 'appuntamento', cioè
-- "Appuntamento confermato", "ACCONTO PAGATO" + 2 varianti booking rare. Il set è curato in
-- public.mkt_esiti: un solo posto da toccare se cambia la classificazione.
-- lead (denominatore CPL) = TUTTI i lead dell'ad; lead_con_appuntamento/appuntamenti/presenze/
-- vendite/ricavo/potenziale gated sull'esito; risposte (ultima chiamata CRM4) invariata.
--
-- ⚠️ LEZIONE: quando si fa CREATE OR REPLACE di una vista del warehouse, partire SEMPRE da
-- pg_get_viewdef() del DB, mai dal file di una vecchia migration.

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
  count(*)                                                            as lead,
  count(*) filter (where e.class = 'appuntamento')                    as lead_con_appuntamento,
  coalesce(sum(ap.n_app) filter (where e.class = 'appuntamento'), 0)  as appuntamenti,
  count(*) filter (where e.class = 'appuntamento' and ap.has_show)    as presenze,
  count(*) filter (where e.class = 'appuntamento' and ap.has_vendita) as vendite,
  coalesce(sum(ap.ricavo)     filter (where e.class = 'appuntamento'), 0) as ricavo,
  coalesce(sum(ap.potenziale) filter (where e.class = 'appuntamento'), 0) as potenziale,
  count(*) filter (where coalesce(es.is_answered, false)) as risposte
from public.mkt_leads m
left join app_per_lead ap on ap.lead_id = m.notion_id
left join public.mkt_esiti e on e.esito = m.esito
left join lateral (
  select ca.deal_status_id from public.calls ca
  where ca.campaign_contact_id = m.crm4_lead_id
  order by ca.start_date desc limit 1
) uc on true
left join public.esiti es on es.deal_status_id = uc.deal_status_id
group by m.centro_id, 2, m.ad_account, m.campaign_id, m.adset_id, m.ad_id;
