-- 37 · "Ultimo accesso" nel pannello Accessi = ultimo USO, non ultimo login
--
-- Problema (segnalato da Leo il 4/8): la colonna mostrava auth.users.last_sign_in_at,
-- che GoTrue aggiorna SOLO quando si reinserisce la password. Chi resta loggato
-- (la sessione si rinnova da sola all'infinito, not_after = null) resta congelato
-- alla data del primo login: Leo risultava "31/07" pur usando la piattaforma ogni
-- giorno. Non era un dato sbagliato, era la metrica sbagliata.
--
-- Fix a due fonti, entrambe già disponibili lato server:
--   1) ms_accessi.ultimo_uso — scritto da ms_ping(), che il frontend chiama a ogni
--      boot dell'app (js/app.js). È la fonte precisa.
--   2) auth.sessions.updated_at — il refresh del token (~ogni ora di app aperta).
--      Copre chi non è ancora passato dalla versione nuova del frontend e i login
--      di ieri. Le righe spariscono al logout/scadenza, da qui il coalesce.
-- Si prende il GREATEST delle tre (last_sign_in_at incluso): GREATEST ignora i NULL.

alter table public.ms_accessi add column if not exists ultimo_uso timestamptz;

-- Ping di presenza: ogni utente aggiorna soltanto la propria riga.
create or replace function public.ms_ping()
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.ms_accessi set ultimo_uso = now() where user_id = auth.uid();
$$;

revoke all on function public.ms_ping() from public;
grant execute on function public.ms_ping() to authenticated;

create or replace function public.ms_lista_utenti()
returns table (user_id uuid, email text, nome text, sezioni text[], attivo boolean,
               ultimo_accesso timestamptz, consulente text, media_buyer text, centri_visibili uuid[])
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not public.ms_puo('admin') then
    raise exception 'Solo un amministratore puo elencare gli utenti';
  end if;
  return query
    select u.id, u.email::text, a.nome, coalesce(a.sezioni, array[]::text[]),
           coalesce(a.attivo, true),
           greatest(u.last_sign_in_at, a.ultimo_uso, sess.ultima),
           a.consulente, a.media_buyer, a.centri_visibili
    from auth.users u
    left join public.ms_accessi a on a.user_id = u.id
    left join lateral (
      select max(greatest(s.updated_at, s.created_at)) as ultima
      from auth.sessions s where s.user_id = u.id
    ) sess on true
    order by u.email;
end $$;
