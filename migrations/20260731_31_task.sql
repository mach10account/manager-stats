-- manager-stats · Sezione Task (per tutti)
--
-- Nuova sezione operativa: task assegnate fra le persone del team, con stato
-- (Da fare / In corso / Fatto), esito, tipo attività, centro facoltativo e note.
--
-- REGOLE decise con Leo:
--  1. "Ognuno vede quelli che ha nel team": il team NON è una tabella nuova, si
--     ricava dai centri. Due persone sono nello stesso team se i loro insiemi di
--     centri visibili (ms_centri_scope) si intersecano → un consulente vede le
--     task delle beauty/media buyer dei suoi centri e viceversa. Chi non ha
--     vincoli di scope (manager) e gli admin vedono tutti.
--  2. "Chiunque assegna a chiunque": dentro il proprio team, ognuno può creare
--     task per chiunque e aggiornare stato/esito di quelle che vede.
--  3. La sezione è per TUTTI gli utenti attivi, anche senza sezioni di
--     statistiche assegnate → nuova area 'task' in ms_puo() e 'task' aggiunta
--     in coda a ms_mie_sezioni() (non è una sezione salvabile in ms_accessi).
--
-- ⚠️ centro_id NON ha foreign key su centri: WF-M1 rifà `centri` in full-refresh
-- ogni notte e una FK trasformerebbe un sync in un errore (o cancellerebbe il
-- collegamento). Il nome del centro si risolve in join dentro ms_task_lista().

-- ── 1. nome visibile della persona ───────────────────────────────────────────
alter table public.ms_accessi add column if not exists nome text;
comment on column public.ms_accessi.nome is
  'Nome e cognome mostrati nella sezione Task. Se vuoto si ripiega sulla email.';

create or replace function public.ms_nome_utente(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(btrim(a.nome), ''),
    initcap(replace(replace(split_part(coalesce(a.email, u.email::text), '@', 1), '.', ' '), '_', ' ')),
    u.email::text,
    '—')
  from auth.users u
  left join public.ms_accessi a on a.user_id = u.id
  where u.id = p_user
$$;

-- ── 2. area 'task' = qualunque utente attivo ─────────────────────────────────
create or replace function public.ms_puo(p_area text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ms_accessi a
    where a.user_id = auth.uid() and a.attivo and (
         a.sezioni @> array['admin']
      or p_area = 'task'                                    -- la sezione Task è di tutti
      or (p_area = 'comune'  and coalesce(array_length(a.sezioni,1),0) > 0)
      or (p_area = 'mkt'     and a.sezioni && array['panoramica','marketing','coorti'])
      or (p_area = 'beauty'  and a.sezioni @> array['beauty'])
      or (p_area = 'vendita' and a.sezioni @> array['vendita'])
    ))
$$;

create or replace function public.ms_mie_sezioni()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(
    (select a.sezioni || array['task'] from public.ms_accessi a
     where a.user_id = auth.uid() and a.attivo),
    array[]::text[])
$$;

-- ── 3. scope di un utente qualsiasi (stessa logica, parametrizzata) ──────────
-- null = nessun vincolo (admin o utente senza consulente/media buyer/picker).
create or replace function public.ms_centri_di(p_user uuid)
returns uuid[] language plpgsql stable security definer set search_path = public as $$
declare a public.ms_accessi%rowtype; ids uuid[];
begin
  select * into a from public.ms_accessi where user_id = p_user and attivo;
  if not found then return array[]::uuid[]; end if;
  if a.sezioni @> array['admin'] then return null; end if;
  if a.consulente is null and a.media_buyer is null
     and coalesce(array_length(a.centri_visibili, 1), 0) = 0 then
    return null;
  end if;
  select coalesce(array_agg(notion_id), array[]::uuid[]) into ids
  from public.centri
  where (a.consulente  is not null and consulente  = a.consulente)
     or (a.media_buyer is not null and media_buyer = a.media_buyer);
  return ids || coalesce(a.centri_visibili, array[]::uuid[]);
end $$;

-- ms_centri_scope resta l'unica usata dalle policy: ora delega, così la logica
-- di scope vive in un posto solo.
create or replace function public.ms_centri_scope()
returns uuid[] language sql stable security definer set search_path = public as $$
  select public.ms_centri_di(auth.uid())
$$;

-- ── 4. il team = chi condivide almeno un centro con me ───────────────────────
create or replace function public.ms_team()
returns uuid[] language plpgsql stable security definer set search_path = public as $$
declare mine uuid[]; ids uuid[];
begin
  if not exists (select 1 from public.ms_accessi where user_id = auth.uid() and attivo) then
    return array[]::uuid[];
  end if;
  if public.ms_puo('admin') then
    select coalesce(array_agg(user_id), array[]::uuid[]) into ids
    from public.ms_accessi where attivo;
    return ids;
  end if;
  mine := public.ms_centri_di(auth.uid());
  select coalesce(array_agg(a.user_id), array[]::uuid[]) into ids
  from public.ms_accessi a
  where a.attivo and (
        a.user_id = auth.uid()
     or mine is null                                   -- io vedo tutti i centri
     or public.ms_centri_di(a.user_id) is null         -- lui vede tutti i centri
     or public.ms_centri_di(a.user_id) && mine);       -- almeno un centro in comune
  return ids;
