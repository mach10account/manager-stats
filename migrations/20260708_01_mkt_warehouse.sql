-- manager-stats · Fase 0 · warehouse marketing
-- Tabelle mirror Notion (LEAD CLIENTI / APPUNTAMENTI / CLIENTI / PERFORMANCE) + FB insights ad-level.
-- Convenzioni: PK = id nativo della fonte; nessun ratio memorizzato (solo viste);
-- timestamptz + bucketing Europe/Rome nelle viste; RLS on (n8n scrive con service key).

-- ── 1. centri (dim, mirror DATABASE CLIENTI ~200 righe) ─────────────────────
create table public.centri (
  notion_id          uuid primary key,
  nome               text not null,
  fb_ad_account_id   text,
  fb_page_id         text,
  agenzia            text[] not null default '{}',
  stato_attivita     text[] not null default '{}',
  consulente         text,
  notion_last_edited timestamptz,
  synced_at          timestamptz not null default now()
);
-- niente UNIQUE: due centri possono condividere lo stesso ad account (caso reale)
create index centri_fb_act_idx on public.centri (fb_ad_account_id);

-- ── 2. mkt_leads (fact, mirror DATABASE LEAD CLIENTI ~53k righe) ─────────────
create table public.mkt_leads (
  notion_id          uuid primary key,
  fb_lead_id         text,
  crm4_lead_id       bigint,
  centro_id          uuid,
  creazione          timestamptz not null,
  esito              text,
  setter             text,
  fonte_ingresso     text,
  ad_account         text,
  campaign_name      text,
  campaign_id        text,
  adset_name         text,
  adset_id           text,
  ad_name            text,
  ad_id              text,
  notion_last_edited timestamptz,
  synced_at          timestamptz not null default now()
);
create index mkt_leads_centro_creazione_idx on public.mkt_leads (centro_id, creazione);
create index mkt_leads_ad_idx        on public.mkt_leads (ad_id);
create index mkt_leads_campaign_idx  on public.mkt_leads (campaign_id);
create index mkt_leads_crm4_idx      on public.mkt_leads (crm4_lead_id);
create index mkt_leads_edited_idx    on public.mkt_leads (notion_last_edited);

-- ── 3. appuntamenti (fact, mirror DATABASE APPUNTAMENTI) ─────────────────────
create table public.appuntamenti (
  notion_id          uuid primary key,
  gcal_event_id      text,
  lead_id            uuid,   -- → mkt_leads.notion_id (no hard FK: ordine di sync non garantito)
  centro_id          uuid,
  data_appuntamento  timestamptz,
  data_presa         timestamptz,
  data_acconto       timestamptz,
  esito_prenotazione text,
  show_status        text,   -- 'SHOW' | 'NO SHOW' | null (futuro/non compilato)
  pacchetto          text,   -- 'SI' | 'NO' | 'INDEFINITO' | null
  ammontare_oggi     numeric(12,2),
  valore_pacchetto   numeric(12,2),
  notion_last_edited timestamptz,
  synced_at          timestamptz not null default now()
);
create index appuntamenti_lead_idx        on public.appuntamenti (lead_id);
create index appuntamenti_centro_data_idx on public.appuntamenti (centro_id, data_appuntamento);
create index appuntamenti_edited_idx      on public.appuntamenti (notion_last_edited);

-- ── 4. perf_giorno (fact centro×giorno, mirror 🚈 PERFORMANCE DATABASE) ──────
-- Tabella di PARITÀ col foglio: eredita consapevolmente i difetti della pipeline FB→Notion.
-- Niente UNIQUE(centro_id,giorno): la fonte Notion può contenere doppioni; il foglio li somma,
-- le viste qui sommano uguale (parità); i doppioni si scovano con la query di verifica.
create table public.perf_giorno (
  notion_id          uuid primary key,
  centro_id          uuid,
  giorno             date not null,
  spesa_ads          numeric(12,2),
  impression         bigint,
  lead_fb            integer,
  lead_reali         integer,
  appuntamenti       integer,
  presenze           integer,
  non_presentati     integer,
  pacchetti_venduti  integer,
  ricavo             numeric(12,2),
  potenziale_ricavo  numeric(12,2),
  notion_last_edited timestamptz,
  synced_at          timestamptz not null default now()
);
create index perf_giorno_centro_giorno_idx on public.perf_giorno (centro_id, giorno);
create index perf_giorno_edited_idx        on public.perf_giorno (notion_last_edited);

