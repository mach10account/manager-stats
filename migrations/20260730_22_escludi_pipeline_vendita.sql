-- manager-stats · La PIPELINE VENDITA esce da tutte le statistiche
--
-- VERIFICA FATTA PRIMA DI RIMUOVERLA (per non perdere chiusure o importi):
--   bucket           GENERALE                  VENDITA
--   chiuso_firmato    81 opp · 242.900 €        0
--   chiuso_pagato     23 opp · 131.950 €        0
--   show             241 opp                    0
--   noshow           206 opp                    0
--   fissato          683 opp                  106 opp · 0 €
--
-- Cioè: la pipeline VENDITA contiene SOLO opportunità in stato "fissato" e ZERO valore.
-- Sono i doppioni già osservati (106 opp per 42 persone = 2,52 a testa) creati quando il
-- setter fissa l'appuntamento. Tutto il funnel vero — presentati, no show, chiusure e
-- importi — vive in PIPELINE GENERALE.
--
-- EFFETTO sul report nuovi/vecchi (30 giorni):
--   Appuntamenti da svolgere   156 → 57   (era gonfiato del 174%)
--   Presentati, no show, chiusure, contrattualizzato, incassato  → INVARIATI
--
-- Il filtro sta nella VISTA, non nella tabella: `set_opportunita` continua a ricevere e
-- conservare entrambe le pipeline dal sync orario, così il dato grezzo resta disponibile
-- per capire perché GHL duplica. Tutto ciò che è costruito sopra la vista — api_set_funnel
-- incluso — vede solo la pipeline di lavoro.
-- (v_set_speed_to_lead legge set_opportunita direttamente ed è già filtrata, migration 21.)

create or replace view public.v_set_opportunita
with (security_invoker = on) as
select
  o.*, s.nome as stage,
  coalesce(c.bucket, 'altro') as bucket,
  coalesce(c.conta_show, false) as conta_show
from public.set_opportunita o
left join public.set_stage_ghl   s on s.stage_id = o.stage_id
left join public.set_stage_class c on c.nome = s.nome
where o.pipeline_id = 'nHTTgDtROCWErBW9DNOZ';   -- solo PIPELINE GENERALE

-- Se un domani la pipeline VENDITA tornasse a essere usata davvero (chiusure e importi
-- registrati lì), basta togliere la clausola WHERE — ma prima va risolta la
-- duplicazione lato GHL, altrimenti i conteggi tornano gonfiati.