end $$;

-- ── 5. tabelle ───────────────────────────────────────────────────────────────
create table if not exists public.ms_task (
  id           bigint generated always as identity primary key,
  titolo       text not null check (length(btrim(titolo)) > 0),
  assegnata_a  uuid not null references auth.users(id) on delete cascade,
  creata_da    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  centro_id    uuid,                                   -- niente FK: vedi nota in testa
  data         date not null default ((now() at time zone 'Europe/Rome')::date),
  ora_inizio   time,
  ora_fine     time,
  minuti       integer check (minuti is null or (minuti > 0 and minuti <= 1440)),
  categoria    text not null default 'Operativa'
                 check (categoria in ('Operativa','Chiamata','Controllo','Riunione')),
  stato        text not null default 'todo'  check (stato in ('todo','doing','done')),
  esito        text not null default 'none'  check (esito in ('none','ok','review')),
  descrizione  text,
  creata_a     timestamptz not null default now(),
  aggiornata_a timestamptz not null default now(),
  completata_a timestamptz
);
comment on table public.ms_task is
  'Task operative di manager-stats. Visibilita per team (ms_team), scritture regolate da RLS.';

create index if not exists ms_task_ass_data_idx on public.ms_task (assegnata_a, data);
create index if not exists ms_task_data_idx     on public.ms_task (data);
create index if not exists ms_task_centro_idx   on public.ms_task (centro_id) where centro_id is not null;

create table if not exists public.ms_task_nota (
  id       bigint generated always as identity primary key,
  task_id  bigint not null references public.ms_task(id) on delete cascade,
  autore   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  testo    text not null check (length(btrim(testo)) > 0),
  creata_a timestamptz not null default now()
);
create index if not exists ms_task_nota_task_idx on public.ms_task_nota (task_id, creata_a);

-- aggiornata_a / completata_a automatici; creatore e data di creazione immutabili
create or replace function public.ms_task_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.aggiornata_a := now();
  new.creata_da    := old.creata_da;
  new.creata_a     := old.creata_a;
  if new.stato = 'done' and old.stato <> 'done' then new.completata_a := now();
  elsif new.stato <> 'done' then new.completata_a := null;
  end if;
  return new;
end $$;
drop trigger if exists ms_task_touch on public.ms_task;
create trigger ms_task_touch before update on public.ms_task
  for each row execute function public.ms_task_touch();

-- ── 6. RLS ───────────────────────────────────────────────────────────────────
-- (select public.ms_team()) è un InitPlan: valutato UNA volta per query, non per riga.
alter table public.ms_task enable row level security;
drop policy if exists ms_task_read   on public.ms_task;
drop policy if exists ms_task_insert on public.ms_task;
drop policy if exists ms_task_update on public.ms_task;
drop policy if exists ms_task_delete on public.ms_task;

create policy ms_task_read on public.ms_task for select to authenticated
  using (assegnata_a = any ((select public.ms_team())::uuid[]) or creata_da = auth.uid());

create policy ms_task_insert on public.ms_task for insert to authenticated
  with check (creata_da = auth.uid() and assegnata_a = any ((select public.ms_team())::uuid[]));

create policy ms_task_update on public.ms_task for update to authenticated
  using      (assegnata_a = any ((select public.ms_team())::uuid[]) or creata_da = auth.uid())
  with check (assegnata_a = any ((select public.ms_team())::uuid[]));

-- cancellare è l'unica cosa non "di chiunque": chi l'ha creata, chi ce l'ha, o un admin
create policy ms_task_delete on public.ms_task for delete to authenticated
  using (creata_da = auth.uid() or assegnata_a = auth.uid() or public.ms_puo('admin'));

alter table public.ms_task_nota enable row level security;
drop policy if exists ms_task_nota_read   on public.ms_task_nota;
drop policy if exists ms_task_nota_insert on public.ms_task_nota;
drop policy if exists ms_task_nota_delete on public.ms_task_nota;

-- la visibilità della nota segue quella della task (la RLS di ms_task si applica qui dentro)
create policy ms_task_nota_read on public.ms_task_nota for select to authenticated
  using (exists (select 1 from public.ms_task t where t.id = task_id));
create policy ms_task_nota_insert on public.ms_task_nota for insert to authenticated
  with check (autore = auth.uid() and exists (select 1 from public.ms_task t where t.id = task_id));
create policy ms_task_nota_delete on public.ms_task_nota for delete to authenticated
  using (autore = auth.uid() or public.ms_puo('admin'));

revoke all on public.ms_task      from anon;
revoke all on public.ms_task_nota from anon;
grant select, insert, update, delete on public.ms_task      to authenticated;
grant select, insert, delete         on public.ms_task_nota to authenticated;

