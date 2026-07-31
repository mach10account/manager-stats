-- manager-stats · Task: solo durata, niente ora di fine (richiesta di Leo)
--
-- Prima una task aveva ora_inizio + ora_fine + minuti: tre campi per due
-- informazioni, con il rischio che si contraddicessero. Ora la durata è una
-- sola: `minuti`. L'ora di fine, dove serve (altezza del blocco nel
-- calendario), si calcola come inizio + minuti.
--
-- Le righe esistenti non perdono nulla: dove minuti mancava lo si ricava
-- dall'ora di fine prima di eliminare la colonna.

update public.ms_task
   set minuti = greatest(1, (extract(epoch from (ora_fine - ora_inizio)) / 60)::int)
 where minuti is null and ora_fine is not null and ora_fine > ora_inizio;

alter table public.ms_task drop column if exists ora_fine;

-- la firma di ritorno cambia (via ora_fine): serve drop, non replace
drop function if exists public.ms_task_lista();
create function public.ms_task_lista()
returns table (
  id bigint, titolo text, assegnata_a uuid, assegnato_nome text,
  creata_da uuid, creatore_nome text, centro_id uuid, centro_nome text,
  data date, ora_inizio time, minuti integer,
  categoria text, stato text, esito text, descrizione text,
  n_note integer, creata_a timestamptz)
language sql stable security definer set search_path = public as $$
  select t.id, t.titolo, t.assegnata_a, public.ms_nome_utente(t.assegnata_a),
         t.creata_da, public.ms_nome_utente(t.creata_da), t.centro_id, c.nome,
         t.data, t.ora_inizio, t.minuti,
         t.categoria, t.stato, t.esito, t.descrizione,
         (select count(*)::integer from public.ms_task_nota n where n.task_id = t.id),
         t.creata_a
  from public.ms_task t
  left join public.centri c on c.notion_id = t.centro_id
  where public.ms_puo('task')
    and (t.assegnata_a = any ((select public.ms_team())::uuid[]) or t.creata_da = auth.uid())
  order by t.data desc, t.ora_inizio nulls last, t.id
$$;

revoke all on function public.ms_task_lista() from public, anon;
grant execute on function public.ms_task_lista() to authenticated;
