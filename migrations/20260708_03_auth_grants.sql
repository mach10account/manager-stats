-- manager-stats · Fase 0 · modello di accesso
-- anon: NESSUN accesso (il vecchio flusso n8n usa la service key → non impattato).
-- authenticated: SELECT su tutto via policy permissiva (fase 1: tutti i manager vedono tutto).
-- Scoping futuro per-consulente: tabelle app_users/app_user_centri + modifica della sola policy.
-- Tutte le viste security_invoker=on → la RLS delle tabelle base si applica sempre.

-- A. blocca anon
revoke all on all tables    in schema public from anon;
revoke all on all functions in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;

-- B. tutte le viste esistenti e future esposte come invoker
do $$
declare v record;
begin
  for v in select table_name from information_schema.views where table_schema = 'public'
  loop
    execute format('alter view public.%I set (security_invoker = on)', v.table_name);
  end loop;
end $$;

-- C. lettura per gli utenti loggati
grant select on all tables in schema public to authenticated;
alter default privileges for role postgres in schema public grant select on tables to authenticated;

create policy authenticated_read on public.calls          for select to authenticated using (true);
create policy authenticated_read on public.leads          for select to authenticated using (true);
create policy authenticated_read on public.esiti          for select to authenticated using (true);
create policy authenticated_read on public.operators      for select to authenticated using (true);
create policy authenticated_read on public.campaigns      for select to authenticated using (true);
create policy authenticated_read on public.centri         for select to authenticated using (true);
create policy authenticated_read on public.mkt_leads      for select to authenticated using (true);
create policy authenticated_read on public.appuntamenti   for select to authenticated using (true);
create policy authenticated_read on public.perf_giorno    for select to authenticated using (true);
create policy authenticated_read on public.fb_insights_ad for select to authenticated using (true);
create policy authenticated_read on public.centro_map     for select to authenticated using (true);
create policy authenticated_read on public.mkt_esiti      for select to authenticated using (true);
