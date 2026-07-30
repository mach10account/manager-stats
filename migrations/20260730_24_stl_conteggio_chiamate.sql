-- 20260730_24: Elenco lead (card Speed to lead) — quante volte è stato chiamato ogni lead.
-- v_set_speed_to_lead: +n_chiamate (squilli composti nella STESSA finestra della prima
-- chiamata: dalla creazione dell'opportunità alla nascita dell'opportunità successiva
-- dello stesso contatto) e +fine_finestra (esposta così il client può chiedere il
-- dettaglio chiamate a v_set_chiamate_ghl con ESATTAMENTE gli stessi confini).
-- Colonne nuove APPESE in coda (vincolo di CREATE OR REPLACE VIEW).

create or replace view public.v_set_speed_to_lead with (security_invoker = on) as
with opp as (
  select o.id, o.ghl_contact_id, o.creata_a, o.followers, o.nome,
         lead(o.creata_a) over (partition by o.ghl_contact_id order by o.creata_a) as prossima_opp
  from public.set_opportunita o
  where o.ghl_contact_id is not null
    and o.creata_a >= '2026-01-15 00:00:00+00'::timestamptz
    and o.pipeline_id = 'nHTTgDtROCWErBW9DNOZ'
),
prima as (
  select o.id, o.ghl_contact_id, o.creata_a, o.followers, o.nome, o.prossima_opp,
         (select c.quando from public.set_chiamate_ghl c
           where c.ghl_contact_id = o.ghl_contact_id and c.quando >= o.creata_a
             and (o.prossima_opp is null or c.quando < o.prossima_opp)
           order by c.quando limit 1) as prima_chiamata_a,
         (select c.user_id from public.set_chiamate_ghl c
           where c.ghl_contact_id = o.ghl_contact_id and c.quando >= o.creata_a
             and (o.prossima_opp is null or c.quando < o.prossima_opp)
           order by c.quando limit 1) as primo_user_id,
         (select count(*) from public.set_chiamate_ghl c
           where c.ghl_contact_id = o.ghl_contact_id and c.quando >= o.creata_a
             and (o.prossima_opp is null or c.quando < o.prossima_opp)) as n_chiamate
  from opp o
)
select p.id as opportunita_id,
       p.ghl_contact_id,
       p.creata_a as entrata_a,
       (p.creata_a at time zone 'Europe/Rome')::date as giorno_entrata,
       p.prima_chiamata_a,
       (case when p.prima_chiamata_a is null then null::numeric
             else round(extract(epoch from p.prima_chiamata_a - p.creata_a) / 60.0)
        end)::integer as minuti,
       coalesce(u.nome, p.primo_user_id) as setter,
       p.prima_chiamata_a is null and p.creata_a > now() - interval '24 hours' as in_attesa,
       p.prima_chiamata_a is null and p.creata_a <= now() - interval '24 hours' as saltato,
       case
         when p.prima_chiamata_a is null and p.creata_a > now() - interval '24 hours' then 'in attesa'
         when p.prima_chiamata_a is null then 'mai chiamato'
         when p.prima_chiamata_a - p.creata_a <= interval '5 minutes'  then 'entro 5 min'
         when p.prima_chiamata_a - p.creata_a <= interval '30 minutes' then '5-30 min'
         when p.prima_chiamata_a - p.creata_a <= interval '1 hour'     then '30-60 min'
         when p.prima_chiamata_a - p.creata_a <= interval '4 hours'    then '1-4 ore'
         when p.prima_chiamata_a - p.creata_a <= interval '24 hours'   then '4-24 ore'
         when p.prima_chiamata_a - p.creata_a <= interval '3 days'     then '1-3 giorni'
         else 'oltre 3 giorni'
       end as fascia,
       p.followers,
       p.nome as lead,
       p.n_chiamate,
       p.prossima_opp as fine_finestra
from prima p
left join public.set_utenti_ghl u on u.user_id = p.primo_user_id;
