-- Finance · Gestione costi (dal prototipo CFO Cockpit) — SOLO ADMIN, lettura e scrittura.
--
-- fin_costi: registro voci di costo, editabile dall'app (prima tabella finance
-- scrivibile). Ricorrenza calcolata client-side come nel Cockpit (costOccurs):
--   mensile    → conta da `data` in poi (fino a `fine` se impostata)
--   annua      → stesso mese dell'anno, da `data` in poi
--   una-tantum → solo nel mese di `data`
-- `attivo=false` = storicizzata senza cancellare.
--
-- Commissioni: NON sono voci manuali — arrivano dagli incassi Notion
-- (colonne comm_* su fin_incassi, sync WF-M7) e compaiono come riga "auto"
-- nel Reparto Commerciale.

create table if not exists public.fin_costi (
  id             uuid primary key default gen_random_uuid(),
  descrizione    text not null,
  reparto        text not null default 'Fissi',       -- Fissi|Commerciale|Marketing|Delivery|Extra
  ruolo          text,                                 -- solo Delivery (PM, Beauty Specialist, Media Buyer, …)
  sottocategoria text,                                 -- libera; per Extra è la categoria spesa (Software, Rimborsi, …)
  categoria      text not null default 'Operativi',    -- P&L: Diretti|Operativi|Strutturali|Asset|Investimenti
  importo        numeric not null default 0,
  data           date not null,                        -- inizio (o data della spesa per una tantum)
  fine           date,                                 -- opzionale: ultima mensilità inclusa
  frequenza      text not null default 'mensile',      -- mensile|annua|una-tantum
  responsabile   text,
  note           text,
  attivo         boolean not null default true,
  creato_da      text,
  creato_a       timestamptz not null default now(),
  aggiornato_a   timestamptz not null default now()
);
comment on table public.fin_costi is
  'Voci di costo Finance (modello CFO Cockpit). Solo admin, lettura e scrittura.';

alter table public.fin_costi enable row level security;
drop policy if exists finance_all on public.fin_costi;
create policy finance_all on public.fin_costi
  for all to authenticated
  using ((select public.ms_puo('finance')))
  with check ((select public.ms_puo('finance')));
revoke all on public.fin_costi from anon;
grant select, insert, update, delete on public.fin_costi to authenticated;

-- commissioni reali per rata (formule Notion "€ …", parse nel sync WF-M7)
alter table public.fin_incassi add column if not exists comm_venditore numeric;
alter table public.fin_incassi add column if not exists comm_setter    numeric;
alter table public.fin_incassi add column if not exists comm_pm        numeric;
alter table public.fin_incassi add column if not exists comm_mb        numeric;
alter table public.fin_incassi add column if not exists comm_bs        numeric;

