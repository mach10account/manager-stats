-- manager-stats · Sezione Vendita — istogramma tentativi + RPC contatti unici
-- (applicate dopo la 12, tenute separate perché nate dalla verifica del frontend)

-- Istogramma "quante chiamate servono per fissare": una riga per numero di tentativi.
-- Storico completo, non filtrato per periodo — come lead_call_distribution in Chiamate.
create or replace view public.set_tentativi_dist
with (security_invoker = on) as
select
  tentativi                            as n_chiamate,
  count(*)                             as n_contatti,
  count(*) filter (where fissato)      as n_fissati,
  count(*) filter (where risposte > 0) as n_con_risposta
from public.v_set_contatti
group by tentativi;

revoke all on public.set_tentativi_dist from anon;
grant select on public.set_tentativi_dist to authenticated;

-- Contatti UNICI nel periodo: sommare agg_set_setter_giorno.contatti sui giorni
-- gonfia il dato (stesso contatto richiamato in 3 giorni = 3). La riga con
-- setter NULL è il totale azienda (un contatto lavorato da 2 setter conta 1).
create or replace function public.api_set_contatti_unici(p_from date, p_to date)
returns table (setter text, contatti bigint, contatti_con_app bigint)
language sql
stable
security invoker
as $$
  select v.setter,
         count(distinct v.ghl_contact_id),
         count(distinct v.ghl_contact_id) filter (where v.e_appuntamento)
  from public.v_set_chiamate v
  where v.giorno >= p_from and v.giorno <= p_to
  group by grouping sets ((v.setter), ())
$$;

revoke all on function public.api_set_contatti_unici(date, date) from public, anon;
grant execute on function public.api_set_contatti_unici(date, date) to authenticated;