-- ── 7. RPC di lettura (nomi già risolti) ─────────────────────────────────────
create or replace function public.ms_task_lista()
returns table (
  id bigint, titolo text, assegnata_a uuid, assegnato_nome text,
  creata_da uuid, creatore_nome text, centro_id uuid, centro_nome text,
  data date, ora_inizio time, ora_fine time, minuti integer,
  categoria text, stato text, esito text, descrizione text,
  n_note integer, creata_a timestamptz)
language sql stable security definer set search_path = public as $$
  select t.id, t.titolo, t.assegnata_a, public.ms_nome_utente(t.assegnata_a),
         t.creata_da, public.ms_nome_utente(t.creata_da), t.centro_id, c.nome,
         t.data, t.ora_inizio, t.ora_fine, t.minuti,
         t.categoria, t.stato, t.esito, t.descrizione,
         (select count(*)::integer from public.ms_task_nota n where n.task_id = t.id),
         t.creata_a
  from public.ms_task t
  left join public.centri c on c.notion_id = t.centro_id
  where public.ms_puo('task')
    and (t.assegnata_a = any ((select public.ms_team())::uuid[]) or t.creata_da = auth.uid())
  order by t.data desc, t.ora_inizio nulls last, t.id
$$;

create or replace function public.ms_persone()
returns table (user_id uuid, nome text, email text)
language sql stable security definer set search_path = public as $$
  select a.user_id, public.ms_nome_utente(a.user_id), a.email
  from public.ms_accessi a
  where public.ms_puo('task') and a.attivo
    and a.user_id = any ((select public.ms_team())::uuid[])
  order by 2
$$;

create or replace function public.ms_task_note(p_task bigint)
returns table (id bigint, testo text, autore uuid, autore_nome text, creata_a timestamptz)
language sql stable security definer set search_path = public as $$
  select n.id, n.testo, n.autore, public.ms_nome_utente(n.autore), n.creata_a
  from public.ms_task_nota n
  join public.ms_task t on t.id = n.task_id
  where n.task_id = p_task
    and public.ms_puo('task')
    and (t.assegnata_a = any ((select public.ms_team())::uuid[]) or t.creata_da = auth.uid())
  order by n.creata_a
$$;

-- ── 8. nome utente gestito dal pannello Accessi ──────────────────────────────
create or replace function public.ms_imposta_nome(p_user uuid, p_nome text)
returns text language plpgsql volatile security definer set search_path = public as $$
declare v_nome text := nullif(btrim(coalesce(p_nome, '')), '');
begin
  if not public.ms_puo('admin') then
    raise exception 'Solo un amministratore puo cambiare il nome di un utente';
  end if;
  insert into public.ms_accessi (user_id, email, sezioni, nome, aggiornato_a)
  select p_user, u.email, array[]::text[], v_nome, now() from auth.users u where u.id = p_user
  on conflict (user_id) do update set nome = excluded.nome, aggiornato_a = now();
  return public.ms_nome_utente(p_user);
end $$;

-- la colonna `nome` cambia la firma di ritorno: serve drop, non replace
drop function if exists public.ms_lista_utenti();
create function public.ms_lista_utenti()
returns table (user_id uuid, email text, nome text, sezioni text[], attivo boolean,
               ultimo_accesso timestamptz, consulente text, media_buyer text, centri_visibili uuid[])
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ms_puo('admin') then
    raise exception 'Solo un amministratore puo elencare gli utenti';
  end if;
  return query
    select u.id, u.email::text, a.nome, coalesce(a.sezioni, array[]::text[]),
           coalesce(a.attivo, true), u.last_sign_in_at,
           a.consulente, a.media_buyer, a.centri_visibili
    from auth.users u
    left join public.ms_accessi a on a.user_id = u.id
    order by u.email;
end $$;

-- ── 9. grant ─────────────────────────────────────────────────────────────────
revoke all on function public.ms_nome_utente(uuid)       from public, anon;
revoke all on function public.ms_centri_di(uuid)         from public, anon;
revoke all on function public.ms_team()                  from public, anon;
revoke all on function public.ms_task_lista()            from public, anon;
revoke all on function public.ms_persone()               from public, anon;
revoke all on function public.ms_task_note(bigint)       from public, anon;
revoke all on function public.ms_imposta_nome(uuid,text) from public, anon;
grant execute on function public.ms_nome_utente(uuid)       to authenticated;
grant execute on function public.ms_centri_di(uuid)         to authenticated;
grant execute on function public.ms_team()                  to authenticated;
grant execute on function public.ms_task_lista()            to authenticated;
grant execute on function public.ms_persone()               to authenticated;
grant execute on function public.ms_task_note(bigint)       to authenticated;
grant execute on function public.ms_imposta_nome(uuid,text) to authenticated;

-- Verifica (simulando la sessione di un utente):
--   select set_config('request.jwt.claims', json_build_object('sub','<uuid>')::text, true);
--   set local role authenticated;
--   select array_length(ms_team(),1) as persone, (select count(*) from ms_task_lista()) as task;
