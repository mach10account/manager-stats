-- manager-stats · Sezione Vendita — cutover: il webhook GHL scrive direttamente
--
-- Prima: GHL → webhook n8n → pagina Notion → sync orario → set_chiamate (ritardo fino a 1h).
-- Ora:   GHL → webhook n8n → set_chiamate (realtime). Notion resta solo come log
--        operativo e come sorgente di backfill/recupero manuale.
--
-- Le due sorgenti NON sono riconciliabili riga per riga: il created_time che l'API
-- Notion restituisce è troncato al MINUTO, e nei dati reali lo stesso setter richiama
-- lo stesso numero anche a 13 secondi di distanza — un vincolo di unicità al minuto
-- scarterebbe chiamate vere. Quindi: chiavi separate, una sola sorgente viva alla
-- volta (cutover 2026-07-29T12:05:00Z, applicato come guardia nel Code del backfill)
-- e colonna `fonte` per poter sempre verificare da dove viene una riga.

-- PK surrogata: le righe che arrivano dal webhook non hanno un notion_id.
alter table public.set_chiamate add column if not exists id uuid not null default gen_random_uuid();
update public.set_chiamate set id = notion_id where notion_id is not null and id <> notion_id;

alter table public.set_chiamate drop constraint if exists set_chiamate_pkey;
alter table public.set_chiamate add primary key (id);

alter table public.set_chiamate alter column notion_id drop not null;
alter table public.set_chiamate add constraint set_chiamate_notion_id_key unique (notion_id);

-- Idempotenza del writer webhook: id deterministico calcolato dal payload
-- (contatto | istante al secondo | setter | esito), così un retry HTTP di n8n
-- rimanda lo stesso id e non crea un doppione.
alter table public.set_chiamate add column if not exists evento_id text;
alter table public.set_chiamate add constraint set_chiamate_evento_id_key unique (evento_id);

alter table public.set_chiamate add column if not exists fonte text not null default 'notion';
comment on column public.set_chiamate.fonte is
  'webhook = push GHL in realtime (sola fonte dal cutover); notion = sync dal log (storico/backfill)';

-- Attribution: il payload del webhook porta già campagna/adset/ad/form del lead
-- (body.contact.attributionSource). Costa zero salvarla ora; recuperarla a posteriori
-- per le chiamate già passate sarebbe impossibile.
alter table public.set_chiamate add column if not exists fb_campaign_id text;
alter table public.set_chiamate add column if not exists fb_adset_id   text;
alter table public.set_chiamate add column if not exists fb_ad_id      text;
alter table public.set_chiamate add column if not exists fb_form_id    text;

create index if not exists set_chiamate_fonte_idx on public.set_chiamate (fonte, giorno);

-- ⚠️ Chi scrive DEVE dichiarare on_conflict, altrimenti PostgREST prova il conflitto
-- sulla PK `id` — che nessuno dei due writer invia — e ogni upsert diventa un insert:
--   webhook  → POST /rest/v1/set_chiamate?on_conflict=evento_id
--   backfill → POST /rest/v1/set_chiamate?on_conflict=notion_id
