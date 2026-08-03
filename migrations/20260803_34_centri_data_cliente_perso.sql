-- Finance / dashboard generale: churn "Clienti persi nel mese".
-- centri.data_cliente_perso ← Notion DATABASE CLIENTI > DATA CLIENTE PERSO (date),
-- sync WF-M1 (TnTiV6uwKViJUwtc). Area 'comune': la vede chiunque abbia una sezione.
alter table public.centri add column if not exists data_cliente_perso date;
