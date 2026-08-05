-- Sauron · tab P&L — il conto economico DICHIARATO dei mesi chiusi
--
-- Perche' serve: il P&L che l'app calcola da sola prende i ricavi da fin_incassi
-- (Notion) e i costi da fin_costi, che pero' e' un registro dello STATO DI OGGI
-- (tutte voci mensili che partono dal 2026-01-01, senza storico): applicato a
-- aprile o maggio da numeri che non sono mai esistiti — mancano l'ad spend Meta,
-- la parte fissa dei setter, i compensi amministratori, i costi straordinari.
-- Il conto economico vero dei mesi chiusi lo tiene Leo sul foglio
-- "📥 PL Database Input" (workbook "Generale Salone Vincente 2026"): questa
-- tabella ne e' lo specchio, ed e' il dato UFFICIALE dei mesi che ci sono dentro.
-- Stessa scelta gia' fatta per il Marketing (fin_marketing): mese chiuso = foglio,
-- mese in corso = calcolato dal vivo.
--
-- 1 riga = 1 voce del foglio in 1 mese. Riga assente = casella vuota sul foglio
-- (non compilata); importo 0 = il foglio dice "-" (zero vero).
-- I subtotali (RICAVI NETTI, MARGINE LORDO/OPERATIVO/NETTO) NON si salvano:
-- l'app li ricalcola sommando le voci — verificato in import, tornano al centesimo
-- su tutti e quattro i mesi.

create table if not exists public.fin_pnl (
  mese         text not null check (mese ~ '^\d{4}-\d{2}$'),
  voce         text not null,                       -- etichetta come sul foglio
  sezione      text not null                        -- posto nella scala del P&L
    check (sezione in ('ricavi', 'rimborsi', 'diretti', 'operativi', 'strutturali', 'info')),
  tipo         text not null default 'voce'         -- 'dettaglio' = le righe "di cui:",
    check (tipo in ('voce', 'dettaglio')),          --   informative, NON si sommano
  ordine       int  not null default 0,             -- ordine di stampa (= ordine sul foglio)
  importo      numeric,
  fonte        text default 'PL Database Input',
  aggiornato_a timestamptz not null default now(),
  primary key (mese, voce)
);
comment on table public.fin_pnl is
  'Conto economico dichiarato dei mesi chiusi (foglio "PL Database Input"), 1 riga = 1 voce di 1 mese. Solo admin.';

alter table public.fin_pnl enable row level security;

-- stesso schema di fin_costi: 'finance' non ha ramo in ms_puo → passa solo admin.
drop policy if exists finance_all on public.fin_pnl;
create policy finance_all on public.fin_pnl
  for all to authenticated
  using ((select public.ms_puo('finance')))
  with check ((select public.ms_puo('finance')));

revoke all on public.fin_pnl from anon;
grant select, insert, update, delete on public.fin_pnl to authenticated;

create index if not exists fin_pnl_mese_idx on public.fin_pnl (mese);
