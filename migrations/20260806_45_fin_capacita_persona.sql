-- fin_capacita era chiavata sull'EMAIL (la colonna si chiama `nome` ma dentro
-- c'erano indirizzi). Appena la tab Delivery aggrega per PERSONA — due email
-- della stessa persona = una riga sola — non si saprebbe più su quale delle due
-- email leggere la capienza. Quindi la chiave diventa la persona.
--
-- 27 righe al momento della migrazione: 26 si risolvono via ms_persona_alias,
-- 1 no ("DANIELE TESTORE", PM, capienza 0: un nome che non è di nessuno).
-- Il valore vecchio resta in `nome_legacy`, così non si perde traccia.

alter table public.fin_capacita
  add column if not exists persona_id uuid references public.ms_persona(id) on delete cascade;

update public.fin_capacita c
set persona_id = a.persona_id
from public.ms_persona_alias a
where a.chiave = public.ms_key(c.nome) and a.persona_id is not null;

-- dedup difensivo: oggi nessuna collisione, ma appena si uniscono due email
-- della stessa persona due righe dello stesso ruolo collassano. Vince la
-- capienza più alta (una capienza a 0 è quasi sempre un "non l'ho ancora messa").
delete from public.fin_capacita c
using public.fin_capacita d
where c.persona_id is not null and c.persona_id = d.persona_id and c.ruolo = d.ruolo
  and (c.capacita, c.nome) < (d.capacita, d.nome);

-- quello che non si risolve non è una perdita: è un numero che si riscrive in un
-- secondo, e senza persona non ha più un posto dove stare
delete from public.fin_capacita where persona_id is null;

-- la vecchia PK va tolta PRIMA di toccare `nome`: una colonna che sta in una
-- primary key non può perdere il NOT NULL (42P16)
alter table public.fin_capacita drop constraint if exists fin_capacita_pkey;
alter table public.fin_capacita rename column nome to nome_legacy;
alter table public.fin_capacita alter column nome_legacy drop not null;
alter table public.fin_capacita alter column persona_id set not null;
alter table public.fin_capacita add primary key (ruolo, persona_id);

comment on column public.fin_capacita.nome_legacy is
  'Email/nome con cui la riga era chiavata prima della migration 45. Solo storia: non leggerla.';

-- verifica (attesa: 26 righe, 0 senza persona)
-- select count(*) as righe, count(*) filter (where persona_id is null) as orfane from fin_capacita;
