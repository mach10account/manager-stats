-- Anagrafica del team: una persona, tanti modi di chiamarla.
--
-- Il problema: la stessa persona compare nei dati in tre forme diverse.
--   centri.consulente/beauty/media_buyer  → EMAIL   (property Notion 'person')
--   fin_incassi.consulente                → NOME    (formula Notion, grafie sporche)
--   fin_incassi.venditore, v_notion_contratti.venditore → NOME (rollup)
-- Su 31 email-persona in `centri` solo 3 hanno un login, quindi ms_accessi.nome
-- non può risolverne 28: nelle dashboard si legge "smnalessandrini@gmail.com".
--
-- La soluzione è uno STRATO DI TRADUZIONE, non una riscrittura del dato:
--   ms_persona        = la persona, sorgente unica del nome
--   ms_persona_alias  = ogni stringa con cui compare (email o variante di nome)
-- Il dato grezzo non si tocca mai — `centri` è un full-refresh notturno (WF-M1) e
-- `fin_incassi` orario (WF-M7) — e soprattutto l'EMAIL RESTA LA CHIAVE ovunque sia
-- una chiave: ms_centri_di() e tutte le policy di scoping continuano a fare
-- `ms_accessi.consulente = centri.consulente`. Qui cambiano solo le ETICHETTE.
--
-- Scritture: solo via RPC security definer con guardia ms_puo('admin'), come
-- ms_imposta_sezioni/ms_imposta_scope. Lettura dei nomi a ogni utente attivo.

-- ── normalizzazione ──────────────────────────────────────────────────────────
-- gemello SQL di chiave() in js/sections/sauron.js: lower + trim + spazi collassati
create or replace function public.ms_key(p_txt text) returns text
language sql immutable parallel safe as $fn$
  select nullif(regexp_replace(btrim(lower(coalesce(p_txt, ''))), '\s+', ' ', 'g'), '')
$fn$;

-- nome dedotto da un'email, stessa euristica già dentro ms_nome_utente
create or replace function public.ms_nome_da_email(p_email text) returns text
language sql immutable parallel safe as $fn$
  select initcap(replace(replace(split_part(coalesce(p_email, ''), '@', 1), '.', ' '), '_', ' '))
$fn$;

-- ── tabelle ──────────────────────────────────────────────────────────────────
create table if not exists public.ms_persona (
  id        uuid primary key default gen_random_uuid(),
  nome      text not null check (length(btrim(nome)) > 0),
  ruoli     text[] not null default '{}',        -- PM|BEAUTY|MEDIA_BUYER|VENDITORE|SETTER|STAFF
  tipo      text not null default 'persona' check (tipo in ('persona', 'casella')),
  user_id   uuid unique references auth.users(id) on delete set null,   -- il login, se ce l'ha
  attivo    boolean not null default true,
  nome_auto boolean not null default false,      -- nome dedotto: da correggere a mano
  uscita_il date,
  note      text,
  agg_a     timestamptz not null default now()
);
comment on table public.ms_persona is
  'Anagrafica del team. Sorgente unica del NOME. Una persona esiste anche senza login.';

-- un alias è QUALSIASI stringa con cui la persona compare nei dati.
-- La PK sulla chiave normalizzata rende impossibile, per costruzione, che lo
-- stesso valore appartenga a due persone.
create table if not exists public.ms_persona_alias (
  chiave     text primary key,
  valore     text not null,                      -- il grezzo come appare nei dati
  persona_id uuid references public.ms_persona(id) on delete cascade,   -- NULL = ignorato apposta
  tipo       text not null default 'email' check (tipo in ('email', 'nome')),
  fonte      text,
  confermato boolean not null default true,      -- false = collegato dal seed, da rivedere
  creato_a   timestamptz not null default now()
);
create index if not exists ms_persona_alias_persona_idx on public.ms_persona_alias (persona_id);
comment on table public.ms_persona_alias is
  'Email e varianti di nome che puntano a una persona. persona_id NULL = valore ignorato di proposito.';

