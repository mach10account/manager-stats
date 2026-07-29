-- manager-stats · Sezione VENDITA — warehouse chiamate SETTER B2B
--
-- Fonte: Notion "📞 LOG CHIAMATE SETTER" 2d13e1b827ed80bfab31e1d0beed2dfa
--        (1 riga = 1 chiamata, scritta in realtime dal webhook GHL nel wf yF29o3ERSogEJ5lw).
-- NON usiamo "📆 RESOCONTO GIORNALIERO SETTER" 2d23e1b8…: è un rollup serale delle 19:00
-- con perdita delle chiamate serali, NOME CENTRO sempre vuoto, AGENZIA hardcoded,
-- doppioni lead/giorno quando 2 setter chiamano lo stesso contatto ed esito "migliore"
-- al posto di "ultimo". Qui ricalcoliamo tutto dalle righe grezze.
--
-- Prefisso set_ (setter B2B), distinto da calls/operators (call center beauty CRM4).

-- ── 1. tabella grezza ────────────────────────────────────────────────────────
create table if not exists public.set_chiamate (
  notion_id      uuid primary key,                 -- id pagina Notion = idempotenza del sync
  creata_a       timestamptz not null,             -- created_time della pagina (= istante chiamata)
  giorno         date generated always as
                   (((creata_a at time zone 'Europe/Rome'))::date) stored,
  ora_locale     smallint generated always as
                   (extract(hour from (creata_a at time zone 'Europe/Rome'))::smallint) stored,
  ghl_contact_id text,                             -- title "ID CLIENTE" (contatto GHL)
  nome_cliente   text,
  telefono       text,
  centro         text,                             -- "NOME CENTRO O STUDIO"
  setter_raw     text,                             -- customData.caller, testo libero
  esito          text,                             -- select "ESITO DELLA CHIAMATA"
  agenzia        text,
  sync_a         timestamptz not null default now()
);

create index if not exists set_chiamate_giorno_idx   on public.set_chiamate (giorno);
create index if not exists set_chiamate_contatto_idx on public.set_chiamate (ghl_contact_id, creata_a);
create index if not exists set_chiamate_setter_idx   on public.set_chiamate (setter_raw);

comment on table public.set_chiamate is
  'Chiamate dei setter B2B (1 riga = 1 chiamata). Sync da Notion LOG CHIAMATE SETTER 2d13… via n8n.';

-- ── 2. normalizzazione nomi setter ───────────────────────────────────────────
-- SETTER in Notion è testo libero: "Matilde b" e "Matilde battocchi" sono la stessa
-- persona e producevano due righe distinte in ogni classifica. La mappa è editabile
-- a mano (insert) senza toccare i dati grezzi.
create table if not exists public.set_setter_map (
  setter_raw text primary key,
  setter     text not null,
  attivo     boolean not null default true
);

comment on table public.set_setter_map is
  'Alias setter → nome canonico. Chi non è in mappa passa con initcap(trim(setter_raw)).';

insert into public.set_setter_map (setter_raw, setter) values
  ('Matilde b',          'Matilde Battocchi'),
  ('Matilde battocchi',  'Matilde Battocchi'),
  ('Sara gc',            'Sara GC'),
  ('MATTEO CARASSO1',    'Matteo Carasso'),
  ('Mike Mike',          'Mike')
on conflict (setter_raw) do nothing;

-- ── 3. classificazione esiti ─────────────────────────────────────────────────
-- Vocabolario del db sorgente: Appuntamento fissato · App fissato Ai/ VSL ·
-- conferma appuntamento · Da richiamare · Non interessato · Non risp · Fake.
--   risposta        = il titolare ha risposto (tutto tranne "Non risp")
--   appuntamento    = appuntamento NUOVO fissato (la conferma NON conta: è un
--                     appuntamento già esistente che viene riconfermato)
--   conferma        = "conferma appuntamento"
--   scarto          = Non interessato / Fake (lead chiuso)
create table if not exists public.set_esiti (
  esito           text primary key,
  e_risposta      boolean not null default true,
  e_appuntamento  boolean not null default false,
  e_conferma      boolean not null default false,
  e_scarto        boolean not null default false
);

insert into public.set_esiti (esito, e_risposta, e_appuntamento, e_conferma, e_scarto) values
  ('Appuntamento fissato',  true,  true,  false, false),
  ('App fissato Ai/ VSL',   true,  true,  false, false),
  ('conferma appuntamento', true,  false, true,  false),
  ('Da richiamare',         true,  false, false, false),
  ('Non interessato',       true,  false, false, true),
  ('Fake',                  true,  false, false, true),
  ('Non risp',              false, false, false, false)
on conflict (esito) do nothing;

