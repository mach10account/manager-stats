-- 20260730_23: Report attività #/vendita — esiti derivati dagli stage GHL,
-- classificati e divisi ESATTAMENTE come il foglio KPI CAMPAGNE
-- (docs.google.com/spreadsheets/d/1kA4vEUNapAzlxc_lMr6fVEpr2zZ4JUa7u6GXykp5Nv4, gid 1285553324).
-- I bucket del foglio (colonne R,T,V,Y,Z,AA,AB) sono COUNTIFS con wildcard sui nomi stage:
--   Appuntamenti  = appuntamento fissato, app. fissato, fissato 2*/3* app, rifissato, no show,
--                   attesa risposta, in attesa esito appuntamento, trattativa non conclusa - follow up,
--                   contratto inviato, chiuso (contratto firmato), chiuso (pagato), vendita non chiusa
--   Show          = attesa risposta, trattativa non conclusa - follow up, contratto inviato,
--                   chiuso (contratto firmato), chiuso (pagato), fissato 2*/3* app, vendita non chiusa
--   Chiusure      = chiuso (contratto firmato)
--   No show       = no show
--   SCARTI        = non in target, fake, non interessato, fatturato < 5k
--   NON RISPOSTO  = non risp, mai risposto
--   DA RICHIAMARE = da richiamare in giornata, richiamare domani, richiamo nei prossimi giorni,
--                   richiamare in futuro, primo approccio effettuato
-- Le funzioni set_stage_*_foglio replicano quei wildcard (ilike): uno stage NUOVO viene
-- auto-classificato come lo classificherebbe il foglio. set_stage_class resta l'override
-- manuale (Table Editor): se la riga esiste, vince sulla funzione.
-- Eccezioni volute (fuori foglio): RINNOVO 1 e UPSELL restano bucket chiuso_pagato SOLO per
-- alimentare le righe € (Incassato/Contrattualizzato); non contano in nessun conteggio esiti.

-- ── 1. classificazione a pattern (i wildcard del foglio) ─────────────────────
create or replace function public.set_stage_bucket_foglio(p_nome text)
returns text language sql immutable as $$
  select case
    when p_nome is null then null
    when p_nome ilike '%non risp%' or p_nome ilike '%mai risposto%' then 'non_risposto'
    when p_nome ilike '%da richiamare in giornata%'
      or p_nome ilike '%richiamare domani%'
      or p_nome ilike '%richiamo nei prossimi giorni%'
      or p_nome ilike '%richiamare in futuro%'
      or p_nome ilike '%primo approccio effettuato%' then 'da_richiamare'
    when p_nome ilike '%non in target%'
      or p_nome ilike '%fake%'
      or p_nome ilike '%non interessato%'
      or p_nome ilike '%fatturato < 5k%' then 'scarto'
    when p_nome ilike '%no show%' then 'noshow'
    when p_nome ilike '%chiuso (contratto firmato)%' then 'chiuso_firmato'
    when p_nome ilike '%chiuso (pagato)%' then 'chiuso_pagato'
    when p_nome ilike '%appuntamento fissato%'
      or p_nome ilike '%app. fissato%'
      or p_nome ilike '%rifissato%'
      or p_nome ilike '%fissato 2%app%'
      or p_nome ilike '%fissato 3%app%' then 'fissato'
    when p_nome ilike '%attesa risposta%'
      or p_nome ilike '%in attesa esito appuntamento%'
      or p_nome ilike '%trattativa non conclusa - follow up%'
      or p_nome ilike '%contratto inviato%'
      or p_nome ilike '%vendita non chiusa%' then 'show'
    else null
  end
$$;

-- Show del foglio (AB2): 8 pattern. NB: RIFISSATO, "In attesa esito appuntamento",
-- RINNOVO 1 e UPSELL NON contano come Show (decisioni Leo 2026-07-28 recepite dal foglio).
create or replace function public.set_stage_show_foglio(p_nome text)
returns boolean language sql immutable as $$
  select p_nome ilike '%attesa risposta%'
      or p_nome ilike '%trattativa non conclusa - follow up%'
      or p_nome ilike '%contratto inviato%'
      or p_nome ilike '%chiuso (contratto firmato)%'
      or p_nome ilike '%chiuso (pagato)%'
      or p_nome ilike '%fissato 2%app%'
      or p_nome ilike '%fissato 3%app%'
      or p_nome ilike '%vendita non chiusa%'
$$;

-- Appuntamenti del foglio (R2): i 13 pattern = gli 8 dello Show + i 5 qui sotto.
-- NB: App. Prenotato Diretto/Ai e le varianti LEAD MAGNET sono ESCLUSE (come nel foglio).
create or replace function public.set_stage_app_foglio(p_nome text)
returns boolean language sql immutable as $$
  select public.set_stage_show_foglio(p_nome)
      or p_nome ilike '%appuntamento fissato%'
      or p_nome ilike '%app. fissato%'
      or p_nome ilike '%rifissato%'
      or p_nome ilike '%no show%'
      or p_nome ilike '%in attesa esito appuntamento%'
$$;

-- ── 2. set_stage_class: nuova colonna + re-seed allineato al foglio ──────────
alter table public.set_stage_class
  add column if not exists conta_appuntamento boolean not null default false;

delete from public.set_stage_class;

insert into public.set_stage_class (nome, bucket, conta_show, conta_appuntamento)
select distinct nome,
       coalesce(public.set_stage_bucket_foglio(nome), 'altro'),
       coalesce(public.set_stage_show_foglio(nome), false),
       coalesce(public.set_stage_app_foglio(nome), false)
