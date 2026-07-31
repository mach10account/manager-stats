-- manager-stats · Migration 28 · Media buyer sui centri
--
-- DATABASE CLIENTI (Notion) ha la proprieta' MEDIA BUYER di tipo `person`,
-- esattamente come CONSULENTE: il nodo Notion di n8n la risolve a un'email.
-- Serve sia per filtrare in dashboard sia per lo scoping accessi (migration 29).
--
-- ⚠️ Il sync (wf TnTiV6uwKViJUwtc) e' stato aggiornato per mappare
-- `media_buyer: person(pick(j, 'property_media_buyer'))` e ha ora anche un
-- webhook per lanciarlo a mano: POST /webhook/ms-sync-centri-8f3a2c
--
-- ⚠️ 26 centri hanno un MEDIA BUYER che l'integrazione Notion non risolve
-- (utenti guest/rimossi): arrivano come NULL. Vanno riassegnati su Notion.

alter table public.centri add column if not exists media_buyer text;
comment on column public.centri.media_buyer is
  'Email media buyer (da Notion DATABASE CLIENTI > MEDIA BUYER, tipo person).';
create index if not exists centri_media_buyer_idx on public.centri (media_buyer);