-- ── 5. fb_insights_ad (fact ad×giorno, sync diretto FB — Fase 7) ─────────────
create table public.fb_insights_ad (
  ad_id         text not null,
  giorno        date not null,
  ad_account_id text,
  campaign_id   text,
  campaign_name text,
  adset_id      text,
  adset_name    text,
  ad_name       text,
  spend         numeric(12,4),
  impressions   bigint,
  clicks        integer,
  fb_leads      integer,
  synced_at     timestamptz not null default now(),
  primary key (ad_id, giorno)
);
create index fb_insights_act_idx      on public.fb_insights_ad (ad_account_id, giorno);
create index fb_insights_campaign_idx on public.fb_insights_ad (campaign_id, giorno);

-- ── 6. dimensioni curate (Table Editor, pattern `esiti`) ─────────────────────
create table public.centro_map (
  crm4_campaign_id integer primary key references public.campaigns(campaign_id),
  centro_id        uuid references public.centri(notion_id),
  note             text
);

create table public.mkt_esiti (
  esito           text primary key,
  is_appuntamento boolean not null default false,
  class           text not null default 'unknown'
                  check (class in ('appuntamento','in_lavorazione','non_valido','perso','unknown')),
  needs_review    boolean not null default true
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.centri         enable row level security;
alter table public.mkt_leads      enable row level security;
alter table public.appuntamenti   enable row level security;
alter table public.perf_giorno    enable row level security;
alter table public.fb_insights_ad enable row level security;
alter table public.centro_map     enable row level security;
alter table public.mkt_esiti      enable row level security;

-- ── VISTE ────────────────────────────────────────────────────────────────────

create view public.v_freshness with (security_invoker = on) as
select 'chiamate' as fonte, max(synced_at) as aggiornato_a from public.calls
union all select 'mkt_leads',      max(synced_at) from public.mkt_leads
union all select 'appuntamenti',   max(synced_at) from public.appuntamenti
union all select 'perf_giorno',    max(synced_at) from public.perf_giorno
union all select 'fb_insights_ad', max(synced_at) from public.fb_insights_ad
union all select 'centri',         max(synced_at) from public.centri;

create view public.v_mkt_leads with (security_invoker = on) as
select
  m.*,
  c.nome  as centro,
  c.consulente,
  e.class as esito_class,
  coalesce(e.is_appuntamento, false) as is_appuntamento,
  (m.creazione at time zone 'Europe/Rome')::date          as giorno,
  to_char(m.creazione at time zone 'Europe/Rome','YYYY-MM') as mese_coorte
from public.mkt_leads m
left join public.centri    c on c.notion_id = m.centro_id
left join public.mkt_esiti e on e.esito     = m.esito;

create view public.v_appuntamenti with (security_invoker = on) as
select
  a.*,
  c.nome as centro,
  (a.data_appuntamento at time zone 'Europe/Rome')::date as giorno_appuntamento,
  (a.data_presa        at time zone 'Europe/Rome')::date as giorno_presa,
  (a.show_status = 'SHOW')    as is_show,
  (a.show_status = 'NO SHOW') as is_no_show,
  (a.pacchetto = 'SI')        as is_vendita,
  (a.data_appuntamento < now() and a.show_status is not null) as is_svolto,
  m.ad_account, m.campaign_id, m.campaign_name, m.adset_id, m.adset_name, m.ad_id, m.ad_name,
  m.creazione as lead_creazione,
  to_char(m.creazione at time zone 'Europe/Rome','YYYY-MM') as mese_coorte_lead
from public.appuntamenti a
left join public.centri    c on c.notion_id = a.centro_id
left join public.mkt_leads m on m.notion_id = a.lead_id;

-- Numeratori warehouse per centro×giorno.
-- Doppia colonna appuntamenti (per data_presa E per data_appuntamento):
-- la verifica di parità col foglio decide quale corrisponde a TOTALE APPUNTAMENTI.
create view public.agg_mkt_centro_giorno with (security_invoker = on) as
with lead_g as (
  select centro_id, (creazione at time zone 'Europe/Rome')::date as giorno,
         count(*) as lead_reali
  from public.mkt_leads
  group by 1, 2
),
app_presa as (
  select centro_id, (data_presa at time zone 'Europe/Rome')::date as giorno,
         count(*) as appuntamenti_presi
  from public.appuntamenti
  where data_presa is not null
  group by 1, 2
),
app_svolti as (
  select centro_id, (data_appuntamento at time zone 'Europe/Rome')::date as giorno,
         count(*) as appuntamenti_svolti,
         count(*) filter (where show_status = 'SHOW')    as presenze,
         count(*) filter (where show_status = 'NO SHOW') as no_show,
         count(*) filter (where pacchetto = 'SI')        as pacchetti,
         coalesce(sum(ammontare_oggi), 0)                as ricavo,
         coalesce(sum(valore_pacchetto) filter (where pacchetto = 'SI'), 0) as potenziale
  from public.appuntamenti
  where data_appuntamento is not null
  group by 1, 2
)
select centro_id, giorno,
       coalesce(l.lead_reali, 0)          as lead_reali,
       coalesce(p.appuntamenti_presi, 0)  as appuntamenti_presi,
       coalesce(s.appuntamenti_svolti, 0) as appuntamenti_svolti,
       coalesce(s.presenze, 0)            as presenze,
       coalesce(s.no_show, 0)             as no_show,
       coalesce(s.pacchetti, 0)           as pacchetti,
       coalesce(s.ricavo, 0)              as ricavo,
       coalesce(s.potenziale, 0)          as potenziale
from lead_g l
full join app_presa  p using (centro_id, giorno)
full join app_svolti s using (centro_id, giorno);

-- Spesa per centro×giorno. Fase 2: da perf_giorno (parità foglio).
-- Fase 7: swap del corpo su fb_insights_ad + v_campaign_centro (stessa firma).
create view public.agg_spend_centro_giorno with (security_invoker = on) as
select centro_id, giorno,
       sum(coalesce(spesa_ads, 0))         as spesa,
       sum(coalesce(impression, 0))        as impression,
       sum(coalesce(lead_fb, 0))           as lead_fb,
       sum(coalesce(lead_reali, 0))        as lead_reali_perf,
       sum(coalesce(appuntamenti, 0))      as appuntamenti_perf,
       sum(coalesce(presenze, 0))          as presenze_perf,
       sum(coalesce(non_presentati, 0))    as non_presentati_perf,
       sum(coalesce(pacchetti_venduti, 0)) as pacchetti_perf,
       sum(coalesce(ricavo, 0))            as ricavo_perf,
       sum(coalesce(potenziale_ricavo, 0)) as potenziale_perf
from public.perf_giorno
group by 1, 2;

-- Vista 1 (Panoramica): numeratori per centro×giorno, DUE fonti affiancate:
-- colonne "lisce" = perf_giorno (parità foglio, il frontend parte da qui),
-- colonne wh_* = warehouse (riconciliazione; swap a valle della verifica).
-- Nessun ratio: il client li ricalcola SEMPRE dai totali del range.
create view public.v_panoramica_centro with (security_invoker = on) as
select
  centro_id, giorno,
  c.nome as centro, c.consulente, c.stato_attivita,
  coalesce(s.spesa, 0)               as spesa,
  coalesce(s.impression, 0)          as impression,
  coalesce(s.lead_fb, 0)             as lead_fb,
  coalesce(s.lead_reali_perf, 0)     as lead_reali,
  coalesce(s.appuntamenti_perf, 0)   as appuntamenti,
  coalesce(s.presenze_perf, 0)       as presenze,
  coalesce(s.non_presentati_perf, 0) as non_presentati,
  coalesce(s.pacchetti_perf, 0)      as pacchetti,
  coalesce(s.ricavo_perf, 0)         as ricavo,
  coalesce(s.potenziale_perf, 0)     as potenziale,
  coalesce(w.lead_reali, 0)          as wh_lead_reali,
  coalesce(w.appuntamenti_presi, 0)  as wh_appuntamenti_presi,
  coalesce(w.appuntamenti_svolti, 0) as wh_appuntamenti_svolti,
  coalesce(w.presenze, 0)            as wh_presenze,
  coalesce(w.no_show, 0)             as wh_no_show,
  coalesce(w.pacchetti, 0)           as wh_pacchetti,
  coalesce(w.ricavo, 0)              as wh_ricavo,
  coalesce(w.potenziale, 0)          as wh_potenziale
from public.agg_spend_centro_giorno s
full join public.agg_mkt_centro_giorno w using (centro_id, giorno)
left join public.centri c on c.notion_id = centro_id;

-- Vista 2 (drill-down): funnel per ad×giorno dall'attribuzione sui lead.
-- Un lead può avere più appuntamenti → pre-aggregazione per lead (mai join moltiplicativo).
create view public.agg_mkt_ad_giorno with (security_invoker = on) as
with app_per_lead as (
  select lead_id,
         count(*)                                as n_app,
         bool_or(show_status = 'SHOW')           as has_show,
         bool_or(pacchetto = 'SI')               as has_vendita,
         sum(coalesce(ammontare_oggi, 0))        as ricavo,
         sum(case when pacchetto = 'SI' then coalesce(valore_pacchetto, 0) else 0 end) as potenziale
  from public.appuntamenti
  where lead_id is not null
  group by 1
)
select
  m.centro_id,
  (m.creazione at time zone 'Europe/Rome')::date as giorno,
  m.ad_account,
  m.campaign_id, max(m.campaign_name) as campaign_name,
  m.adset_id,    max(m.adset_name)    as adset_name,
  m.ad_id,       max(m.ad_name)       as ad_name,
  count(*)                                            as lead,
  count(*) filter (where ap.lead_id is not null)      as lead_con_appuntamento,
  coalesce(sum(ap.n_app), 0)                          as appuntamenti,
  count(*) filter (where ap.has_show)                 as presenze,
  count(*) filter (where ap.has_vendita)              as vendite,
  coalesce(sum(ap.ricavo), 0)                         as ricavo,
  coalesce(sum(ap.potenziale), 0)                     as potenziale
from public.mkt_leads m
left join app_per_lead ap on ap.lead_id = m.notion_id
group by m.centro_id, 2, m.ad_account, m.campaign_id, m.adset_id, m.ad_id;

-- Drill-down con costi: spend NULL finché fb_insights_ad non è popolata (Fase 7).
create view public.v_drilldown_ad with (security_invoker = on) as
select g.*, f.spend, f.impressions, f.clicks, f.fb_leads
from public.agg_mkt_ad_giorno g
left join public.fb_insights_ad f on f.ad_id = g.ad_id and f.giorno = g.giorno;

-- Vista 3 (coorti): coorte = mese di CREAZIONE del lead; tutti gli eventi a valle
-- attribuiti indietro alla coorte via relation appuntamento→lead.
create view public.mkt_lead_coorte with (security_invoker = on) as
select
  m.notion_id, m.centro_id, m.esito,
  to_char(m.creazione at time zone 'Europe/Rome','YYYY-MM') as mese_coorte,
  (ap.lead_id is not null)          as has_appuntamento,
  coalesce(ap.has_show, false)      as has_show,
  coalesce(ap.has_vendita, false)   as has_vendita,
  coalesce(ap.ricavo, 0)            as ricavo,
  coalesce(ap.potenziale, 0)        as potenziale,
  ap.prima_presa,
  coalesce(ap.has_pendente, false)  as has_pendente
from public.mkt_leads m
left join (
  select lead_id,
         bool_or(show_status = 'SHOW')    as has_show,
         bool_or(pacchetto = 'SI')        as has_vendita,
         sum(coalesce(ammontare_oggi, 0)) as ricavo,
         sum(case when pacchetto = 'SI' then coalesce(valore_pacchetto, 0) else 0 end) as potenziale,
         min(data_presa)                  as prima_presa,
         bool_or(data_appuntamento > now() or show_status is null) as has_pendente
  from public.appuntamenti
  where lead_id is not null
  group by 1
) ap on ap.lead_id = m.notion_id;

create view public.agg_coorte_mese_centro with (security_invoker = on) as
select centro_id, mese_coorte,
       count(*)                                   as lead,
       count(*) filter (where has_appuntamento)   as lead_con_appuntamento,
       count(*) filter (where has_show)           as presenze,
       count(*) filter (where has_vendita)        as vendite,
       sum(ricavo)                                as ricavo,
       sum(potenziale)                            as potenziale,
       count(*) filter (where has_pendente)       as appt_pendenti
from public.mkt_lead_coorte
group by 1, 2;

-- Appuntamenti senza lead collegato (inserimenti manuali): contati, mai persi in silenzio.
create view public.v_appuntamenti_senza_lead with (security_invoker = on) as
select centro_id,
       to_char(coalesce(data_presa, data_appuntamento) at time zone 'Europe/Rome','YYYY-MM') as mese,
       count(*)                                   as appuntamenti,
       count(*) filter (where show_status = 'SHOW') as presenze,
       count(*) filter (where pacchetto = 'SI')     as vendite,
       sum(coalesce(ammontare_oggi, 0))             as ricavo
from public.appuntamenti
where lead_id is null
group by 1, 2;
