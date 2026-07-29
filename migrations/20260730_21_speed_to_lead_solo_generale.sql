-- manager-stats · Speed to lead: contava lead che non erano lead
--
-- SINTOMO: il 29/07 la card diceva "25 lead entrati" ma erano 12 persone, con nomi
-- ripetuti fino a 4 volte (Laura Re ×3, Arianna ×4, Maria Rosaria ×4).
--
-- CAUSA: la vista prendeva le opportunità di ENTRAMBE le pipeline. Ma quelle della
-- PIPELINE VENDITA non sono lead in ingresso: sono appuntamenti GIÀ fissati che
-- passano al venditore. E lì le opportunità sono anche duplicate:
--   ultimi 30 giorni → GENERALE 179 opp / 178 persone = 1,01 per persona (pulito)
--                      VENDITA  106 opp /  42 persone = 2,52 per persona (duplicate)
-- Il 29/07: 7 righe GENERALE (i lead veri) + 18 righe VENDITA per sole 7 persone,
-- di cui 16 marcate "in attesa" perché nessuno le richiama — erano appuntamenti
-- già presi, non lead da chiamare.
--
-- EFFETTO SUI NUMERI GIÀ COMUNICATI: il "35% di lead mai chiamati" sui 30 giorni era
-- FALSO, gonfiato da queste righe. Il valore reale è 19 su 179 = 10,6%.
-- La mediana passa da ~17 ore a ~13h 16m.
--
-- FIX: filtro sulla sola PIPELINE GENERALE (nHTTgDtROCWErBW9DNOZ), dove il lead entra.
-- La duplicazione dentro VENDITA resta un problema lato GHL (un workflow che ricrea
-- l'opportunità) e va guardata lì: qui viene solo esclusa dal conteggio.
--
-- Aggiunta anche la colonna `lead` (nome) in coda: "chi sono questi lead" è la prima
-- domanda che ci si fa guardando il conteggio, e ora la card ne mostra l'elenco.

create or replace view public.v_set_speed_to_lead
with (security_invoker = on) as
with opp as (
  select o.id, o.ghl_contact_id, o.creata_a, o.followers, o.nome,
         lead(o.creata_a) over (partition by o.ghl_contact_id order by o.creata_a) prossima_opp
  from public.set_opportunita o
  where o.ghl_contact_id is not null
    and o.creata_a >= '2026-01-15'
    and o.pipeline_id = 'nHTTgDtROCWErBW9DNOZ'   -- PIPELINE GENERALE = ingresso lead
),
prima as (
  select o.*,
         (select c.quando from public.set_chiamate_ghl c
          where c.ghl_contact_id = o.ghl_contact_id and c.quando >= o.creata_a
            and (o.prossima_opp is null or c.quando < o.prossima_opp)
          order by c.quando limit 1) prima_chiamata_a,
         (select c.user_id from public.set_chiamate_ghl c
          where c.ghl_contact_id = o.ghl_contact_id and c.quando >= o.creata_a
            and (o.prossima_opp is null or c.quando < o.prossima_opp)
          order by c.quando limit 1) primo_user_id
  from opp o
)
select
  p.id                                             as opportunita_id,
  p.ghl_contact_id,
  p.creata_a                                       as entrata_a,
  ((p.creata_a at time zone 'Europe/Rome'))::date   as giorno_entrata,
  p.prima_chiamata_a,
  case when p.prima_chiamata_a is null then null
       else round(extract(epoch from (p.prima_chiamata_a - p.creata_a))/60.0) end::int as minuti,
  coalesce(u.nome, p.primo_user_id)                as setter,
  (p.prima_chiamata_a is null and p.creata_a >  now() - interval '24 hours') as in_attesa,
  (p.prima_chiamata_a is null and p.creata_a <= now() - interval '24 hours') as saltato,
  case
    when p.prima_chiamata_a is null and p.creata_a > now() - interval '24 hours' then 'in attesa'
    when p.prima_chiamata_a is null                                              then 'mai chiamato'
    when p.prima_chiamata_a - p.creata_a <= interval '5 minutes'                 then 'entro 5 min'
    when p.prima_chiamata_a - p.creata_a <= interval '30 minutes'                then '5-30 min'
    when p.prima_chiamata_a - p.creata_a <= interval '1 hour'                    then '30-60 min'
    when p.prima_chiamata_a - p.creata_a <= interval '4 hours'                   then '1-4 ore'
    when p.prima_chiamata_a - p.creata_a <= interval '24 hours'                  then '4-24 ore'
    when p.prima_chiamata_a - p.creata_a <= interval '3 days'                    then '1-3 giorni'
    else 'oltre 3 giorni'
  end                                              as fascia,
  p.followers,
  p.nome                                           as lead
from prima p
left join public.set_utenti_ghl u on u.user_id = p.primo_user_id;

-- ⚠️ DA GUARDARE: la stessa duplicazione gonfia anche "Appuntamenti da svolgere" e
-- "presentati" nel report nuovi/vecchi (api_set_funnel), che usa entrambe le pipeline
-- perché le chiusure stanno in VENDITA. Non corretto qui: va prima capito perché GHL
-- crea 2,5 opportunità per persona in quella pipeline.
