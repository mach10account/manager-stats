-- manager-stats · Performance: la dashboard era diventata lenta dopo gli accessi per sezione.
--
-- Misure prima/dopo (finestra 30 giorni, ruolo authenticated, RLS attiva):
--   Beauty  agg_setter_giorno        1014 ms → 135 ms
--   Vendita agg_set_setter_giorno     989 ms →  41 ms
--   Vendita api_set_funnel            246 ms → 177 ms
--   Vendita set_esiti_setter          132 ms →  42 ms
--   Vendita api_set_contatti_unici    130 ms →  39 ms
--
-- ── 1. LA CAUSA PRINCIPALE: ms_puo() valutata per riga ───────────────────────
-- Introdotta con la migration 18. EXPLAIN su agg_set_setter_giorno mostrava
--   Index Scan on set_chiamate ... Filter: ms_puo('vendita')  (actual 778 ms, 18.518 righe)
-- cioè 778 ms su 989 spesi a rivalutare la stessa funzione per ogni riga. Anche se è
-- STABLE, dentro una policy Postgres non la promuove a costante.
-- Fix: avvolgerla in (select ...) → diventa un InitPlan, valutato UNA volta per query.
-- Stessa semantica, nessun effetto sulla sicurezza. È il pattern raccomandato da Supabase.
do $$
declare
  t text; area text;
  aree jsonb := jsonb_build_object(
    'comune',  jsonb_build_array('centri'),
    'mkt',     jsonb_build_array('mkt_leads','mkt_esiti','appuntamenti','perf_giorno',
                                 'fb_insights_ad','fb_account_map','fb_campaign_class','centro_map'),
    'beauty',  jsonb_build_array('calls','leads','esiti','operators','campaigns'),
    'vendita', jsonb_build_array('set_chiamate','set_chiamate_ghl','set_esiti','set_setter_map',
                                 'set_utenti_ghl','set_opportunita','set_stage_ghl','set_stage_class')
  );
begin
  for area in select jsonb_object_keys(aree) loop
    for t in select jsonb_array_elements_text(aree -> area) loop
      execute format('drop policy if exists authenticated_read on public.%I', t);
      execute format('create policy authenticated_read on public.%I for select to authenticated using ((select public.ms_puo(%L)))', t, area);
    end loop;
  end loop;
end $$;

drop policy if exists ms_accessi_read on public.ms_accessi;
create policy ms_accessi_read on public.ms_accessi for select to authenticated
  using (user_id = (select auth.uid()) or (select public.ms_puo('admin')));

-- ── 2. v_set_chiamate: via la window function ────────────────────────────────
-- `primo_contatto` era `creata_a = min(creata_a) over (partition by ghl_contact_id)`.
-- Una window obbliga a leggere e ordinare TUTTE le righe prima di poter applicare il
-- filtro sul periodo: "Rows Removed by Filter: 14021" per ottenerne 4.497.
-- La subquery correlata dà lo stesso risultato ma lascia passare il filtro per primo,
-- e il min() diventa un lookup su set_chiamate_contatto_idx.
--
-- ⚠️ Corregge anche un BUG PREESISTENTE: "primi contatti" sovrastimava del 12,7%
-- (3.194 righe marcate per 2.835 contatti). Il log Notion tronca il created_time al
-- MINUTO, quindi due chiamate allo stesso contatto nello stesso minuto avevano lo
-- stesso creata_a ed erano marcate ENTRAMBE come prima. Il tie-break sulla PK `id`
-- garantisce esattamente una riga per contatto (verificato: 2.836 = 2.836).
-- NB: il tie-break DEVE essere `id`, non `notion_id` — le righe scritte dal webhook
-- GHL hanno notion_id NULL (migration 14) e restavano senza primo contatto.
create or replace view public.v_set_chiamate
with (security_invoker = on) as
select
  c.notion_id, c.creata_a, c.giorno, c.ora_locale, c.ghl_contact_id, c.nome_cliente, c.centro,
  coalesce(m.setter, nullif(initcap(trim(c.setter_raw)), '')) as setter,
  c.setter_raw, c.esito,
  coalesce(e.e_risposta,     c.esito is not null and c.esito <> 'Non risp') as e_risposta,
  coalesce(e.e_appuntamento, false)                                        as e_appuntamento,
  coalesce(e.e_conferma,     false)                                        as e_conferma,
  coalesce(e.e_scarto,       false)                                        as e_scarto,
  (c.id = (select s.id from public.set_chiamate s
           where s.ghl_contact_id = c.ghl_contact_id
           order by s.creata_a, s.id limit 1))                             as primo_contatto
from public.set_chiamate c
left join public.set_setter_map m on m.setter_raw = c.setter_raw
left join public.set_esiti      e on e.esito      = c.esito;

-- ── 3. Beauty: indice funzionale sul cast ────────────────────────────────────
-- Le viste della sezione filtrano con `(start_date)::date between ...`: il cast rende
-- inutilizzabile un indice sulla colonna. EXPLAIN mostrava
--   Seq Scan on calls ... Rows Removed by Filter: 168062   (471 ms)
-- per arrivare alle 16.766 righe del periodo.
create index if not exists calls_start_date_giorno_idx on public.calls (((start_date)::date));
analyze public.calls;

-- Restano ~500 ms su v_panoramica_centro e v_drilldown_ad (Panoramica/Marketing) e
-- ~300 ms su lead_call_distribution: quelle viste ricalcolano l'ultimo esito per lead
-- scorrendo tutte le 184k chiamate senza poter usare il filtro data. Si risolvono solo
-- ristrutturandole o materializzandole — non toccate qui.
