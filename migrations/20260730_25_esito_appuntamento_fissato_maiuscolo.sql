-- "Appuntamento Fissato" (F maiuscola) è l'etichetta che GHL manda dal cutover webhook
-- del 2026-07-29; l'auto-insert di set_esiti l'ha creata coi default di tabella
-- (e_appuntamento=false) → gli appuntamenti dichiarati con quell'etichetta sparivano
-- dalle statistiche (Giulio: 9 righe al 30/07, di cui 8 solo il 30). Stessa
-- classificazione della variante minuscola. In parallelo il nodo "Mappa chiamata
-- (Supabase)" del wf yF29o3ERSogEJ5lw ora inserisce gli esiti NUOVI con flag
-- euristici case-insensitive invece dei default.
update public.set_esiti set e_appuntamento = true
where esito = 'Appuntamento Fissato';
