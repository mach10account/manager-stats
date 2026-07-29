-- manager-stats · Accessi per sezione
--
-- Prima: policy `authenticated_read ... using (true)` su tutte le 22 tabelle →
-- chiunque avesse un login Supabase vedeva TUTTA l'app.
--
-- ⚠️ Questo chiude anche una falla reale: lo stesso progetto Supabase ospita la
-- SV Academy (schema `academy`). I suoi membri sono utenti `authenticated` come gli
-- altri: con la chiave pubblica dell'app potevano interrogare v_calls (note operatore),
-- mkt_leads, set_opportunita (contratti e importi). Non essendo inseriti in ms_accessi,
-- da adesso non leggono più nulla di `public`. Lo schema `academy` non è toccato.
--
-- Perché POLICY e non REVOKE: un `permission denied` viene classificato da
-- isAuthError() (js/supabase.js) come sessione scaduta e manderebbe l'utente in loop
-- login → sezione negata → login. Con le policy non c'è errore: le righe non
-- consentite semplicemente non esistono per quell'utente.
--
-- Perché bastano le TABELLE BASE: tutte le 39 viste sono `security_invoker = on` e
-- tutte le RPC sono INVOKER → la RLS si propaga da sola a viste e funzioni.

create table if not exists public.ms_accessi (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text,
  sezioni      text[] not null default '{}',   -- panoramica|marketing|coorti|beauty|vendita|admin
  attivo       boolean not null default true,
  aggiornato_a timestamptz not null default now()
);
comment on table public.ms_accessi is
  'Sezioni di manager-stats visibili a ciascun utente. Chi non e qui dentro non vede nulla.';

-- Guardia unica usata da tutte le policy.
-- SECURITY DEFINER: legge ms_accessi senza innescare la RLS di ms_accessi stessa
-- (che a sua volta chiama ms_puo → ricorsione infinita).
create or replace function public.ms_puo(p_area text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ms_accessi a
    where a.user_id = auth.uid() and a.attivo and (
         a.sezioni @> array['admin']
      or (p_area = 'comune'  and coalesce(array_length(a.sezioni,1),0) > 0)
      or (p_area = 'mkt'     and a.sezioni && array['panoramica','marketing','coorti'])
      or (p_area = 'beauty'  and a.sezioni @> array['beauty'])
      or (p_area = 'vendita' and a.sezioni @> array['vendita'])
    ))
$$;

-- Mappa tabella → area, ricavata dalle dipendenze reali delle viste (pg_depend).
-- Le tre aree non condividono tabelle; l'unico oggetto comune è `centri`, che serve
-- alla barra filtri di ogni sezione.
do $$
declare
  t text; area text;
  aree jsonb := jsonb_build_object(
    'comune',  jsonb_build_array('centri'),
    'mkt',     jsonb_build_array('mkt_leads','mkt_esiti','appuntamenti','perf_giorno',
                                 'fb_insights_ad','fb_account_map','fb_campaign_class','centro_map'),
    'beauty',  jsonb_build_array('calls','leads','esiti','operators','campaigns'),
    'vendita', jsonb_build_array('set_chiamate','set_chiamate_ghl','set_esiti','set_setter_map',
                                 'set_utenti_ghl','set_opportunita','set_stage_ghl','set_stage_class')
  );
begin
  for area in select jsonb_object_keys(aree) loop
    for t in select jsonb_array_elements_text(aree -> area) loop
      execute format('drop policy if exists authenticated_read on public.%I', t);
      execute format('create policy authenticated_read on public.%I for select to authenticated using (public.ms_puo(%L))', t, area);
    end loop;
  end loop;
end $$;

alter table public.ms_accessi enable row level security;
drop policy if exists ms_accessi_read on public.ms_accessi;
create policy ms_accessi_read on public.ms_accessi for select to authenticated
  using (user_id = auth.uid() or public.ms_puo('admin'));
