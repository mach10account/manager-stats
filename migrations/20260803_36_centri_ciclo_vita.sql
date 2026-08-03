-- Finance · ciclo di vita del cliente, per KPI Delivery e LTV & Retention.
-- Da Notion DATABASE CLIENTI via WF-M1 (TnTiV6uwKViJUwtc):
--   INIZIO SERVIZIO / FINE SERVIZIO → durata cliente, tasso di rinnovo per competenza
--   DATA RINNOVO                    → ultimo rinnovo
--   BEAUTY (person)                 → classifica beauty specialist
-- Area 'comune' come il resto di centri: nessuna nuova policy.
alter table public.centri add column if not exists inizio_servizio date;
alter table public.centri add column if not exists fine_servizio   date;
alter table public.centri add column if not exists data_rinnovo    date;
alter table public.centri add column if not exists beauty          text;

create index if not exists idx_centri_fine_servizio on public.centri (fine_servizio);
