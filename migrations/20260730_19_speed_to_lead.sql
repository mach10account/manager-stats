-- manager-stats · Sezione Vendita — speed to lead
--
-- Quanto passa fra l'ingresso del lead in pipeline e il PRIMO SQUILLO.
-- Ingresso = creazione dell'opportunità GHL (è il momento in cui il lead arriva sulla
-- scrivania del setter). Primo squillo = primo TYPE_CALL da set_chiamate_ghl, cioè il
-- dato oggettivo: non dipende dal fatto che il setter registri l'esito.
--
-- ⚠️ L'unità di misura è l'OPPORTUNITÀ, non il contatto. Misurando per contatto
-- cumulativo (min chiamata − min opportunità) veniva una mediana di 58 ore, perché
-- confrontava un ingresso di gennaio con una chiamata di luglio. Un titolare che
-- ricompila il form rientra in pipeline ed è un lead nuovo da lavorare: la finestra di
-- ricerca della prima chiamata si chiude quando nasce l'opportunità successiva dello
-- stesso contatto, così la chiamata non viene attribuita al lead sbagliato.
--
-- ⚠️ Il backfill delle chiamate GHL parte dal 2026-01-07: prima non c'è nulla con cui
-- confrontare. La vista parte dal 15 gennaio (margine) — le opportunità precedenti sono
-- ESCLUSE, non contate come "mai chiamate", che sarebbe falso.
--
-- ⚠️ "in attesa" vs "mai chiamato": senza la distinzione i lead entrati stamattina
-- inquinano il tasso di lead saltati. Sotto le 24 ore un lead non chiamato è normale.
--
-- Riferimento misurato il 2026-07-30 sugli ultimi 30 giorni: mediana ~17 ore,
-- 11% entro l'ora, 100 lead entrati da oltre 24h e mai squillati (35% degli entrati).

drop view if exists public.v_set_speed_to_lead;
create view public.v_set_speed_to_lead
with (security_invoker = on) as
with opp as (
  select o.id, o.ghl_contact_id, o.creata_a, o.followers,
         lead(o.creata_a) over (partition by o.ghl_contact_id order by o.creata_a) prossima_opp
  from public.set_opportunita o
  where o.ghl_contact_id is not null and o.creata_a >= '2026-01-15'
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
  coalesce(u.nome, p.primo_user_id)                as setter,   -- chi ha fatto il PRIMO squillo
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
  p.followers
from prima p
left join public.set_utenti_ghl u on u.user_id = p.primo_user_id;

revoke all on public.v_set_speed_to_lead from anon;
grant select on public.v_set_speed_to_lead to authenticated;

-- La vista eredita la RLS di set_opportunita e set_chiamate_ghl (area 'vendita'):
-- security_invoker = on, nessun grant aggiuntivo da dare.