alter table public.ms_persona       enable row level security;
alter table public.ms_persona_alias enable row level security;

-- ⚠️ i default di Supabase concedono ALL a authenticated sulle tabelle nuove: le
-- scritture devono passare SOLO dalle RPC definer con la guardia admin. La RLS le
-- bloccherebbe comunque (nessuna policy di insert/update/delete = deny), ma il
-- privilegio non deve esserci proprio.
revoke all on public.ms_persona, public.ms_persona_alias from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.ms_persona, public.ms_persona_alias from authenticated;
grant select on public.ms_persona, public.ms_persona_alias to authenticated;

drop policy if exists ms_persona_read on public.ms_persona;
create policy ms_persona_read on public.ms_persona
  for select using ((select public.ms_puo('task')));

drop policy if exists ms_persona_alias_read on public.ms_persona_alias;
create policy ms_persona_alias_read on public.ms_persona_alias
  for select using ((select public.ms_puo('task')));

-- ── viste ────────────────────────────────────────────────────────────────────
-- la mappa che il frontend carica una volta per sessione
create or replace view public.v_ms_nomi with (security_invoker = on) as
  select a.chiave, a.valore, a.tipo, p.id as persona_id, p.nome, p.attivo, p.ruoli
  from public.ms_persona_alias a
  join public.ms_persona p on p.id = a.persona_id;

-- tutti i valori-persona che esistono davvero nei dati, con dove e su quante righe.
-- Gli UUID Notion non risolti (property person con utenti guest) non sono nomi: fuori.
create or replace view public.v_ms_valori_persona with (security_invoker = on) as
with grezzi as (
  select consulente  as v, 'email'::text as tipo, 'centri.consulente'::text  as fonte from public.centri where consulente is not null
  union all select beauty,      'email', 'centri.beauty'      from public.centri where beauty is not null
  union all select media_buyer, 'email', 'centri.media_buyer' from public.centri where media_buyer is not null
  union all select email,       'email', 'ms_accessi.email'   from public.ms_accessi where email is not null
  union all select x, 'nome', 'fin_incassi.consulente' from public.fin_incassi, lateral unnest(string_to_array(consulente, ',')) x where consulente is not null
  union all select x, 'nome', 'fin_incassi.venditore'  from public.fin_incassi, lateral unnest(string_to_array(venditore,  ',')) x where venditore  is not null
  union all select x, 'nome', 'contratti.venditore'    from public.v_notion_contratti, lateral unnest(venditore) x where venditore is not null
)
select public.ms_key(v) as chiave, min(btrim(v)) as valore, tipo, fonte, count(*)::bigint as righe
from grezzi
where public.ms_key(v) is not null
  and public.ms_key(v) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-'
group by public.ms_key(v), tipo, fonte;

-- quello che nei dati c'è ma non è ancora di nessuno: è il pannello che tiene
-- viva l'anagrafica nel tempo (WF-M1 stanotte porta un'email nuova → domani è qui)
create or replace view public.v_ms_alias_orfani with (security_invoker = on) as
select v.chiave,
       min(v.valore)  as valore,
       min(v.tipo)    as tipo,
       string_agg(distinct v.fonte, ', ' order by v.fonte) as fonti,
       sum(v.righe)   as righe
from public.v_ms_valori_persona v
where not exists (select 1 from public.ms_persona_alias a where a.chiave = v.chiave)
group by v.chiave;

grant select on public.v_ms_nomi, public.v_ms_valori_persona, public.v_ms_alias_orfani to authenticated;
revoke all on public.v_ms_nomi, public.v_ms_valori_persona, public.v_ms_alias_orfani from anon;

