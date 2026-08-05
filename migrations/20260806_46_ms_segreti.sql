-- Segreti che servono alle Edge Function e a nessun altro.
--
-- Nasce per l'invito su WhatsApp: il token Wassenger vive in una credenziale n8n,
-- che via API non è leggibile — e giusto così, un segreto non si duplica. Quindi
-- il messaggio lo manda n8n (WF-M10 `6Ymhu2NjVv3zgUaX`, webhook
-- /webhook/ms-invito-wa-7c1e94) e la Edge Function ms-invita gli dice solo cosa
-- scrivere e a chi.
--
-- Quel webhook è un URL pubblico: va protetto da un header segreto. Ma quel
-- segreto non può stare (a) nel sito, che è pubblico, né (b) nei secret della EF,
-- che dal server MCP non si impostano. Sta qui: la EF ha la service key e lo legge.
-- Stesso schema di academy_secret dell'Academy.

create table if not exists public.ms_segreti (
  nome     text primary key,
  valore   text not null,
  note     text,
  creato_a timestamptz not null default now()
);

alter table public.ms_segreti enable row level security;
-- nessuna policy = nessuno lo legge via PostgREST. Solo service_role (che bypassa
-- la RLS) e il proprietario della tabella.
revoke all on public.ms_segreti from anon, authenticated;

create or replace function public.ms_segreto(p_nome text) returns text
language plpgsql security definer set search_path = public as $fn$
begin
  -- ⚠️ solo la service key: un utente loggato, anche admin, non deve poter
  -- leggere di qui il segreto del webhook.
  if coalesce(current_setting('request.jwt.claim.role', true),
              current_setting('role', true)) is distinct from 'service_role' then
    raise exception 'non autorizzato';
  end if;
  return (select valore from public.ms_segreti where nome = p_nome);
end $fn$;

revoke all on function public.ms_segreto(text) from public, anon, authenticated;
grant execute on function public.ms_segreto(text) to service_role;

insert into public.ms_segreti (nome, valore, note)
values ('wa_webhook', encode(gen_random_bytes(32), 'hex'),
        'Header x-ms-token del webhook n8n che manda l''invito su WhatsApp (WF-M10). Lo legge la EF ms-invita con la service key.')
on conflict (nome) do nothing;

-- ⚠️ Se si rigenera il valore va rifatta anche la credenziale n8n
-- "manager-stats — invito WA (header segreto)" (httpHeaderAuth Ev5GDhO2YuHA1IUe),
-- altrimenti il webhook risponde 403 e l'invito resta col solo copia-link.
