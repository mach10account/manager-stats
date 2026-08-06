-- Knowledge base delle procedure operative (fonte: Drive "STRUTTURA E GESTIONE").
-- Popolata dal workflow n8n WF-KB; letta dall'assistente AI e, in prospettiva, dalla UI.

create table if not exists public.kb_documenti (
  drive_id            text primary key,
  titolo              text not null,
  codice              text,                       -- es. 'F4.P02'
  flusso              text,                       -- F1 | F2 | F3 | F4 | RUOLI | STRUTTURA | ALTRO
  percorso            text,                       -- breadcrumb della cartella Drive
  tipo                text not null default 'documento',   -- documento | foglio | pdf
  sommario            text,                       -- prime righe, per l'indice in prompt
  testo               text not null default '',
  drive_modificato_il timestamptz,
  aggiornato_il       timestamptz not null default now(),
  attivo              boolean not null default true
);

alter table public.kb_documenti
  add column if not exists caratteri int
  generated always as (length(testo)) stored;

alter table public.kb_documenti
  add column if not exists ricerca tsvector
  generated always as (
    to_tsvector('italian',
      coalesce(codice, '') || ' ' || coalesce(titolo, '') || ' ' || coalesce(testo, ''))
  ) stored;

create index if not exists kb_documenti_ricerca_idx on public.kb_documenti using gin (ricerca);
create index if not exists kb_documenti_flusso_idx  on public.kb_documenti (flusso) where attivo;

alter table public.kb_documenti enable row level security;

-- Le procedure sono per tutto il team: le vede chiunque abbia almeno una sezione
-- assegnata in ms_accessi. Il (select ...) evita la rivalutazione per riga.
drop policy if exists kb_documenti_lettura on public.kb_documenti;
create policy kb_documenti_lettura on public.kb_documenti
  for select using ((select public.ms_puo('comune')));

-- Ricerca full-text in italiano. security invoker => la RLS sopra si applica.
create or replace function public.kb_cerca(q text, n int default 5)
returns table (
  drive_id text,
  codice   text,
  titolo   text,
  flusso   text,
  estratto text,
  punteggio real
)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select d.drive_id,
         d.codice,
         d.titolo,
         d.flusso,
         ts_headline('italian', d.testo, plainto_tsquery('italian', q),
                     'MaxFragments=3,MaxWords=45,MinWords=20,StartSel=<<,StopSel=>>'),
         ts_rank(d.ricerca, plainto_tsquery('italian', q))
  from public.kb_documenti d
  where d.attivo
    and d.ricerca @@ plainto_tsquery('italian', q)
  order by ts_rank(d.ricerca, plainto_tsquery('italian', q)) desc
  limit greatest(1, least(coalesce(n, 5), 10));
$$;

comment on table public.kb_documenti is
  'Procedure operative sincronizzate dal Drive "STRUTTURA E GESTIONE" (WF-KB, notturno). La cartella "da eliminare" e i duplicati shortcut sono esclusi a monte.';