-- ── risoluzione ──────────────────────────────────────────────────────────────
-- ms_nome('smnalessandrini@gmail.com') → 'Simone Alessandrini'.
-- Splitta sulla virgola (i rollup Notion arrivano come "Vito ,Simone Alessandrini"),
-- deduplica e ripiega sul grezzo per quello che non conosce.
create or replace function public.ms_nome(p_raw text) returns text
language sql stable security definer set search_path = public as $fn$
  select coalesce(
    nullif(string_agg(distinct coalesce(p.nome, btrim(t.v)), ', '), ''),
    p_raw)
  from unnest(string_to_array(coalesce(p_raw, ''), ',')) as t(v)
  left join public.ms_persona_alias a on a.chiave = public.ms_key(t.v)
  left join public.ms_persona p on p.id = a.persona_id
  where public.ms_key(t.v) is not null
$fn$;

-- il nome di un utente con login: prima l'anagrafica, poi il vecchio ms_accessi.nome
create or replace function public.ms_nome_utente(p_user uuid) returns text
language sql stable security definer set search_path = public as $fn$
  select coalesce(
    (select nullif(btrim(p.nome), '') from public.ms_persona p where p.user_id = u.id),
    nullif(btrim(a.nome), ''),
    public.ms_nome_da_email(coalesce(a.email, u.email::text)),
    u.email::text,
    '—')
  from auth.users u
  left join public.ms_accessi a on a.user_id = u.id
  where u.id = p_user
$fn$;

-- ── scritture (solo admin) ───────────────────────────────────────────────────
create or replace function public.ms_persona_salva(
  p_id     uuid    default null,
  p_nome   text    default null,
  p_ruoli  text[]  default null,
  p_tipo   text    default null,
  p_attivo boolean default null,
  p_note   text    default null
) returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_id uuid;
  v_ruoli text[];
begin
  if not public.ms_puo('admin') then raise exception 'non autorizzato'; end if;
  if nullif(btrim(coalesce(p_nome, '')), '') is null and p_id is null then
    raise exception 'il nome è obbligatorio';
  end if;
  v_ruoli := coalesce((select array_agg(distinct r) from unnest(coalesce(p_ruoli, '{}')) r
                       where r = any (array['PM','BEAUTY','MEDIA_BUYER','VENDITORE','SETTER','STAFF'])), '{}');

  if p_id is null then
    insert into public.ms_persona (nome, ruoli, tipo, attivo, note, nome_auto)
    values (btrim(p_nome), v_ruoli, coalesce(p_tipo, 'persona'), coalesce(p_attivo, true), p_note, false)
    returning id into v_id;
  else
    update public.ms_persona set
      nome      = coalesce(nullif(btrim(p_nome), ''), nome),
      nome_auto = case when nullif(btrim(coalesce(p_nome, '')), '') is null then nome_auto else false end,
      ruoli     = case when p_ruoli  is null then ruoli  else v_ruoli end,
      tipo      = coalesce(p_tipo, tipo),
      attivo    = coalesce(p_attivo, attivo),
      uscita_il = case when p_attivo is false and uscita_il is null then current_date
                       when p_attivo is true  then null else uscita_il end,
      note      = coalesce(p_note, note),
      agg_a     = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'persona inesistente'; end if;
  end if;
  return v_id;
end $fn$;

-- attacca un valore grezzo a una persona (o lo sposta da un'altra: la PK garantisce
-- che appartenga a una sola). p_persona null = "ignora questo valore".
create or replace function public.ms_alias_assegna(
  p_valore  text,
  p_persona uuid default null,
  p_tipo    text default null,
  p_fonte   text default null
) returns text
language plpgsql security definer set search_path = public as $fn$
declare v_chiave text;
begin
  if not public.ms_puo('admin') then raise exception 'non autorizzato'; end if;
  v_chiave := public.ms_key(p_valore);
  if v_chiave is null then raise exception 'valore vuoto'; end if;
  if p_persona is not null and not exists (select 1 from public.ms_persona where id = p_persona) then
    raise exception 'persona inesistente';
  end if;

  insert into public.ms_persona_alias (chiave, valore, persona_id, tipo, fonte, confermato)
  values (v_chiave, btrim(p_valore), p_persona,
          coalesce(p_tipo, case when p_valore like '%@%' then 'email' else 'nome' end),
          p_fonte, true)
  on conflict (chiave) do update
    set persona_id = excluded.persona_id,
        tipo       = coalesce(excluded.tipo, public.ms_persona_alias.tipo),
        confermato = true;
  return v_chiave;