-- ── seed: le voci pre-caricate del prototipo (fogli reali SV) ───────────────
-- Solo se la tabella è vuota; le voci DEMO nascono disattive (attivo=false).
insert into public.fin_costi (descrizione, reparto, ruolo, sottocategoria, categoria, importo, data, frequenza, note, attivo)
select * from (values
  -- costi fissi ricorrenti (software, struttura)
  ('Open AI',            'Fissi', null, 'AI',       'Operativi',   30::numeric, '2026-01-01'::date, 'mensile', null, true),
  ('Captions',           'Fissi', null, 'Software', 'Operativi',   21, '2026-01-01', 'mensile', null, true),
  ('Go High Level',      'Fissi', null, 'CRM',      'Operativi', 1890, '2026-01-01', 'mensile', 'Compresi messaggi delle beauty e chiamate dei setter', true),
  ('DropBox',            'Fissi', null, 'Software', 'Operativi',   15, '2026-01-01', 'mensile', null, true),
  ('CapCut',             'Fissi', null, 'Video',    'Operativi',   24, '2026-01-01', 'mensile', null, true),
  ('Hostinger',          'Fissi', null, 'Hosting',  'Operativi',  100, '2026-01-01', 'mensile', null, true),
  ('Lovable',            'Fissi', null, 'Software', 'Operativi',   21, '2026-01-01', 'mensile', null, true),
  ('Canva',              'Fissi', null, 'Design',   'Operativi',   12, '2026-01-01', 'mensile', null, true),
  ('Notion',             'Fissi', null, 'Software', 'Operativi',  130, '2026-01-01', 'mensile', null, true),
  ('Wassanger',          'Fissi', null, 'Software', 'Operativi',   35, '2026-01-01', 'mensile', null, true),
  ('Claude.ai',          'Fissi', null, 'AI',       'Operativi',  350, '2026-01-01', 'mensile', null, true),
  ('RailWayTaver',       'Fissi', null, 'Software', 'Operativi',   20, '2026-01-01', 'mensile', null, true),
  ('Google Workspace',   'Fissi', null, 'Software', 'Operativi',  100, '2026-01-01', 'mensile', null, true),
  ('Ufficio',            'Fissi', null, 'Affitti',  'Operativi', 1700, '2026-01-01', 'mensile', null, true),
  ('Sim Beauty Specialist', 'Fissi', null, 'Personale', 'Operativi', 150, '2026-01-01', 'mensile', null, true),
  ('Social Media Manager',  'Fissi', null, 'Personale', 'Operativi', 1000, '2026-01-01', 'mensile', null, true),
  ('Loom',               'Fissi', null, 'Software', 'Operativi',   20, '2026-01-01', 'mensile', null, true),
  ('Video Editor',       'Fissi', null, 'Personale', 'Operativi',   0, '2026-01-01', 'mensile', null, true),
  ('Streamyard',         'Fissi', null, 'Software', 'Operativi',   47, '2026-01-01', 'mensile', null, true),
  ('CRM4',               'Fissi', null, 'CRM',      'Operativi',  250, '2026-01-01', 'mensile', null, true),
  ('Elevenlabs',         'Fissi', null, 'Software', 'Operativi',   26, '2026-01-01', 'mensile', null, true),
  -- personale delivery (per ruolo)
  ('Simone',    'Delivery', 'Project Manager', 'Personale: Project Manager', 'Operativi', 1750, '2026-01-01', 'mensile', null, true),
  ('Samuele',   'Delivery', 'Project Manager', 'Personale: Project Manager', 'Operativi', 1750, '2026-01-01', 'mensile', null, true),
  ('Valentina', 'Delivery', 'Project Manager', 'Personale: Project Manager', 'Operativi', 1750, '2026-01-01', 'mensile', null, true),
  ('Antonio',   'Delivery', 'Project Manager', 'Personale: Project Manager', 'Operativi',  100, '2026-01-01', 'mensile', null, true),
  ('Gioele',    'Delivery', 'Project Manager', 'Personale: Project Manager', 'Operativi',    0, '2026-01-01', 'mensile', 'Importo da definire', true),
  ('Giuseppe',  'Delivery', 'Media Buyer', 'Personale: Media Buyer', 'Operativi', 1600, '2026-01-01', 'mensile', null, true),
  ('Daniele',   'Delivery', 'Media Buyer', 'Personale: Media Buyer', 'Operativi', 1200, '2026-01-01', 'mensile', null, true),
  ('Stefano',   'Delivery', 'Media Buyer', 'Personale: Media Buyer', 'Operativi', 1600, '2026-01-01', 'mensile', null, true),
  ('Guido',     'Delivery', 'Beauty Specialist', 'Personale: Beauty Specialist', 'Operativi', 0, '2026-01-01', 'mensile', 'Importo da definire', true),
  -- commerciali: solo commissioni (riga auto dal venduto)
  ('Giulio',     'Commerciale', null, 'Personale: Commerciale', 'Diretti', 0, '2026-01-01', 'mensile', 'Solo commissioni (auto)', true),
  ('Maria',      'Commerciale', null, 'Personale: Commerciale', 'Diretti', 0, '2026-01-01', 'mensile', 'Solo commissioni (auto)', true),
  ('Federico',   'Commerciale', null, 'Personale: Commerciale', 'Diretti', 0, '2026-01-01', 'mensile', 'Solo commissioni (auto)', true),
  ('Giada',      'Commerciale', null, 'Personale: Commerciale', 'Diretti', 0, '2026-01-01', 'mensile', 'Solo commissioni (auto)', true),
  ('Alessandro', 'Commerciale', null, 'Personale: Commerciale', 'Diretti', 0, '2026-01-01', 'mensile', 'Solo commissioni (auto)', true),
  ('Luca',       'Commerciale', null, 'Personale: Commerciale', 'Diretti', 0, '2026-01-01', 'mensile', 'Solo commissioni (auto)', true),
  -- staff struttura
  ('Sara',              'Fissi', null, 'Personale: Admin / HR', 'Operativi', 750, '2026-01-01', 'mensile', null, true),
  ('Giuseppe (staff)',  'Fissi', null, 'Personale: Admin / HR', 'Operativi', 500, '2026-01-01', 'mensile', null, true),
  ('Pietro',            'Fissi', null, 'Personale: Video / Content', 'Operativi', 500, '2026-01-01', 'mensile', '+ quota variabile', true),
  ('Valentina (extra)', 'Fissi', null, 'Personale: Staff', 'Operativi', 500, '2026-01-01', 'mensile', '+ quota variabile — ruolo da confermare', true),
  -- voci DEMO del prototipo: nascono DISATTIVE, da attivare con l'importo vero
  ('Team marketing Salone Vincente', 'Marketing', null, 'Team marketing', 'Diretti', 1200, '2026-01-01', 'mensile', 'DEMO — attiva con l''importo reale', false),
  ('Compenso amministratori (Matteo + Lorenzo + Leo)', 'Fissi', null, 'Compensi', 'Strutturali', 6000, '2026-01-01', 'mensile', 'DEMO — attiva con l''importo reale', false),
  ('Consulenze legali e fiscali', 'Fissi', null, 'Consulenze', 'Strutturali', 450, '2026-01-01', 'mensile', 'DEMO — attiva con l''importo reale', false)
) as v(descrizione, reparto, ruolo, sottocategoria, categoria, importo, data, frequenza, note, attivo)
where not exists (select 1 from public.fin_costi);
