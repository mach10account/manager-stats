-- manager-stats · Fase 0 · seed mkt_esiti (41 opzioni ESITO di DATABASE LEAD CLIENTI, schema letto 2026-07-08)
-- I 4 esiti-appuntamento rispecchiano la regola del warehouse chiamate (CRM4 {63,64,67,82}).
-- needs_review=true = da confermare con Leo nel Table Editor; il sync auto-inserisce
-- eventuali opzioni nuove come class='unknown', needs_review=true.

insert into public.mkt_esiti (esito, is_appuntamento, class, needs_review) values
  -- appuntamento (canonici, allineati al warehouse chiamate)
  ('Appuntamento confermato',                    true,  'appuntamento',   false),
  ('Appuntamento da cellulare personale',        true,  'appuntamento',   false),
  ('Appuntamento Con Acconto in chiamata',       true,  'appuntamento',   false),
  ('ACCONTO PAGATO',                             true,  'appuntamento',   false),
  -- in lavorazione (attesa acconto NON è appuntamento finché non paga — regola Leo)
  ('Appuntamento attesa acconto',                false, 'in_lavorazione', false),
  ('Appuntamento con l''attesa acconto',         false, 'in_lavorazione', false),
  ('Appuntamento con attesa acconto in negozio', false, 'in_lavorazione', false),
  ('REMINDER ATTESA ACCONTO',                    false, 'in_lavorazione', false),
  ('Non risponde',                               false, 'in_lavorazione', false),
  ('Occupato',                                   false, 'in_lavorazione', false),
  ('Segreteria da richiamare',                   false, 'in_lavorazione', false),
  ('Richiamo pubblico',                          false, 'in_lavorazione', false),
  ('Richiamo importante (personale)',            false, 'in_lavorazione', false),
  ('1 RICHIAMO NO RISP',                         false, 'in_lavorazione', false),
  ('2 RICHIAMO NO RISP',                         false, 'in_lavorazione', false),
  ('3 RICHIAMO NO RISP',                         false, 'in_lavorazione', false),
  ('5 RICHIAMO STOP CALL',                       false, 'in_lavorazione', false),
  ('DOPPIO SQUILLO Cellulare',                   false, 'in_lavorazione', false),
  ('DOPPIO SQUILLO Cellulare personale',         false, 'in_lavorazione', false),
  ('Ricontattabile',                             false, 'in_lavorazione', false),
  ('Fax da richiamare',                          false, 'in_lavorazione', false),
  -- persi
  ('Non interessato',                            false, 'perso',          false),
  ('Non in target',                              false, 'perso',          false),
  ('Fuorizona',                                  false, 'perso',          false),
  ('Già Cliente',                                false, 'perso',          false),
  ('APPUNTAMENTO DISDETTO',                      false, 'perso',          false),
  ('ACCONTO NON PAGATO',                         false, 'perso',          false),
  ('ACCONTO NON SALDATO',                        false, 'perso',          false),
  ('MAI RISPOSTO (Tentativi Misti)',             false, 'perso',          false),
  ('Numero errato',                              false, 'perso',          false),
  ('Blacklist - Iscritto al FUB',                false, 'perso',          false),
  ('Fax da non contattare più',                  false, 'perso',          false),
  ('Segreteria da non contattare più',           false, 'perso',          false),
  ('Occupato da non contattare più',             false, 'perso',          false),
  -- non validi (righe tecniche)
  ('Errore',                                     false, 'non_valido',     false),
  ('Lead da Api',                                false, 'non_valido',     false),
  -- ambigui: Leo decide nel Table Editor
  ('OK - Contratto',                             false, 'unknown',        true),
  ('OK - Appuntamento con consulente',           false, 'unknown',        true),
  ('Contatto passato al centro',                 false, 'unknown',        true),
  ('Appuntamento con acconto in negozio',        false, 'unknown',        true),
  ('CLIENTE PRESO IN GESTIONE DAL CENTRO',       false, 'unknown',        true)
on conflict (esito) do nothing;
