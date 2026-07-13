-- 20260713_11 · "Lead gestiti" = lead UNICI nel periodo (vista 📞 Per data chiamata)
-- Prima la dashboard sommava i lead_lavorati giornalieri (distinct PER GIORNO) → un lead
-- richiamato in N giorni diversi contava N volte. Questa RPC conta DISTINCT lead_id
-- sull'intera finestra, stesso perimetro delle viste agg_*: esito_class <> 'automation'.
-- Righe: dim='setter' (per operator_id), dim='centro' (per campaign_id), dim='totale' (id null).
-- Applicata su Supabase come migration `lead_unici_rpc` (2026-07-13).
create or replace function public.api_lead_unici(p_from date, p_to date)
returns table(dim text, id bigint, lead_unici bigint)
language sql
stable
set search_path = public
as $$
  select 'setter'::text as dim, v.operator_id::bigint as id, count(distinct v.lead_id)::bigint as lead_unici
    from v_calls v
   where v.giorno between p_from and p_to and v.esito_class <> 'automation'
   group by v.operator_id
  union all
  select 'centro', v.campaign_id::bigint, count(distinct v.lead_id)::bigint
    from v_calls v
   where v.giorno between p_from and p_to and v.esito_class <> 'automation'
   group by v.campaign_id
  union all
  select 'totale', null::bigint, count(distinct v.lead_id)::bigint
    from v_calls v
   where v.giorno between p_from and p_to and v.esito_class <> 'automation';
$$;

revoke all on function public.api_lead_unici(date, date) from public;
revoke all on function public.api_lead_unici(date, date) from anon;
grant execute on function public.api_lead_unici(date, date) to authenticated;
grant execute on function public.api_lead_unici(date, date) to service_role;
