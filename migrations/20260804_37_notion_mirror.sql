-- Mirror completo dei 4 database Notion (CLIENTI, CONTRATTI, VALORE CONTRATTI, INCASSI).
-- Struttura uniforme: colonne di servizio + props jsonb con TUTTE le proprietà Notion
-- (nome proprietà -> valore già "appiattito": testo, numero, bool, array, data ISO).
-- Sync: WF-M8 (WPT0KBOFtglbCqDk). RLS come le fin_*: lettura solo admin (ms_puo('finance')).
-- NB: applicata via MCP il 2026-08-04; il numero 37 è condiviso con
-- 20260804_37_ultimo_accesso_reale.sql (sessione parallela), non c'è dipendenza fra le due.

create table if not exists public.notion_clienti (
  notion_id   uuid primary key,
  url         text,
  titolo      text,
  created_time  timestamptz,
  last_edited   timestamptz,
  archiviato  boolean not null default false,
  props       jsonb   not null default '{}'::jsonb,
  synced_at   timestamptz not null default now()
);

create table if not exists public.notion_contratti (
  notion_id   uuid primary key,
  url         text,
  titolo      text,
  created_time  timestamptz,
  last_edited   timestamptz,
  archiviato  boolean not null default false,
  props       jsonb   not null default '{}'::jsonb,
  synced_at   timestamptz not null default now()
);

create table if not exists public.notion_valore_contratti (
  notion_id   uuid primary key,
  url         text,
  titolo      text,
  created_time  timestamptz,
  last_edited   timestamptz,
  archiviato  boolean not null default false,
  props       jsonb   not null default '{}'::jsonb,
  synced_at   timestamptz not null default now()
);

create table if not exists public.notion_incassi (
  notion_id   uuid primary key,
  url         text,
  titolo      text,
  created_time  timestamptz,
  last_edited   timestamptz,
  archiviato  boolean not null default false,
  props       jsonb   not null default '{}'::jsonb,
  synced_at   timestamptz not null default now()
);

create index if not exists notion_clienti_props_gin   on public.notion_clienti   using gin (props jsonb_path_ops);
create index if not exists notion_contratti_props_gin on public.notion_contratti using gin (props jsonb_path_ops);
create index if not exists notion_valore_props_gin    on public.notion_valore_contratti using gin (props jsonb_path_ops);
create index if not exists notion_incassi_props_gin   on public.notion_incassi   using gin (props jsonb_path_ops);

create index if not exists notion_contratti_creazione on public.notion_contratti ((props->>'CREAZIONE CONTRATTO'));
create index if not exists notion_incassi_data_incasso on public.notion_incassi  ((props->>'DATA INCASSO'));

alter table public.notion_clienti           enable row level security;
alter table public.notion_contratti         enable row level security;
alter table public.notion_valore_contratti  enable row level security;
alter table public.notion_incassi           enable row level security;

drop policy if exists authenticated_read on public.notion_clienti;
drop policy if exists authenticated_read on public.notion_contratti;
drop policy if exists authenticated_read on public.notion_valore_contratti;
drop policy if exists authenticated_read on public.notion_incassi;

create policy authenticated_read on public.notion_clienti          for select using ((select ms_puo('finance')));
create policy authenticated_read on public.notion_contratti        for select using ((select ms_puo('finance')));
create policy authenticated_read on public.notion_valore_contratti for select using ((select ms_puo('finance')));
create policy authenticated_read on public.notion_incassi          for select using ((select ms_puo('finance')));

grant select on public.notion_clienti, public.notion_contratti,
                public.notion_valore_contratti, public.notion_incassi to authenticated;
