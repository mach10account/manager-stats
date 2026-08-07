-- Delivery: poter togliere una persona dal conteggio di un ruolo senza toglierla
-- dal team. Serve per chi su Notion compare come consulente di due o tre centri
-- ma project manager non è (caselle condivise, direzione, chi ha ereditato un
-- cliente): finiva in "N project manager attivi" e falsava media e riempimento.
-- Il bottone "Nascondi" nella tabella Carico per <ruolo> scrive qui.
-- I suoi clienti restano in "Clienti in gestione": è la persona a non contare
-- come project manager, non i centri a sparire.
alter table public.fin_capacita
  add column if not exists escluso boolean not null default false;
