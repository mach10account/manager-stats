-- Storico delle conversazioni con l'assistente AI.
-- Ogni riga appartiene a chi l'ha scritta: nessuno legge le chat di un altro,
-- nemmeno gli admin (qui non c'e' ms_puo, si guarda solo auth.uid()).

create table if not exists public.ms_chat (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  titolo        text not null default 'Nuova conversazione',
  creata_il     timestamptz not null default now(),
  aggiornata_il timestamptz not null default now()
);

create table if not exists public.ms_chat_messaggio (
  id        bigint generated always as identity primary key,
  chat_id   uuid not null references public.ms_chat(id) on delete cascade,
  ruolo     text not null check (ruolo in ('utente', 'assistente')),
  testo     text not null,
  fonti     text[],
  creato_il timestamptz not null default now()
);

create index if not exists ms_chat_utente_idx  on public.ms_chat (user_id, aggiornata_il desc);
create index if not exists ms_chat_msg_idx     on public.ms_chat_messaggio (chat_id, id);

alter table public.ms_chat            enable row level security;
alter table public.ms_chat_messaggio  enable row level security;

-- (select auth.uid()) e non auth.uid(): senza il select Postgres rivaluta la
-- funzione per ogni riga (vedi la nota sulle policy nel CLAUDE.md).
drop policy if exists ms_chat_propria on public.ms_chat;
create policy ms_chat_propria on public.ms_chat
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists ms_chat_messaggi_propri on public.ms_chat_messaggio;
create policy ms_chat_messaggi_propri on public.ms_chat_messaggio
  for all
  using (exists (
    select 1 from public.ms_chat c
    where c.id = chat_id and c.user_id = (select auth.uid())))
  with check (exists (
    select 1 from public.ms_chat c
    where c.id = chat_id and c.user_id = (select auth.uid())));

-- La lista dello storico e' ordinata per ultimo messaggio: senza questo
-- resterebbe ferma alla data di creazione.
create or replace function public.ms_chat_tocca()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.ms_chat set aggiornata_il = now() where id = new.chat_id;
  return new;
end $$;

drop trigger if exists ms_chat_messaggio_tocca on public.ms_chat_messaggio;
create trigger ms_chat_messaggio_tocca
  after insert on public.ms_chat_messaggio
  for each row execute function public.ms_chat_tocca();

comment on table public.ms_chat is 'Conversazioni con l''assistente AI. Visibili solo al proprietario.';
