-- I setter che hanno lasciato l'azienda non compaiono più in GET /users/?locationId=,
-- ma i loro userId restano dentro i record chiamata: senza mappa la tabella "Al telefono
-- davvero" mostrava 4 righe con l'id grezzo al posto del nome.
--
-- Risolti per VOTO DI MAGGIORANZA sui dati, non a mano: per ogni userId non mappato si
-- cercano gli esiti dello stesso contatto nella stessa finestra temporale della chiamata
-- e si prende il setter_raw più frequente. Tutti e 12 con accordo al 100%, zero ambigui.
-- Dopo l'inserimento restano 3 chiamate su 21.646 con userId non risolto.
--
-- Query di riconciliazione (rilanciabile quando entrano setter nuovi):
--   with da_mappare as (
--     select distinct c.user_id from set_chiamate_ghl c
--     left join set_utenti_ghl u on u.user_id = c.user_id
--     where u.user_id is null and c.user_id is not null),
--   voti as (
--     select c.user_id, s.setter_raw, count(*) n
--     from set_chiamate_ghl c join da_mappare d on d.user_id = c.user_id
--     join set_chiamate s on s.ghl_contact_id = c.ghl_contact_id
--       and s.creata_a >= c.quando - interval '1 minute'
--       and s.creata_a <= c.quando + make_interval(secs => coalesce(c.durata_s,0)) + interval '10 minutes'
--     where s.setter_raw is not null group by 1,2)
--   select * from voti order by n desc;

insert into public.set_utenti_ghl (user_id, nome)
select v.user_id, coalesce(m.setter, initcap(trim(v.setter_raw)))
from (values
  ('BVtxtwI4WIbNfWdqnuVs','Filip Dabizljevic'),
  ('IbCIxEdARkJfQEvByDj0','Sara gc'),
  ('jGTTsoxgBXx6jljWPO5I','Marco Truscello'),
  ('oEzyYE7eKqMkI084AQyp','Nicolas Milone'),
  ('5aTKKrpNCEbOuE6vCC7A','Mike Mike'),
  ('KbeJ0omLxWbRyIRDU5sd','Alessandro Pistolesi'),
  ('sZiWcXM8lYwdaL9oLQV5','Leonardo Cati'),
  ('xnj3uIpCiiPJbIHKV9FS','Francesco Brioso'),
  ('UplRML36IzUNBt9MRnc7','Simona Ciocanau'),
  ('tHDZsHBNCSArmgpgJrDg','Matilde b'),
  ('UHotubAFrRUBAzVHSw7B','Carlos Podetti'),
  ('WLODXXsGYjLKqLBSGVyg','Mike Mike')
) as v(user_id, setter_raw)
left join public.set_setter_map m on m.setter_raw = v.setter_raw
on conflict (user_id) do update set nome = excluded.nome;

-- Utenti attivi al 2026-07-29 (da GET /users/?locationId=, con il PIT).
insert into public.set_utenti_ghl (user_id, nome) values
  ('8WrDuoOGp1dkpwTjzdEl', 'Simone Di Cino'),
  ('Fy7GKVoaN8u84R6O5Tmn', 'Maria Dello Jacono'),
  ('mmaQy85KoCnSVujvaRNX', 'Valentina Moschetta'),
  ('hpHW7VFuOPsatFQSCfTI', 'Giulio Mannozzi'),
  ('iwjlcguakF746PpWy0Y2', 'Federico De Vecchis'),
  ('2BUOTH8iLCLaro4ZxQ2e', 'Luca Biancardi'),
  ('BGMkNS0vzXxj6Bwp6GTU', 'Giada Perronace'),
  ('pU5de9g3wHuLmNFAXovV', 'Alessandro Fiorini'),
  ('oZexsLkNWrrSbg6QYq8F', 'Sara Pietrolucci'),
  ('CNsrwH5CgScGIYMnfFNs', 'Stefano Aiello'),
  ('JBUuU49WZMaAG5FVz4pH', 'Giuseppe D''angelo'),
  ('eHrTUlp3UPkLScf3aAyR', 'Lorenzo Carasso'),
  ('7K6pHg1eXCEVJHTGwWSy', 'Lorenzo Carasso'),
  ('IMqf1rMhrDu94UVbKqE0', 'Matteo Carasso'),
  ('50LEAAYr3Tfk8d7EltE1', 'Matteo Carasso'),
  ('1BNeDASxFHEcKojcKUQ9', 'Federico Giuntoli'),
  ('FVT9cuTE6Qpwnxx5Yjjq', 'Leonardo Marazzi'),
  ('24UYFbwyAZNP8N5pbbt1', 'Samuele Lattanzio')
on conflict (user_id) do nothing;
