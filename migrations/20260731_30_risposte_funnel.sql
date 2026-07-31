-- manager-stats · Migration 30 · "Risposte" nel funnel marketing
--
-- Una risposta = il lead e' stato effettivamente raggiunto, a prescindere
-- dall'esito commerciale. In Notion non esiste un campo dedicato: si deriva
-- dall'ESITO, classificato in mkt_esiti come gia' si fa per is_appuntamento.
--
-- Default conservativo: i nuovi esiti nascono is_risposta = false (coerente con
-- class='unknown' + needs_review del sync), cosi' un esito sconosciuto non
-- gonfia il tasso. Leo puo' ribaltare qualsiasi riga dal Table Editor.
--
-- Sui 90 giorni al 31/07/2026: 11.057 risposte su 18.754 lead = 59,0%.

alter table public.mkt_esiti add column if not exists is_risposta boolean not null default false;
comment on column public.mkt_esiti.is_risposta is
  'true = l''esito implica che il lead ha risposto. Modificabile da Table Editor.';

-- non risposta: mai raggiunto, numero non valido, riga tecnica
update public.mkt_esiti set is_risposta = false where esito in (
  'Non risponde','Occupato','Segreteria da richiamare','Fax da richiamare',
  '1 RICHIAMO NO RISP','2 RICHIAMO NO RISP','3 RICHIAMO NO RISP','5 RICHIAMO STOP CALL',
  'DOPPIO SQUILLO Cellulare','DOPPIO SQUILLO Cellulare personale',
  'MAI RISPOSTO (Tentativi Misti)','Numero errato','Blacklist - Iscritto al FUB',
  'Fax da non contattare piu''','Segreteria da non contattare piu''',
  'Occupato da non contattare piu''','Ricontattabile','Errore','Lead da Api');

-- risposta: tutto il resto degli esiti censiti (appuntamenti, persi dopo
-- contatto, attese acconto, richiami concordati, presa in gestione dal centro)
update public.mkt_esiti set is_risposta = true where esito not in (
  'Non risponde','Occupato','Segreteria da richiamare','Fax da richiamare',
  '1 RICHIAMO NO RISP','2 RICHIAMO NO RISP','3 RICHIAMO NO RISP','5 RICHIAMO STOP CALL',
  'DOPPIO SQUILLO Cellulare','DOPPIO SQUILLO Cellulare personale',
  'MAI RISPOSTO (Tentativi Misti)','Numero errato','Blacklist - Iscritto al FUB',
  'Fax da non contattare piu''','Segreteria da non contattare piu''',
  'Occupato da non contattare piu''','Ricontattabile','Errore','Lead da Api');

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
  count(*) filter (where ap.has_vendita)               as vendite,
  coalesce(sum(ap.ricavo), 0)                         as ricavo,
  coalesce(sum(ap.potenziale), 0)                     as potenziale,
  count(*) filter (where e.is_risposta)                as risposte
from public.mkt_leads m
left join app_per_lead ap on ap.lead_id = m.notion_id
left join public.mkt_esiti e on e.esito = m.esito
group by m.centro_id, 2, m.ad_account, m.campaign_id, m.adset_id, m.ad_id;

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
where not exists (select 1 from public.agg_mkt_ad_giorno g
                   where g.ad_id = f.ad_id and g.giorno = f.giorno)
  and (f.campaign_id is null
   or f.campaign_id not in (select campaign_id from public.fb_campaign_class where is_sv = false))
  and coalesce(a.centro_id, m.centro_id) is not null;

-- Nota: 13 righe ad×giorno su ~migliaia hanno risposte < lead_con_appuntamento
-- (esito riscritto a "MAI RISPOSTO" su un lead che aveva gia' un appuntamento).
-- A livello di centro l'incoerenza si annulla; il funnel mostra i numeri reali.
