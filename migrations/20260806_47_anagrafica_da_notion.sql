-- I nomi veri arrivano dal foglio del personale, non più dedotti dall'email.
--
-- Fonte: Notion **👱🏻 DATABASE PERSONALE MACH10** (database
-- 2733e1b8-27ed-80ba-a68c-cb93f3058996, data source 2733e1b8-27ed-80ed-bff8-000bd8aece23):
-- NOME E COGNOME · EMAIL · RUOLO (multi-select) · NUMERO DI TELEFONO · Person.
-- 37 righe. Prima l'anagrafica deduceva i nomi dalla local-part ("Cripush68",
-- "20miluna24", "Adri "): da qui in poi il nome è quello scritto sul foglio.
--
-- ⚠️ I telefoni di Notion contengono caratteri bidi invisibili (U+202A/U+202C):
-- vanno ripuliti, o il numero non è confrontabile né utilizzabile.
--
-- ⚠️ Le fusioni di email NON sono state indovinate dalla somiglianza delle
-- stringhe: sono PROVATE. Le email in centri.consulente/beauty/media_buyer
-- nascono da una property `person` di Notion. Se il centro X ha BEAUTY = user://U
-- e in Supabase quel centro ha beauty = 'email', allora U ↔ email; incrociando U
-- col campo Person del foglio si ottiene il nome. Prove raccolte:
--   adri_@live.it            = user://258d872b-…725823 = Adriana Di Franco  (Aasthetic Studio)
--   gioele439@gmail.com      = user://db33f39a-…09ccc2 = Gioele Pingitore   (Aasthetic Studio + BALANCE SRL)
--   cripush68@gmail.com      = user://252d872b-…6c3e52 = Cristina Pusceddu  (CENTRO ESTETICO INCANTESIMO)
--   giuseppe97pa@gmail.com   = user://1a0d872b-…75e8d8 = Giuseppe D'angelo  (20 Minutes, BISSO, AMIRA)
--   assu.tolomeo@hotmail.it  = user://336d872b-…38974a = Assunta Tolomeo    (BISSO MARCELLA)
--   stefaniamalomo@gmail.com = user://175d872b-…eb84d9 = Stefania Malomo    (AMIRA BEAUTY SUITE)
--   daniele.papa.adv@gmail.com = user://8c111133-… → NON è sul foglio: lasciato com'è.
--
-- Verifica fatta dopo l'esecuzione: i centri attribuiti restano identici a quelli
-- che hanno la persona nel dato (406 consulente · 257 beauty · 235 media buyer):
-- nessun centro perso, nessuno contato due volte.

alter table public.ms_persona add column if not exists telefono text;

-- i ruoli del foglio non hanno gli stessi nomi dei miei
create or replace function public.ms_ruolo_da_notion(p_ruolo text) returns text
language sql immutable as $fn$
  select case upper(btrim(p_ruolo))
    when 'CONSULENTE'     then 'PM'
    when 'BEAUTY'         then 'BEAUTY'
    when 'MEDIA BUYER'    then 'MEDIA_BUYER'
    when 'VENDITORE'      then 'VENDITORE'
    when 'SETTER'         then 'SETTER'
    when 'MANAGER'        then 'STAFF'
    when 'AMMINISTRATORE' then 'STAFF'
    when 'PROGRAMMATORE'  then 'STAFF'
    else null end
$fn$;

-- unire due persone: stessa persona con due email (una sul foglio, una nel login,
-- o una vecchia e una nuova). Sposta gli alias, somma i ruoli, tiene telefono e
-- login, porta la capienza più alta, poi cancella quella svuotata.
-- Il dato storico non si tocca: gli alias continuano a risolvere.
create or replace function public.ms_persona_fondi(p_da uuid, p_in uuid) returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if not public.ms_puo('admin') then raise exception 'non autorizzato'; end if;
  if p_da = p_in then raise exception 'sono la stessa persona'; end if;
  if not exists (select 1 from public.ms_persona where id = p_da)
     or not exists (select 1 from public.ms_persona where id = p_in) then
    raise exception 'persona inesistente';
  end if;

  update public.ms_persona d set
    ruoli    = array(select distinct unnest(d.ruoli || s.ruoli)),
    telefono = coalesce(d.telefono, s.telefono),
    user_id  = coalesce(d.user_id, s.user_id),
    agg_a    = now()
  from public.ms_persona s where s.id = p_da and d.id = p_in;

  update public.ms_persona set user_id = null where id = p_da;   -- il login è unique
  update public.ms_persona_alias set persona_id = p_in where persona_id = p_da;

  update public.fin_capacita d set capacita = greatest(d.capacita, s.capacita)
  from public.fin_capacita s where s.persona_id = p_da and d.persona_id = p_in and d.ruolo = s.ruolo;
  delete from public.fin_capacita s where s.persona_id = p_da
    and exists (select 1 from public.fin_capacita d where d.persona_id = p_in and d.ruolo = s.ruolo);
  update public.fin_capacita set persona_id = p_in where persona_id = p_da;

  delete from public.ms_persona where id = p_da;
end $fn$;

revoke all on function public.ms_persona_fondi(uuid, uuid) from public, anon;
grant execute on function public.ms_persona_fondi(uuid, uuid) to authenticated;

-- NB: il caricamento delle 37 righe del foglio, le rinomine, le creazioni e le 8
-- fusioni sono state eseguite una tantum (migration applicate
-- `anagrafica_da_notion_personale_mach10` e `fusioni_provate_da_notion`).
-- Non si ripetono qui: il foglio cambia, e rigiocarle sovrascriverebbe le
-- correzioni fatte a mano nel pannello Team.
-- Per riallineare dopo un cambio sul foglio: pannello Team → "Cerca persone nuove",
-- che rilegge le sorgenti e propone gli orfani nuovi senza toccare il resto.
