-- manager-stats · Migration 29 · Scoping anche per media buyer
--
-- Estende la migration 27: oltre a ms_accessi.consulente c'e' ms_accessi.media_buyer.
-- I due criteri si SOMMANO fra loro e con centri_visibili (unione), cosi' chi fa
-- sia il consulente sia il media buyer vede entrambi i gruppi di centri.
-- Tutti e tre NULL = nessun vincolo. Admin mai limitato.
--
-- Le policy non cambiano: continuano a chiamare ms_centri_scope(), che qui viene
-- solo esteso. ms_lista_utenti e ms_imposta_scope cambiano firma (drop + create).

alter table public.ms_accessi add column if not exists media_buyer text;
comment on column public.ms_accessi.media_buyer is
  'Email media buyer (= centri.media_buyer): l''utente vede i centri di questo media buyer. NULL = nessun vincolo.';

create or replace function public.ms_centri_scope()
returns uuid[] language plpgsql stable security definer set search_path = public as $$
declare a public.ms_accessi%rowtype; ids uuid[];
begin
  select * into a from public.ms_accessi where user_id = auth.uid() and attivo;
  if not found then return array[]::uuid[]; end if;              -- non abilitato: nulla
  if a.sezioni @> array['admin'] then return null; end if;       -- admin: tutto
  if a.consulente is null and a.media_buyer is null
     and coalesce(array_length(a.centri_visibili, 1), 0) = 0 then
    return null;                                                 -- nessun vincolo
  end if;
  select coalesce(array_agg(notion_id), array[]::uuid[]) into ids
  from public.centri
  where (a.consulente  is not null and consulente  = a.consulente)
     or (a.media_buyer is not null and media_buyer = a.media_buyer);
  return ids || coalesce(a.centri_visibili, array[]::uuid[]);
end $$;

drop function if exists public.ms_lista_utenti();
create function public.ms_lista_utenti()
returns table (user_id uuid, email text, sezioni text[], attivo boolean,
               ultimo_accesso timestamptz, consulente text, media_buyer text,
               centri_visibili uuid[])
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ms_puo('admin') then
    raise exception 'Solo un amministratore puo elencare gli utenti';
  end if;
  return query
    select u.id, u.email::text, coalesce(a.sezioni, array[]::text[]),
           coalesce(a.attivo, true), u.last_sign_in_at,
           a.consulente, a.media_buyer, a.centri_visibili
    from auth.users u
    left join public.ms_accessi a on a.user_id = u.id
    order by u.email;
end $$;

drop function if exists public.ms_imposta_scope(uuid, text, uuid[]);
create function public.ms_imposta_scope(p_user uuid, p_consulente text,
                                        p_media_buyer text, p_centri uuid[])
returns void language plpgsql volatile security definer set search_path = public as $$
declare v_cons text := nullif(trim(coalesce(p_consulente, '')), '');
        v_mb   text := nullif(trim(coalesce(p_media_buyer, '')), '');
        v_centri uuid[];
begin
  if not public.ms_puo('admin') then
    raise exception 'Solo un amministratore puo modificare gli accessi';
  end if;
  -- tiene solo id di centri esistenti; lista vuota → NULL (nessun vincolo)
  select array_agg(distinct c.notion_id) into v_centri
  from unnest(coalesce(p_centri, array[]::uuid[])) x(id)
  join public.centri c on c.notion_id = x.id;

  insert into public.ms_accessi (user_id, email, sezioni, consulente, media_buyer,
                                 centri_visibili, aggiornato_a)
  select p_user, u.email, array[]::text[], v_cons, v_mb, v_centri, now()
  from auth.users u where u.id = p_user
  on conflict (user_id) do update
    set consulente = excluded.consulente,
        media_buyer = excluded.media_buyer,
        centri_visibili = excluded.centri_visibili,
        aggiornato_a = now();
end $$;

revoke all on function public.ms_lista_utenti() from public, anon;
revoke all on function public.ms_imposta_scope(uuid, text, text, uuid[]) from public, anon;
grant execute on function public.ms_lista_utenti() to authenticated;
grant execute on function public.ms_imposta_scope(uuid, text, text, uuid[]) to authenticated;

-- Verificato: utente con media_buyer = giuseppe97pa@gmail.com vede 95/542 centri
-- e 18.136/58.090 lead; con consulente Samuele 96 centri; admin sempre tutto.