-- ── 4. vista chiamata arricchita ─────────────────────────────────────────────
-- primo_contatto = è la primissima chiamata mai fatta a quel contatto (calcolata
-- sulla storia completa, non su "esisteva prima di oggi" come faceva il rollup).
create or replace view public.v_set_chiamate
with (security_invoker = on) as
select
  c.notion_id,
  c.creata_a,
  c.giorno,
  c.ora_locale,
  c.ghl_contact_id,
  c.nome_cliente,
  c.centro,
  coalesce(m.setter, nullif(initcap(trim(c.setter_raw)), '')) as setter,
  c.setter_raw,
  c.esito,
  coalesce(e.e_risposta,     c.esito is not null and c.esito <> 'Non risp') as e_risposta,
  coalesce(e.e_appuntamento, false)                                        as e_appuntamento,
  coalesce(e.e_conferma,     false)                                        as e_conferma,
  coalesce(e.e_scarto,       false)                                        as e_scarto,
  (c.creata_a = min(c.creata_a) over (partition by c.ghl_contact_id))       as primo_contatto
from public.set_chiamate c
left join public.set_setter_map m on m.setter_raw = c.setter_raw
left join public.set_esiti      e on e.esito      = c.esito;

-- ── 5. aggregato per setter × giorno (la vista che legge il frontend) ────────
-- Nessun ratio memorizzato: il client li ricalcola dai totali del periodo
-- (stessa regola del resto della piattaforma — mai media di ratio per-riga).
create or replace view public.agg_set_setter_giorno
with (security_invoker = on) as
select
  giorno,
  setter,
  count(*)                                              as chiamate,
  count(distinct ghl_contact_id)                        as contatti,
  count(*) filter (where e_risposta)                    as risposte,
  count(*) filter (where e_appuntamento)                as appuntamenti,
  count(*) filter (where e_conferma)                    as conferme,
  count(*) filter (where e_scarto)                      as scarti,
  count(*) filter (where esito = 'Da richiamare')       as da_richiamare,
  count(*) filter (where esito = 'Non interessato')     as non_interessati,
  count(*) filter (where esito = 'Fake')                as fake,
  count(*) filter (where not e_risposta)                as non_risposte,
  count(*) filter (where primo_contatto)                as primi_contatti,
  count(distinct ghl_contact_id) filter (where e_appuntamento) as contatti_con_app
from public.v_set_chiamate
group by giorno, setter;

-- ── 6. breakdown esiti per setter (modale di dettaglio) ─────────────────────
create or replace view public.set_esiti_setter
with (security_invoker = on) as
select giorno, setter, esito, count(*) as n
from public.v_set_chiamate
group by giorno, setter, esito;

-- ── 7. distribuzione oraria (quando conviene chiamare) ──────────────────────
create or replace view public.agg_set_ora
with (security_invoker = on) as
select
  giorno,
  ora_locale,
  count(*)                              as chiamate,
  count(*) filter (where e_risposta)    as risposte,
  count(*) filter (where e_appuntamento) as appuntamenti
from public.v_set_chiamate
group by giorno, ora_locale;

-- ── 8. quante chiamate servono per fissare (istogramma tentativi) ───────────
-- Per ogni contatto: n° tentativi totali e se è mai stato fissato.
create or replace view public.v_set_contatti
with (security_invoker = on) as
select
  ghl_contact_id,
  min(creata_a)::date                          as primo_giorno,
  max(creata_a)::date                          as ultimo_giorno,
  count(*)                                     as tentativi,
  bool_or(e_appuntamento)                      as fissato,
  bool_or(e_scarto)                            as scartato,
  count(*) filter (where e_risposta)           as risposte
from public.v_set_chiamate
group by ghl_contact_id;

-- ── 9. permessi (stesso schema del resto: anon niente, authenticated read) ──
alter table public.set_chiamate   enable row level security;
alter table public.set_setter_map enable row level security;
alter table public.set_esiti      enable row level security;

do $$
begin
  if not exists (select 1 from pg_policy where polname = 'authenticated_read'
                 and polrelid = 'public.set_chiamate'::regclass) then
    create policy authenticated_read on public.set_chiamate for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policy where polname = 'authenticated_read'
                 and polrelid = 'public.set_setter_map'::regclass) then
    create policy authenticated_read on public.set_setter_map for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policy where polname = 'authenticated_read'
                 and polrelid = 'public.set_esiti'::regclass) then
    create policy authenticated_read on public.set_esiti for select to authenticated using (true);
  end if;
end $$;

revoke all on public.set_chiamate, public.set_setter_map, public.set_esiti from anon;
revoke all on public.v_set_chiamate, public.agg_set_setter_giorno, public.set_esiti_setter,
              public.agg_set_ora, public.v_set_contatti from anon;

grant select on public.set_chiamate, public.set_setter_map, public.set_esiti,
                public.v_set_chiamate, public.agg_set_setter_giorno, public.set_esiti_setter,
                public.agg_set_ora, public.v_set_contatti to authenticated;
