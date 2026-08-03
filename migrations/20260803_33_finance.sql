-- manager-stats · Finance (dashboard generale) — mirror di due DB Notion
--
--   fin_incassi   ← 🏦 DATABASE INCASSI        (26f3e1b8-27ed-8062-a85b-000ba63110c3)
--   fin_contratti ← DATABASE VALORE CONTRATTI  (2713e1b8-27ed-8136-b9e1-000ba99e95df)
--
-- Sync: WF-M7 n8n, full-refresh orario (upsert + delete delle righe con synced_at
-- vecchio = pagine cancellate su Notion). Volumi piccoli (~1.4k + ~0.7k righe).
--
-- ⚠️ SOLO ADMIN: la policy usa ms_puo('finance'), che nella funzione attuale non ha
-- un ramo dedicato → passa soltanto chi ha 'admin' in ms_accessi. Inoltre 'finance'
-- NON è tra le sezioni assegnabili di ms_imposta_sezioni, quindi non si può
-- concedere dal pannello Accessi. Per aprirla ad altri in futuro: aggiungere il ramo
-- `(p_area = 'finance' and a.sezioni @> array['finance'])` a ms_puo e 'finance'
-- a v_valide in ms_imposta_sezioni (+ riga in SEZIONI di accessi.js).

create table if not exists public.fin_incassi (
  notion_id           uuid primary key,          -- page id Notion
  id_incasso          text,                      -- title "ID INCASSO"
  contratto_notion_id uuid,                      -- relation DATABASE CONTRATTI (⚠️ quasi sempre vuota su Notion)
  id_contratto        text,                      -- rollup ID CONTRATTO — chiave di join vera verso fin_contratti
  consulente          text,                      -- (FORMULA) CONSULENTE
  centro              text,                      -- (FORMULA) NOME CENTRO O STUDIO
  agenzia             text[],                    -- rollup AGENZIA (multi_select)
  tipo_contratto      text[],                    -- rollup TIPO DI CONTRATTO (multi_select)
  venditore           text,                      -- rollup VENDITORE (person, join ', ')
  data_incasso        date,                      -- DATA INCASSO (null = non ancora incassata)
  data_scadenza       date,                      -- DATA SCADENZA PAGAMENTO
  importo             numeric,                   -- IMPORTO RATA
  rata_numero         numeric,                   -- RATA NUMERO
  pagato              boolean not null default false,
  metodo              text,                      -- TIPOLOGIA PAGAMENTO 1 (select)
  created_time        timestamptz,
  synced_at           timestamptz not null default now()
);
comment on table public.fin_incassi is
  'Mirror Notion 🏦 DATABASE INCASSI (1 riga = 1 rata/incasso). Sync WF-M7. Solo admin.';

create table if not exists public.fin_contratti (
  notion_id           uuid primary key,          -- page id Notion
  nome_centro         text,                      -- title
  id_contratto        text,                      -- rollup ID CONTRATTO
  cliente_notion_id   uuid,                      -- relation DATABASE CLIENTI (record contratto/cliente)
  valore              numeric,                   -- VALORE CONTRATTO
  stato               text[],                    -- rollup STATO CONTRATTO (multi_select)
  durata              text[],                    -- rollup DURATA CONTRATTO (multi_select)
  agenzia             text[],                    -- rollup AGENZIA (multi_select)
  venditore           text,                      -- rollup VENDITORE (person, join ', ')
  creazione_contratto date,                      -- rollup CREAZIONE CONTRATTO (fallback: created_time)
  created_time        timestamptz,
  synced_at           timestamptz not null default now()
);
comment on table public.fin_contratti is
  'Mirror Notion DATABASE VALORE CONTRATTI (1 riga = 1 contratto). Sync WF-M7. Solo admin.';

create index if not exists idx_fin_incassi_id_contratto  on public.fin_incassi (id_contratto);
create index if not exists idx_fin_incassi_data_incasso  on public.fin_incassi (data_incasso);
create index if not exists idx_fin_incassi_data_scadenza on public.fin_incassi (data_scadenza);
create index if not exists idx_fin_incassi_synced_at     on public.fin_incassi (synced_at);
create index if not exists idx_fin_contratti_creazione   on public.fin_contratti (creazione_contratto);
create index if not exists idx_fin_contratti_synced_at   on public.fin_contratti (synced_at);

alter table public.fin_incassi   enable row level security;
alter table public.fin_contratti enable row level security;

-- (select …) e non la chiamata nuda: InitPlan una volta per query, non per riga
-- (lezione della migration 20).
drop policy if exists authenticated_read on public.fin_incassi;
create policy authenticated_read on public.fin_incassi
  for select to authenticated using ((select public.ms_puo('finance')));
drop policy if exists authenticated_read on public.fin_contratti;
create policy authenticated_read on public.fin_contratti
  for select to authenticated using ((select public.ms_puo('finance')));

revoke all on public.fin_incassi, public.fin_contratti from anon;
grant select on public.fin_incassi, public.fin_contratti to authenticated;
