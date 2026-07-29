-- manager-stats · Sezione Vendita — chiamate OGGETTIVE dal log nativo GoHighLevel
--
-- I setter chiamano attraverso GHL (numeri LC Phone), quindi ogni squillo esiste come
-- record `messageType: TYPE_CALL` dentro la conversazione del contatto, con userId,
-- stato tecnico (completed / no-answer / busy / failed / ringing) e DURATA reale.
--
-- Grana diversa da set_chiamate, che contiene gli ESITI dichiarati dal setter:
--   set_chiamate      = 1 riga per esito registrato   (cosa dice il setter)
--   set_chiamate_ghl  = 1 riga per squillo composto   (cosa è successo davvero)
-- Le due restano separate e vengono unite dalla vista v_set_chiamate_ghl, che marca
-- come "senza esito" le chiamate a cui non corrisponde nessun esito.
--
-- Misurato il 2026-07-29: su 34 chiamate reali, 9 non avevano un esito — di cui 2
-- conversazioni sopra i 30 secondi. Il conteggio basato sugli esiti da solo non le vede.

create table if not exists public.set_chiamate_ghl (
  id              text primary key,          -- id messaggio GHL: univoco e stabile
  conversation_id text,
  ghl_contact_id  text not null,
  quando          timestamptz not null,
  giorno          date generated always as (((quando at time zone 'Europe/Rome'))::date) stored,
  ora_locale      smallint generated always as (extract(hour from (quando at time zone 'Europe/Rome'))::smallint) stored,
  direzione       text,
  stato           text,
  durata_s        integer,                   -- secondi reali, valorizzato solo sulle completed
  user_id         text,
  numero_da       text,
  numero_a        text,
  sync_a          timestamptz not null default now()
);

create index if not exists set_chiamate_ghl_giorno_idx   on public.set_chiamate_ghl (giorno);
create index if not exists set_chiamate_ghl_contatto_idx on public.set_chiamate_ghl (ghl_contact_id, quando);
create index if not exists set_chiamate_ghl_user_idx     on public.set_chiamate_ghl (user_id);

-- userId GHL → nome: il record chiamata porta solo l'id.
-- Popolata da GET /users/?locationId= — ⚠️ serve il PIT, il location token dà 401.
create table if not exists public.set_utenti_ghl (
  user_id text primary key,
  nome    text not null
);

-- Ogni chiamata con il suo esito, se il setter ne ha registrato uno.
-- ⚠️ La finestra di match parte 1 minuto PRIMA dell'inizio e finisce 10 minuti DOPO
-- LA FINE della chiamata. Misurare dall'inizio è sbagliato: una call da 40 minuti
-- viene esitata quando si riaggancia, non entro 10 minuti da quando è partita.
create or replace view public.v_set_chiamate_ghl
with (security_invoker = on) as
select
  c.id, c.ghl_contact_id, c.quando, c.giorno, c.ora_locale,
  c.stato, c.durata_s, c.direzione, c.numero_a,
  coalesce(u.nome, c.user_id)            as setter,
  e.esito,
  (e.esito is null)                      as senza_esito,
  (c.stato = 'completed')                as connessa,
  (c.stato = 'completed' and coalesce(c.durata_s, 0) >= 30) as conversazione
from public.set_chiamate_ghl c
left join public.set_utenti_ghl u on u.user_id = c.user_id
left join lateral (
  select s.esito
  from public.set_chiamate s
  where s.ghl_contact_id = c.ghl_contact_id
    and s.creata_a >= c.quando - interval '1 minute'
    and s.creata_a <= c.quando + make_interval(secs => coalesce(c.durata_s, 0)) + interval '10 minutes'
  order by s.creata_a
  limit 1
) e on true;

create or replace view public.agg_set_ghl_setter_giorno
with (security_invoker = on) as
select
  giorno, setter,
  count(*)                                              as chiamate,
  count(distinct ghl_contact_id)                        as contatti,
  count(*) filter (where connessa)                      as connesse,
  count(*) filter (where conversazione)                 as conversazioni,
  coalesce(sum(durata_s) filter (where connessa), 0)    as secondi,
  count(*) filter (where senza_esito)                   as senza_esito,
  count(*) filter (where senza_esito and conversazione) as conversazioni_senza_esito,
  count(*) filter (where stato = 'no-answer')           as non_risposte,
  count(*) filter (where stato in ('failed','ringing')) as non_partite
from public.v_set_chiamate_ghl
group by giorno, setter;

alter table public.set_chiamate_ghl enable row level security;
alter table public.set_utenti_ghl   enable row level security;

do $$
begin
  if not exists (select 1 from pg_policy where polname = 'authenticated_read'
                 and polrelid = 'public.set_chiamate_ghl'::regclass) then
    create policy authenticated_read on public.set_chiamate_ghl for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policy where polname = 'authenticated_read'
                 and polrelid = 'public.set_utenti_ghl'::regclass) then
    create policy authenticated_read on public.set_utenti_ghl for select to authenticated using (true);
  end if;
end $$;

revoke all on public.set_chiamate_ghl, public.set_utenti_ghl,
              public.v_set_chiamate_ghl, public.agg_set_ghl_setter_giorno from anon;
grant select on public.set_chiamate_ghl, public.set_utenti_ghl,
                public.v_set_chiamate_ghl, public.agg_set_ghl_setter_giorno to authenticated;

-- Alimentazione:
--   storico  → wf lQkEDFsNsYffHZyq, GET /webhook/backfill-chiamate-ghl-9d3f?dal=YYYY-MM-DD
--   realtime → wf x5mqD0a2u412qAkN, cron 10 min, watermark = max(quando) − 2h
-- Entrambi paginano conversations/search con startAfterDate e leggono i messaggi con
-- ?type=TYPE_CALL — quel filtro è essenziale: senza, il limite di 100 messaggi per
-- conversazione tronca le chiamate più vecchie sulle conversazioni molto attive.
