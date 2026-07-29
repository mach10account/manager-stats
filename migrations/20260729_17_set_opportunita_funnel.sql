-- manager-stats · Sezione Vendita — funnel opportunità GHL + report NUOVI/VECCHI
-- (applicata in 2 step: set_opportunita_funnel + api_set_funnel_v2_da_svolgere)
--
-- Risponde al modulo giornaliero dei setter: per NUOVI e VECCHI lead →
-- chiamati, non risposte, da richiamare, non in target, fake, app fissati,
-- da svolgere, presentati, no show, chiusure, contrattualizzato €, incassato €.
--
-- Fonti: le righe chiamata da set_chiamate (esiti setter); il funnel appuntamenti
-- dalle OPPORTUNITÀ GHL (pipeline GENERALE nHTTgDtROCWErBW9DNOZ + VENDITA
-- 4dSlaEno0A5CbMcrZyDk), lette con il PIT via opportunities/search.
-- I calendari GHL sarebbero la fonte ideale per "da svolgere" (hanno data e
-- appointmentStatus) ma NESSUN token disponibile ha lo scope calendars → 401.

create table if not exists public.set_opportunita (
  id             text primary key,
  ghl_contact_id text,
  pipeline_id    text,
  stage_id       text,
  status         text,
  valore         numeric,                     -- monetaryValue: POPOLATO sulle chiusure (verificato: 242.900 € su firmati)
  creata_a       timestamptz,
  cambio_stage_a timestamptz,                 -- quando è entrata nello stage ATTUALE
  assegnato_a    text,
  nome           text,
  sync_a         timestamptz not null default now()
);
create index if not exists set_opportunita_contact_idx on public.set_opportunita (ghl_contact_id);
create index if not exists set_opportunita_stage_idx   on public.set_opportunita (stage_id);
create index if not exists set_opportunita_cambio_idx  on public.set_opportunita (cambio_stage_a);

-- stage id → nome, riscritta dal sync a ogni giro (si auto-mantiene sui rename)
create table if not exists public.set_stage_ghl (
  stage_id    text primary key,
  pipeline_id text,
  nome        text not null
);

-- Classificazione degli stage per NOME — è la tabella da EDITARE se cambia il
-- significato di uno stage. bucket: fissato|show|noshow|chiuso_firmato|chiuso_pagato|
-- non_target|fake|altro. conta_show = lo stage implica che l'appuntamento si è svolto
-- (bucket "Show" del foglio KPI: include chiusi e ri-fissati 2*/3*, perché un secondo
-- appuntamento implica che il primo si è presentato). Gli stage nuovi non classificati
-- cadono in 'altro' e restano visibili con: select nome from set_stage_ghl where nome
-- not in (select nome from set_stage_class);
create table if not exists public.set_stage_class (
  nome       text primary key,
  bucket     text not null default 'altro',
  conta_show boolean not null default false
);
-- (seed dei 31 stage classificati: vedi migration applicata set_opportunita_funnel)

-- Il report: RPC api_set_funnel(p_from, p_to) → (gruppo, ordine, metrica, valore).
-- Definizioni:
--   NUOVO   = contatto la cui PRIMA chiamata di sempre cade nel periodo
--             (mai chiamato → opportunità creata nel periodo).
--   Chiamati = contatti unici; le altre righe chiamata = conteggio esiti.
--   "Non in target" non esiste come esito chiamata (è uno stage pipeline):
--             la riga 4 usa l'esito "Non interessato".
--   Funnel  = stage ATTUALE + cambio_stage_a nel periodo ("presentati" = sta in uno
--             stage post-show ED è entrata lì nel periodo). Senza lo storico delle
--             transizioni un'opp che attraversa due stati nel periodo conta solo
--             nell'ultimo.
--   Da svolgere = entrata in uno stage 'fissato' NEL periodo e ancora lì (v2 —
--             la v1 contava tutto lo stock accumulato: 650 opp ferme da mesi).
--   Contrattualizzato = Σ monetaryValue chiusi (firmato+pagato) nel periodo;
--   Incassato = Σ monetaryValue solo Chiuso (Pagato) [+RINNOVO/UPSELL].
--
-- Sync: wf Kv2dQ2MnfARdAJUq — refresh COMPLETO orario (:50) di entrambe le pipeline
-- (~60 pagine; niente watermark: lo stage di un'opp vecchia può cambiare in qualsiasi
-- momento e added_desc non la farebbe mai riemergere) + webhook on-demand
-- GET /webhook/sync-opportunita-ghl-4b7e.
--
-- ⚠️ n8n 2.32: attivazione workflow SOLO via API pubblica dalla VPS
--    (n8n-mcp partial update rotto — vedi memoria reference_n8n_mcp_partial_update_broken_232).