end $fn$;

create or replace function public.ms_alias_rimuovi(p_chiave text) returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.ms_puo('admin') then raise exception 'non autorizzato'; end if;
  delete from public.ms_persona_alias where chiave = public.ms_key(p_chiave);
end $fn$;

create or replace function public.ms_persona_collega_login(p_persona uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.ms_puo('admin') then raise exception 'non autorizzato'; end if;
  update public.ms_persona set user_id = null, agg_a = now() where user_id = p_user and id <> p_persona;
  update public.ms_persona set user_id = p_user, agg_a = now() where id = p_persona;
  -- l'email del login diventa un alias della persona
  if p_user is not null then
    perform public.ms_alias_assegna((select u.email::text from auth.users u where u.id = p_user),
                                    p_persona, 'email', 'ms_accessi.email');
  end if;
end $fn$;

-- cancellazione vera: solo per una riga creata per sbaglio
create or replace function public.ms_persona_elimina(p_id uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare n int;
begin
  if not public.ms_puo('admin') then raise exception 'non autorizzato'; end if;
  select count(*) into n from public.ms_persona_alias where persona_id = p_id;
  if n > 0 then raise exception 'ha ancora % email o nomi collegati: staccali prima', n; end if;
  if exists (select 1 from public.ms_persona where id = p_id and user_id is not null) then
    raise exception 'è collegata a un login: scollegalo prima';
  end if;
  delete from public.ms_persona where id = p_id;
end $fn$;

-- oggi ms_accessi.attivo esiste ma nessuna RPC lo scrive: serve a togliere l'accesso
-- senza cancellare l'utente. È una cosa DIVERSA dal disattivare la persona.
create or replace function public.ms_imposta_attivo(p_user uuid, p_attivo boolean) returns boolean
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.ms_puo('admin') then raise exception 'non autorizzato'; end if;
  if p_user = auth.uid() and p_attivo is false then
    raise exception 'non puoi disattivare te stesso';
  end if;
  insert into public.ms_accessi (user_id, email, attivo)
  values (p_user, (select u.email::text from auth.users u where u.id = p_user), p_attivo)
  on conflict (user_id) do update set attivo = excluded.attivo, aggiornato_a = now();
  return p_attivo;
end $fn$;

-- l'anagrafica completa per il pannello (persone + alias + quanti centri seguono)
create or replace function public.ms_anagrafica()
returns table (
  id uuid, nome text, ruoli text[], tipo text, attivo boolean, nome_auto boolean,
  user_id uuid, login_email text, note text,
  alias jsonb, centri_pm bigint, centri_beauty bigint, centri_mb bigint
)
language sql stable security definer set search_path = public as $fn$
  select p.id, p.nome, p.ruoli, p.tipo, p.attivo, p.nome_auto,
         p.user_id, u.email::text, p.note,
         coalesce((select jsonb_agg(jsonb_build_object('chiave', a.chiave, 'valore', a.valore,
                                                       'tipo', a.tipo, 'confermato', a.confermato)
                                    order by a.tipo, a.valore)
                   from public.ms_persona_alias a where a.persona_id = p.id), '[]'::jsonb),
         (select count(*) from public.centri c join public.ms_persona_alias a on a.chiave = public.ms_key(c.consulente)  where a.persona_id = p.id),
         (select count(*) from public.centri c join public.ms_persona_alias a on a.chiave = public.ms_key(c.beauty)      where a.persona_id = p.id),
         (select count(*) from public.centri c join public.ms_persona_alias a on a.chiave = public.ms_key(c.media_buyer) where a.persona_id = p.id)
  from public.ms_persona p
  left join auth.users u on u.id = p.user_id
  where public.ms_puo('admin')
  order by p.attivo desc, p.nome
$fn$;

-- ── seed / riconciliazione ───────────────────────────────────────────────────
-- Idempotente: la migration la chiama una volta, il pannello la richiama col
-- bottone "Cerca persone nuove". Crea una persona per ogni EMAIL non ancora
-- assegnata (chi ha dei centri è una persona per definizione) e collega i NOMI
-- alle email solo quando il match è certo. Non fonde MAI due email fra loro:
-- assu.tolomeo@ + assuntatolomeo47@ sono la stessa persona, draganorosa@ +
-- draganomaria31@ quasi certamente no, e nessuna euristica può saperlo.
create or replace function public.ms_persone_sync() returns integer
language plpgsql security definer set search_path = public as $fn$
declare v_nuove int := 0; v_link int := 0; r record;
begin
  if not public.ms_puo('admin') then raise exception 'non autorizzato'; end if;

  -- 1) chi ha un login: la persona nasce col nome già scritto in ms_accessi
  for r in
    select a.user_id, a.email, a.nome
    from public.ms_accessi a
    where a.email is not null
      and not exists (select 1 from public.ms_persona p where p.user_id = a.user_id)
      and not exists (select 1 from public.ms_persona_alias x where x.chiave = public.ms_key(a.email))
  loop
    with nuova as (
      insert into public.ms_persona (nome, tipo, user_id, nome_auto)
      values (coalesce(nullif(btrim(r.nome), ''), public.ms_nome_da_email(r.email)),
              case when r.email ilike 'ufficio%' then 'casella' else 'persona' end,
              r.user_id,
              nullif(btrim(coalesce(r.nome, '')), '') is null)
      returning id
    )
    insert into public.ms_persona_alias (chiave, valore, persona_id, tipo, fonte)
    select public.ms_key(r.email), btrim(r.email), nuova.id, 'email', 'ms_accessi.email' from nuova;
    v_nuove := v_nuove + 1;
  end loop;

  -- 2) le email che compaiono in centri: una persona per ciascuna, ruoli dedotti
  for r in
    select v.chiave, v.valore,
           array_remove(array[
             case when exists (select 1 from public.centri c where public.ms_key(c.consulente)  = v.chiave) then 'PM' end,
             case when exists (select 1 from public.centri c where public.ms_key(c.beauty)      = v.chiave) then 'BEAUTY' end,
             case when exists (select 1 from public.centri c where public.ms_key(c.media_buyer) = v.chiave) then 'MEDIA_BUYER' end
           ], null) as ruoli
    from public.v_ms_alias_orfani v
    where v.tipo = 'email'
  loop
    with nuova as (
      insert into public.ms_persona (nome, ruoli, tipo, nome_auto)
      values (public.ms_nome_da_email(r.valore),
              coalesce(r.ruoli, '{}'),
              case when r.valore ilike 'ufficio%' then 'casella' else 'persona' end,
              true)
      returning id
    )
    insert into public.ms_persona_alias (chiave, valore, persona_id, tipo, fonte)
    select r.chiave, r.valore, nuova.id, 'email', 'centri' from nuova;
    v_nuove := v_nuove + 1;
  end loop;

  -- 3) i NOMI si collegano a un'email solo se il COGNOME (ultimo token, >= 4 lettere)
  --    compare nella local-part E il match è unico nei due sensi. L'euristica ingenua
  --    "un token qualsiasi" sbagliava per davvero: DANIELE TESTORE → daniele.papa.adv@,
  --    Gabriele Viccaro → fabianagabriele2325@, Luca Ganci → lucabiancardi@.
  --    L'unicità bidirezionale scarta anche Lorenzo Carasso / matteo carasso.
  for r in
    with mail as (
      select a.chiave as email, a.persona_id,
             regexp_replace(split_part(a.chiave, '@', 1), '[^a-z]', '', 'g') as locale
      from public.ms_persona_alias a
      where a.tipo = 'email' and a.persona_id is not null
    ),
    nomi as (
      select o.chiave as nome, o.valore,
             regexp_replace(
               (regexp_split_to_array(o.chiave, '\s+'))[array_length(regexp_split_to_array(o.chiave, '\s+'), 1)],
               '[^a-z]', '', 'g') as cognome
      from public.v_ms_alias_orfani o
      where o.tipo = 'nome'
    ),
    coppie as (
      select n.nome, n.valore, m.email, m.persona_id
      from nomi n join mail m on length(n.cognome) >= 4 and position(n.cognome in m.locale) > 0
    )
    select c.nome, c.valore, c.persona_id from coppie c
    where (select count(*) from coppie x where x.nome  = c.nome)  = 1
      and (select count(*) from coppie y where y.email = c.email) = 1
  loop
    insert into public.ms_persona_alias (chiave, valore, persona_id, tipo, fonte, confermato)
    values (r.nome, r.valore, r.persona_id, 'nome', 'auto', false)
    on conflict (chiave) do nothing;
    -- il nome vero sta negli incassi, non nell'email: "Simone Alessandrini" batte
    -- "Smnalessandrini". Resta comunque nome_auto = true, è pur sempre una deduzione.
    update public.ms_persona set nome = initcap(r.valore), agg_a = now()
    where id = r.persona_id and nome_auto;
    v_link := v_link + 1;
  end loop;

  return v_nuove + v_link;
