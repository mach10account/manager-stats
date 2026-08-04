-- Viste tipizzate sopra il mirror Notion (vedi 20260804_37_notion_mirror.sql):
-- i campi che si usano davvero, già col tipo giusto. nx_data() converte in fuso
-- Europe/Rome, perché Notion salva UTC e i report si leggono in ora locale.

create or replace function public.nx_txt(p jsonb) returns text language sql immutable as $$
  select case jsonb_typeof(p)
    when 'string' then nullif(p #>> '{}', '')
    when 'number' then p #>> '{}'
    when 'array'  then nullif(array_to_string(array(select jsonb_array_elements_text(p)), ', '), '')
    else null end
$$;

create or replace function public.nx_num(p jsonb) returns numeric language sql immutable as $$
  select case
    when jsonb_typeof(p) = 'number' then (p #>> '{}')::numeric
    when jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^-?[0-9]+([.,][0-9]+)?$'
         then replace(p #>> '{}', ',', '.')::numeric
    when jsonb_typeof(p) = 'array' and jsonb_typeof(p->0) = 'number' then (p->>0)::numeric
    else null end
$$;

create or replace function public.nx_ts(p jsonb) returns timestamptz language sql immutable as $$
  select case
    when jsonb_typeof(p) = 'string' and (p #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
         then (p #>> '{}')::timestamptz
    when jsonb_typeof(p) = 'array' and jsonb_typeof(p->0) = 'string'
         and (p->>0) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then (p->>0)::timestamptz
    else null end
$$;

create or replace function public.nx_data(p jsonb) returns date language sql immutable as $$
  select (public.nx_ts(p) at time zone 'Europe/Rome')::date
$$;

create or replace function public.nx_arr(p jsonb) returns text[] language sql immutable as $$
  select case jsonb_typeof(p)
    when 'array'  then array(select jsonb_array_elements_text(p))
    when 'string' then array[p #>> '{}']
    else null end
$$;

create or replace view public.v_notion_contratti with (security_invoker = on) as
select notion_id, titolo as nome_centro, url,
       public.nx_txt(props->'ID CONTRATTO')            as id_contratto,
       public.nx_txt(props->'ID CLIENTE')              as id_cliente,
       public.nx_data(props->'CREAZIONE CONTRATTO')    as creazione_contratto,
       public.nx_data(props->'INIZIO SERVIZIO')        as inizio_servizio,
       public.nx_data(props->'FINE SERVIZIO')          as fine_servizio,
       public.nx_arr(props->'STATO DEL CONTRATTO')     as stato,
       public.nx_arr(props->'AGENZIA')                 as agenzia,
       public.nx_arr(props->'SERVIZIO')                as servizio,
       public.nx_arr(props->'DURATA CONTRATTO')        as durata,
       public.nx_arr(props->'TIPOLOGIA DEL CONTRATTO') as tipologia_pagamento,
       public.nx_num(props->'VALORE CONTRATTO')        as valore,
       public.nx_num(props->'INCASSATO (NUM)')         as incassato,
       public.nx_arr(props->'VENDITORE')               as venditore,
       public.nx_arr(props->'SETTER')                  as setter,
       public.nx_arr(props->'DATABASE CLIENTI')        as cliente_ids,
       public.nx_arr(props->'DATABASE CONTRATTI')      as valore_ids,
       created_time, last_edited, synced_at, props
  from public.notion_contratti;

create or replace view public.v_notion_incassi with (security_invoker = on) as
select notion_id, titolo as id_incasso, url,
       public.nx_txt(props->'(FORMULA) NOME CENTRO O STUDIO') as nome_centro,
       public.nx_txt(props->'ID CONTRATTO')             as id_contratto,
       public.nx_num(props->'IMPORTO RATA')             as importo,
       public.nx_num(props->'RATA NUMERO')              as rata_numero,
       (props->>'PAGATO?')::boolean                     as pagato,
       public.nx_data(props->'DATA INCASSO')            as data_incasso,
       public.nx_data(props->'DATA SCADENZA PAGAMENTO') as data_scadenza,
       public.nx_data(props->'DATA CREAZIONE CONTRATTO') as creazione_contratto,
       public.nx_arr(props->'TIPO DI CONTRATTO')        as tipo_contratto,
       public.nx_arr(props->'AGENZIA')                  as agenzia,
       public.nx_txt(props->'TIPOLOGIA PAGAMENTO 1')    as tipologia_pagamento,
       public.nx_arr(props->'VENDITORE')                as venditore,
       public.nx_arr(props->'SETTER')                   as setter,
       public.nx_txt(props->'(FORMULA) CONSULENTE')     as consulente,
       public.nx_num(props->'COMMISSIONE VENDITORE (€)') as comm_venditore,
       public.nx_num(props->'COMMISSIONE SETTER (€)')   as comm_setter,
       public.nx_arr(props->'NOME CENTRO O STUDIO')     as contratto_ids,
       created_time, last_edited, synced_at, props
  from public.notion_incassi;

create or replace view public.v_notion_valore_contratti with (security_invoker = on) as
select notion_id, titolo as nome_centro, url,
       public.nx_txt(props->'ID CONTRATTO')         as id_contratto,
       public.nx_num(props->'VALORE CONTRATTO')     as valore,
       public.nx_data(props->'CREAZIONE CONTRATTO') as creazione_contratto,
       public.nx_arr(props->'STATO CONTRATTO')      as stato,
       public.nx_arr(props->'AGENZIA')              as agenzia,
       public.nx_arr(props->'DATABASE CLIENTI')     as contratto_ids,
       public.nx_txt(props->'ALTRI DETTAGLI PAGAMENTO') as dettagli_pagamento,
       created_time, last_edited, synced_at, props
  from public.notion_valore_contratti;

create or replace view public.v_notion_clienti with (security_invoker = on) as
select notion_id, titolo as nome_centro, url,
       public.nx_txt(props->'ID CLIENTE')            as id_cliente,
       public.nx_txt(props->'NOME DEL CLIENTE')      as referente,
       public.nx_arr(props->'STATO ATTIVITÀ')        as stato_attivita,
       public.nx_arr(props->'AGENZIA')               as agenzia,
       public.nx_arr(props->'CONSULENTE')            as consulente,
       public.nx_arr(props->'MEDIA BUYER')           as media_buyer,
       public.nx_arr(props->'BEAUTY')                as beauty,
       public.nx_data(props->'INIZIO SERVIZIO')      as inizio_servizio,
       public.nx_data(props->'FINE SERVIZIO')        as fine_servizio,
       public.nx_data(props->'DATA CLIENTE PERSO')   as data_cliente_perso,
       public.nx_data(props->'DATA RINNOVO')         as data_rinnovo,
       public.nx_data(props->'DATA CREAZIONE LEAD')  as data_creazione_lead,
       public.nx_num(props->'Active Days')           as active_days,
       public.nx_num(props->'VALORE TOTALE CLIENTE') as valore_totale,
       public.nx_num(props->'INCASSI TOTALI CLIENTE') as incassi_totali,
       public.nx_txt(props->'NUMERO DI TELEFONO')    as telefono,
       public.nx_txt(props->'ID GHL')                as id_ghl,
       public.nx_txt(props->'FACEBOOK AD ACCOUNT ID') as fb_ad_account_id,
       public.nx_txt(props->'ID GRUPPO WHATSAPP')    as id_gruppo_whatsapp,
       public.nx_arr(props->'DATABASE CONTRATTI')    as contratto_ids,
       created_time, last_edited, synced_at, props
  from public.notion_clienti;

grant select on public.v_notion_contratti, public.v_notion_incassi,
                public.v_notion_valore_contratti, public.v_notion_clienti to authenticated;
