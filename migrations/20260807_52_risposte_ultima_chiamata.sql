-- 2026-08-07 · PERFORMANCE · l'ultima chiamata CRM4 in agg_mkt_ad_giorno passa da un
-- LATERAL per-lead a un DISTINCT ON calcolato una volta sola, con indice covering.
--
-- Perché: la Panoramica moriva di "canceling statement due to statement timeout" (57014,
-- statement_timeout=15s del ruolo authenticated). Misurato sul DB vivo: l'aggregato di
-- v_panoramica_centro sul periodo costava ~11s, di cui ~8,5s solo nel CTE risp — il
-- LATERAL cercava l'ultima chiamata per OGNUNO dei ~59k lead della storia (59.214 sort
-- individuali su calls + un seq scan di esiti ripetuto ~49.792 volte). E la Panoramica
-- rifaceva tutto questo PER OGNI pagina da 1000 righe di fetchAll.
--
-- Fix in due pezzi:
--   1. indice covering: il DISTINCT ON legge l'ultima chiamata per contatto in una
--      index-only scan invece di saltellare sull'heap (188k probe → una passata).
--      calls_lead_idx sparisce: era il prefisso del nuovo indice, tenerlo sarebbe solo
--      doppio costo di scrittura sui sync orari GHL.
--   2. il join: stessa semantica ("risposta" = is_answered dell'ULTIMA chiamata del
--      contatto), calcolata una volta per tutti i contatti e agganciata per hash join.
--
-- ⚠️ Tie-break: a parità di start_date il LATERAL sceglieva una chiamata ARBITRARIA,
-- ora decide deal_id desc (deterministico). Verificato sul 09/07→07/08: totale risposte
-- IDENTICO (3.008), 2 centri si spostano di ±1 sulla chiamata pareggiata. Accettato.
--
-- Numeri di controllo pre-migration (da rifare identici dopo, tie-break a parte):
--   30gg (09/07→07/08): 2.301 righe · 5.416 lead · 870 app · 3.010 risposte · 48.831 €
--   storia intera:     18.735 righe · 59.221 lead · 4.727 app · 29.076 risposte · 353.455 €
--
-- ROLLBACK: ri-applicare il corpo della migration 48 (LATERAL) e, volendo,
--   create index calls_lead_idx on public.calls (campaign_contact_id);
--   drop index public.calls_contact_ultima_idx;

create index calls_contact_ultima_idx
  on public.calls (campaign_contact_id, start_date desc, deal_id desc)
  include (deal_status_id);

drop index public.calls_lead_idx;

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
left join (
  select distinct on (ca.campaign_contact_id) ca.campaign_contact_id, ca.deal_status_id
  from public.calls ca
  order by ca.campaign_contact_id, ca.start_date desc, ca.deal_id desc
) uc on uc.campaign_contact_id = m.crm4_lead_id
left join public.esiti es on es.deal_status_id = uc.deal_status_id
group by m.centro_id, 2, m.ad_account, m.campaign_id, m.adset_id, m.ad_id;