end $fn$;

revoke all on function public.ms_persona_salva(uuid, text, text[], text, boolean, text),
                       public.ms_alias_assegna(text, uuid, text, text),
                       public.ms_alias_rimuovi(text),
                       public.ms_persona_collega_login(uuid, uuid),
                       public.ms_persona_elimina(uuid),
                       public.ms_imposta_attivo(uuid, boolean),
                       public.ms_anagrafica(),
                       public.ms_persone_sync()
  from public, anon;

grant execute on function public.ms_persona_salva(uuid, text, text[], text, boolean, text),
                          public.ms_alias_assegna(text, uuid, text, text),
                          public.ms_alias_rimuovi(text),
                          public.ms_persona_collega_login(uuid, uuid),
                          public.ms_persona_elimina(uuid),
                          public.ms_imposta_attivo(uuid, boolean),
                          public.ms_anagrafica(),
                          public.ms_persone_sync()
  to authenticated;

grant execute on function public.ms_nome(text), public.ms_key(text), public.ms_nome_da_email(text)
  to authenticated;

-- ── prima popolazione ────────────────────────────────────────────────────────
-- ms_persone_sync() ha la guardia admin: qui gira come owner della migration,
-- quindi si semina a mano con la stessa logica (i tre passi, in ordine).
do $seed$
declare r record;
begin
  -- 1) login
  for r in select a.user_id, a.email, a.nome from public.ms_accessi a where a.email is not null loop
    if not exists (select 1 from public.ms_persona_alias x where x.chiave = public.ms_key(r.email)) then
      with nuova as (
        insert into public.ms_persona (nome, tipo, user_id, nome_auto)
        values (coalesce(nullif(btrim(r.nome), ''), public.ms_nome_da_email(r.email)),
                case when r.email ilike 'ufficio%' then 'casella' else 'persona' end,
                r.user_id, nullif(btrim(coalesce(r.nome, '')), '') is null)
        returning id)
      insert into public.ms_persona_alias (chiave, valore, persona_id, tipo, fonte)
      select public.ms_key(r.email), btrim(r.email), nuova.id, 'email', 'ms_accessi.email' from nuova;
    end if;
  end loop;

  -- 2) email dei centri
  for r in
    select v.chiave, v.valore,
           array_remove(array[
             case when exists (select 1 from public.centri c where public.ms_key(c.consulente)  = v.chiave) then 'PM' end,
             case when exists (select 1 from public.centri c where public.ms_key(c.beauty)      = v.chiave) then 'BEAUTY' end,
             case when exists (select 1 from public.centri c where public.ms_key(c.media_buyer) = v.chiave) then 'MEDIA_BUYER' end
           ], null) as ruoli
    from public.v_ms_alias_orfani v where v.tipo = 'email'
  loop
    with nuova as (
      insert into public.ms_persona (nome, ruoli, tipo, nome_auto)
      values (public.ms_nome_da_email(r.valore), coalesce(r.ruoli, '{}'),
              case when r.valore ilike 'ufficio%' then 'casella' else 'persona' end, true)
      returning id)
    insert into public.ms_persona_alias (chiave, valore, persona_id, tipo, fonte)
    select r.chiave, r.valore, nuova.id, 'email', 'centri' from nuova;
  end loop;

  -- 3) nomi → email, match certo e bidirezionale
  for r in
    with mail as (
      select a.chiave as email, a.persona_id,
             regexp_replace(split_part(a.chiave, '@', 1), '[^a-z]', '', 'g') as locale
      from public.ms_persona_alias a where a.tipo = 'email' and a.persona_id is not null),
    nomi as (
      select o.chiave as nome, o.valore,
             regexp_replace((regexp_split_to_array(o.chiave, '\s+'))[array_length(regexp_split_to_array(o.chiave, '\s+'), 1)],
                            '[^a-z]', '', 'g') as cognome
      from public.v_ms_alias_orfani o where o.tipo = 'nome'),
    coppie as (
      select n.nome, n.valore, m.email, m.persona_id
      from nomi n join mail m on length(n.cognome) >= 4 and position(n.cognome in m.locale) > 0)
    select c.nome, c.valore, c.persona_id from coppie c
    where (select count(*) from coppie x where x.nome = c.nome) = 1
      and (select count(*) from coppie y where y.email = c.email) = 1
  loop
    insert into public.ms_persona_alias (chiave, valore, persona_id, tipo, fonte, confermato)
    values (r.nome, r.valore, r.persona_id, 'nome', 'auto', false)
    on conflict (chiave) do nothing;
    update public.ms_persona set nome = initcap(r.valore), agg_a = now()
    where id = r.persona_id and nome_auto;
  end loop;