revoke all on public.ms_accessi from anon;
grant select on public.ms_accessi to authenticated;   -- nessuna scrittura diretta: solo via RPC

-- ── RPC ─────────────────────────────────────────────────────────────────────
create or replace function public.ms_mie_sezioni()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce((select a.sezioni from public.ms_accessi a
                   where a.user_id = auth.uid() and a.attivo), array[]::text[])
$$;

create or replace function public.ms_lista_utenti()
returns table (user_id uuid, email text, sezioni text[], attivo boolean, ultimo_accesso timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ms_puo('admin') then
    raise exception 'Solo un amministratore puo elencare gli utenti';
  end if;
  return query
    select u.id, u.email::text, coalesce(a.sezioni, array[]::text[]),
           coalesce(a.attivo, true), u.last_sign_in_at
    from auth.users u
    left join public.ms_accessi a on a.user_id = u.id
    order by u.email;
end $$;

create or replace function public.ms_imposta_sezioni(p_user uuid, p_sezioni text[])
returns text[] language plpgsql volatile security definer set search_path = public as $$
declare v_valide text[] := array['panoramica','marketing','coorti','beauty','vendita','admin'];
        v_pulite text[];
begin
  if not public.ms_puo('admin') then
    raise exception 'Solo un amministratore puo modificare gli accessi';
  end if;
  select coalesce(array_agg(distinct s), array[]::text[]) into v_pulite
  from unnest(coalesce(p_sezioni, array[]::text[])) s where s = any(v_valide);

  -- anti-lockout: nessun admin puo togliere admin a se stesso
  if p_user = auth.uid() and not (v_pulite @> array['admin']) then
    raise exception 'Non puoi togliere il ruolo admin a te stesso';
  end if;

  insert into public.ms_accessi (user_id, email, sezioni, aggiornato_a)
  select p_user, u.email, v_pulite, now() from auth.users u where u.id = p_user
  on conflict (user_id) do update
    set sezioni = excluded.sezioni, email = excluded.email, aggiornato_a = now();
  return v_pulite;
end $$;

revoke all on function public.ms_puo(text) from public, anon;
revoke all on function public.ms_mie_sezioni() from public, anon;
revoke all on function public.ms_lista_utenti() from public, anon;
revoke all on function public.ms_imposta_sezioni(uuid, text[]) from public, anon;
grant execute on function public.ms_puo(text)                     to authenticated;
grant execute on function public.ms_mie_sezioni()                 to authenticated;
grant execute on function public.ms_lista_utenti()                to authenticated;
grant execute on function public.ms_imposta_sezioni(uuid, text[]) to authenticated;

-- unica RPC manager-stats ancora esposta ad anon
revoke execute on function public.api_clienti_attivi(date, date) from anon;

-- ── seed: nessuno perde l'accesso al momento del deploy ─────────────────────
insert into public.ms_accessi (user_id, email, sezioni)
select u.id, u.email, array['admin']
from auth.users u where u.email = 'leonardomarazzi0@gmail.com'
on conflict (user_id) do update set sezioni = excluded.sezioni, aggiornato_a = now();

insert into public.ms_accessi (user_id, email, sezioni)
select u.id, u.email, array['panoramica','marketing','coorti','beauty','vendita']
from auth.users u
where u.email in ('carassobusiness@gmail.com','guidobuttitta@mach10holding.com',
                  'ufficiosalonevincente@gmail.com','federico.giuntoli.business@gmail.com',
                  'samuele.lattanzio20@gmail.com')
on conflict (user_id) do nothing;
-- test.academy@salonevincente.it deliberatamente NON inserito.

-- Verifica (per ogni utente, simulando la sua sessione):
--   select set_config('request.jwt.claims', json_build_object('sub','<uuid>')::text, true);
--   set local role authenticated;
--   select (select count(*) from v_panoramica_centro)   mkt,
--          (select count(*) from agg_setter_giorno)     beauty,
--          (select count(*) from agg_set_setter_giorno) vendita,
--          (select count(*) from centri)                comune;