from public.set_stage_ghl;

-- eccezioni: rinnovi/upsell alimentano solo le righe € del report
update public.set_stage_class
   set bucket = 'chiuso_pagato', conta_show = false, conta_appuntamento = false
 where nome in ('RINNOVO 1', 'UPSELL');

-- ── 3. v_set_opportunita: override tabella → fallback pattern foglio ─────────
create or replace view public.v_set_opportunita with (security_invoker = on) as
select o.id, o.ghl_contact_id, o.pipeline_id, o.stage_id, o.status, o.valore,
       o.creata_a, o.cambio_stage_a, o.assegnato_a, o.nome, o.sync_a, o.followers,
       s.nome as stage,
       coalesce(c.bucket, public.set_stage_bucket_foglio(s.nome), 'altro') as bucket,
       coalesce(c.conta_show, public.set_stage_show_foglio(s.nome), false) as conta_show,
       coalesce(c.conta_appuntamento, public.set_stage_app_foglio(s.nome), false) as conta_appuntamento
from public.set_opportunita o
left join public.set_stage_ghl s on s.stage_id = o.stage_id
left join public.set_stage_class c on c.nome = s.nome
where o.pipeline_id = 'nHTTgDtROCWErBW9DNOZ';

-- ── 4. api_set_funnel v5: righe = i bucket del foglio ────────────────────────
-- Cambiano: Non risposto / Da richiamare / Scarti / Appuntamenti fissati ora vengono
-- dagli STAGE dell'opportunità (prima erano esiti-chiamata dichiarati dal setter);
-- Presentati = Show del foglio; Chiusure = solo contratto firmato (come il foglio).
-- Gli esiti-chiamata dichiarati restano visibili nella card "Esiti nel periodo".
create or replace function public.api_set_funnel(p_from date, p_to date, p_setter text default null)
returns table(gruppo text, ordine integer, metrica text, valore numeric)
language sql stable as $$
with primo as (
  select ghl_contact_id, min(creata_a)::date as primo_giorno
  from public.set_chiamate group by 1
),
gc as (
  select ghl_contact_id,
         case when primo_giorno between p_from and p_to then 'NUOVI' else 'VECCHI' end as gruppo
  from primo
),
ch as (
  select v.*, coalesce(g.gruppo,'NUOVI') as gruppo
  from public.v_set_chiamate v
  left join gc g on g.ghl_contact_id = v.ghl_contact_id
  where v.giorno between p_from and p_to
    and (p_setter is null or v.setter = p_setter)
),
attr_chiamata as (
  select distinct on (ghl_contact_id) ghl_contact_id, setter
  from public.v_set_chiamate
  order by ghl_contact_id, e_appuntamento desc, creata_a desc
),
opp as (
  select o.*,
         case
           when g.gruppo is not null then g.gruppo
           when o.creata_a::date between p_from and p_to then 'NUOVI'
           else 'VECCHI'
         end as gruppo
  from public.v_set_opportunita o
  left join gc g on g.ghl_contact_id = o.ghl_contact_id
  where p_setter is null
     or exists (select 1 from public.set_utenti_ghl u
                where u.user_id = any(o.followers) and u.nome = p_setter)
     or (coalesce(array_length(o.followers, 1), 0) = 0
         and exists (select 1 from attr_chiamata a
                     where a.ghl_contact_id = o.ghl_contact_id and a.setter = p_setter))
),
m as (
  select gruppo, 1 as ordine, 'Chiamati' as metrica, count(distinct ghl_contact_id)::numeric as valore from ch group by 1
  union all select gruppo, 2, 'Non risposto',
    count(*) filter (where bucket = 'non_risposto' and cambio_stage_a::date between p_from and p_to)::numeric from opp group by 1
  union all select gruppo, 3, 'Da richiamare',
    count(*) filter (where bucket = 'da_richiamare' and cambio_stage_a::date between p_from and p_to)::numeric from opp group by 1
  union all select gruppo, 4, 'Scarti (non in target / non interessato / fake)',
    count(*) filter (where bucket = 'scarto' and cambio_stage_a::date between p_from and p_to)::numeric from opp group by 1
  union all select gruppo, 5, 'Appuntamenti fissati',
    count(*) filter (where conta_appuntamento and cambio_stage_a::date between p_from and p_to)::numeric from opp group by 1
  union all select gruppo, 6, 'Appuntamenti da svolgere',
    count(*) filter (where bucket = 'fissato' and status = 'open'
                     and cambio_stage_a::date between p_from and p_to)::numeric from opp group by 1
  union all select gruppo, 7, 'Appuntamenti presentati (Show)',
    count(*) filter (where conta_show and cambio_stage_a::date between p_from and p_to)::numeric from opp group by 1
  union all select gruppo, 8, 'No show',
    count(*) filter (where bucket = 'noshow' and cambio_stage_a::date between p_from and p_to)::numeric from opp group by 1
  union all select gruppo, 9, 'Chiusure (contratto firmato)',
    count(*) filter (where bucket = 'chiuso_firmato' and cambio_stage_a::date between p_from and p_to)::numeric from opp group by 1
  union all select gruppo, 10, 'Contrattualizzato €',
    coalesce(sum(valore) filter (where bucket in ('chiuso_firmato','chiuso_pagato') and cambio_stage_a::date between p_from and p_to),0) from opp group by 1
  union all select gruppo, 11, 'Incassato €',
    coalesce(sum(valore) filter (where bucket = 'chiuso_pagato' and cambio_stage_a::date between p_from and p_to),0) from opp group by 1
)
select * from m order by ordine, gruppo
$$;