end $seed$;

-- ruoli dedotti da dove la persona compare davvero, per TUTTE (anche quelle nate
-- dal login, che nel passo 1 non li avevano). Additivo: quello messo a mano resta.
update public.ms_persona p set ruoli = array(select distinct unnest(p.ruoli || d.ruoli))
from (
  -- una persona può avere più alias: i ruoli si sommano su tutti
  select a.persona_id, array_agg(distinct r) as ruoli
  from public.ms_persona_alias a
  cross join lateral unnest(array_remove(array[
           case when exists (select 1 from public.centri c where public.ms_key(c.consulente)  = a.chiave) then 'PM' end,
           case when exists (select 1 from public.centri c where public.ms_key(c.beauty)      = a.chiave) then 'BEAUTY' end,
           case when exists (select 1 from public.centri c where public.ms_key(c.media_buyer) = a.chiave) then 'MEDIA_BUYER' end,
           case when exists (select 1 from public.fin_incassi f where public.ms_key(f.venditore) = a.chiave) then 'VENDITORE' end
         ], null)) r
  where a.persona_id is not null
  group by a.persona_id
) d
where d.persona_id = p.id;

-- ── verifica (da eseguire a mano dopo la migration) ──────────────────────────
-- select count(*) from ms_persona;                       -- ~40
-- select ms_nome('smnalessandrini@gmail.com');           -- 'Smnalessandrini' finché non lo correggi
-- select ms_nome('Simone Alessandrini');                 -- stessa persona
-- select * from v_ms_alias_orfani order by righe desc;   -- la coda da lavorare a mano
