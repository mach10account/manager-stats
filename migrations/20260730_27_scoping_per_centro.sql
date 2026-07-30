-- manager-stats · Migration 27 · Scoping per centro
--
-- Consulenti e media buyer vedono SOLO i propri centri. Due modi, combinabili:
--   · ms_accessi.consulente       = email consulente (match su centri.consulente,
--                                   che in Notion e' gia' un'email) → segue da solo
--                                   i cambi di assegnazione al sync notturno
--   · ms_accessi.centri_visibili  = allowlist esplicita di centro_id (media buyer)
-- Entrambi NULL = nessuna restrizione (comportamento attuale). Admin = mai limitato.
--
-- Applicazione a livello DB (RLS), come per le sezioni: le viste sono
-- security_invoker e le RPC invoker, quindi il filtro si propaga ovunque.
-- Pattern performance della migration 20/26: guardie in initplan con (select ...),
-- confronto per riga = solo "= any(array)".

alter table public.ms_accessi
  add column if not exists consulente text,
  add column if not exists centri_visibili uuid[];

comment on column public.ms_accessi.consulente is
  'Email consulente (= centri.consulente): l''utente vede solo i centri di questo consulente. NULL = nessun vincolo.';
comment on column public.ms_accessi.centri_visibili is
  'Allowlist esplicita di centri (per i media buyer). NULL/vuota = nessun vincolo.';

-- ── scope: elenco centri visibili (NULL = tutti) ─────────────────────────────
-- SECURITY DEFINER: legge ms_accessi e centri da owner, quindi niente ricorsione
-- con le policy (stesso pattern di ms_puo).
create or replace function public.ms_centri_scope()
returns uuid[] language plpgsql stable security definer set search_path = public as $$
declare a public.ms_accessi%rowtype; ids uuid[];
begin
  select * into a from public.ms_accessi where user_id = auth.uid() and attivo;
  if not found then return array[]::uuid[]; end if;                -- non abilitato: nulla
  if a.sezioni @> array['admin'] then return null; end if;         -- admin: tutto
  if a.consulente is null
     and coalesce(array_length(a.centri_visibili, 1), 0) = 0 then
    return null;                                                   -- nessun vincolo
  end if;
  select coalesce(array_agg(notion_id), array[]::uuid[]) into ids
  from public.centri
  where a.consulente is not null and consulente = a.consulente;
  return ids || coalesce(a.centri_visibili, array[]::uuid[]);
end $$;

-- Account FB visibili, derivati dai centri (fb_insights_ad non ha centro_id).
create or replace function public.ms_fb_accounts_scope()
returns text[] language plpgsql stable security definer set search_path = public as $$
declare scope uuid[]; accts text[];
begin
  scope := public.ms_centri_scope();
  if scope is null then return null; end if;
  select coalesce(array_agg(distinct s.acct), array[]::text[]) into accts from (
    select c.fb_ad_account_id as acct from public.centri c
    where c.notion_id = any(scope) and c.fb_ad_account_id is not null
    union
    select m.ad_account_id from public.fb_account_map m
    where m.centro_id = any(scope)
  ) s;
  return accts;
end $$;

revoke all on function public.ms_centri_scope() from public, anon;
revoke all on function public.ms_fb_accounts_scope() from public, anon;
grant execute on function public.ms_centri_scope()     to authenticated;
grant execute on function public.ms_fb_accounts_scope() to authenticated;

-- ── policy: area + scope ─────────────────────────────────────────────────────
-- centri (comune: serve alla barra filtri di ogni sezione)
drop policy if exists authenticated_read on public.centri;
create policy authenticated_read on public.centri for select to authenticated
  using ((select public.ms_puo('comune'))
     and ((select public.ms_centri_scope()) is null
       or notion_id = any(((select public.ms_centri_scope()))::uuid[])));

-- tabelle mkt con centro_id
do $$
declare t text;
begin
  foreach t in array array['mkt_leads', 'appuntamenti', 'perf_giorno',
                           'fb_account_map', 'centro_map'] loop
    execute format('drop policy if exists authenticated_read on public.%I', t);
    execute format(
      'create policy authenticated_read on public.%I for select to authenticated
       using ((select public.ms_puo(%L))
          and ((select public.ms_centri_scope()) is null
            or centro_id = any(((select public.ms_centri_scope()))::uuid[])))', t, 'mkt');
  end loop;
end $$;

-- fb_insights_ad: scoping per ad account
drop policy if exists authenticated_read on public.fb_insights_ad;
create policy authenticated_read on public.fb_insights_ad for select to authenticated
  using ((select public.ms_puo('mkt'))
     and ((select public.ms_fb_accounts_scope()) is null
       or ad_account_id = any(((select public.ms_fb_accounts_scope()))::text[])));

-- mkt_esiti e fb_campaign_class restano area-wide: lookup senza dati per centro.
-- beauty/vendita: sezioni interne SV, non toccate.

-- ── RPC ──────────────────────────────────────────────────────────────────────
-- ms_lista_utenti: aggiunge consulente + centri_visibili (cambia il return type:
-- drop obbligatorio).
drop function if exists public.ms_lista_utenti();
create function public.ms_lista_utenti()
returns table (user_id uuid, email text, sezioni text[], attivo boolean,
               ultimo_accesso timestamptz, consulente text, centri_visibili uuid[])
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ms_puo('admin') then
    raise exception 'Solo un amministratore puo elencare gli utenti';
  end if;
  return query
    select u.id, u.email::text, coalesce(a.sezioni, array[]::text[]),
           coalesce(a.attivo, true), u.last_sign_in_at, a.consulente, a.centri_visibili
    from auth.users u
    left join public.ms_accessi a on a.user_id = u.id
    order by u.email;
end $$;

create or replace function public.ms_imposta_scope(p_user uuid, p_consulente text, p_centri uuid[])
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_consulente text := nullif(trim(coalesce(p_consulente, '')), '');
        v_centri uuid[];
begin
  if not public.ms_puo('admin') then
    raise exception 'Solo un amministratore puo modificare gli accessi';
  end if;
  -- tiene solo id di centri esistenti; lista vuota → NULL (nessun vincolo)
  select array_agg(distinct c.notion_id) into v_centri
  from unnest(coalesce(p_centri, array[]::uuid[])) x(id)
  join public.centri c on c.notion_id = x.id;

  insert into public.ms_accessi (user_id, email, sezioni, consulente, centri_visibili, aggiornato_a)
  select p_user, u.email, array[]::text[], v_consulente, v_centri, now()
  from auth.users u where u.id = p_user
  on conflict (user_id) do update
    set consulente = excluded.consulente,
        centri_visibili = excluded.centri_visibili,
        aggiornato_a = now();
end $$;

revoke all on function public.ms_lista_utenti() from public, anon;
revoke all on function public.ms_imposta_scope(uuid, text, uuid[]) from public, anon;
grant execute on function public.ms_lista_utenti()                  to authenticated;
grant execute on function public.ms_imposta_scope(uuid, text, uuid[]) to authenticated;

-- Nessun seed: al deploy nessuno e' limitato (consulente/centri_visibili NULL).
-- Si assegna dal pannello Accessi.
--
-- Verifica (simulando un utente con scope):
--   begin;
--   update ms_accessi set consulente = '<email>' where user_id = '<uuid>';
--   select set_config('request.jwt.claims', json_build_object('sub','<uuid>')::text, true);
--   set local role authenticated;
--   select count(*) from centri;          -- solo i suoi
--   select count(*) from v_panoramica_centro;
--   rollback;
