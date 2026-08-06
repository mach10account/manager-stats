# manager-stats

Dashboard interna dei manager di Salone Vincente (agenzia marketing per centri estetici).
Live: **https://mach10account.github.io/manager-stats/** — GitHub Pages (branch `main`, root, Jekyll legacy).
Login Supabase Auth (email+password); gli utenti li creano gli admin dal pannello Accessi (edge function `ms-invita`).
Lingua del progetto: **italiano** (UI, commit, commenti).

## Sezioni (`js/sections/`)

| Rotta | File | Cosa |
|---|---|---|
| `#/panoramica` | panoramica.js | KPI per centro; click su una riga → drill-down `#/marketing?centro=X` (rotta nascosta, tab Campagne/Adset/Ad + funnel del periodo) |
| `#/coorti` | coorti.js | Coorti mensili lead |
| `#/beauty` | beauty.js | Chiamate CRM4 dei centri (alias legacy `#/chiamate`) |
| `#/vendita` | vendita.js | Setter B2B: chiamate GHL, report attività da stage opportunità, speed-to-lead |
| `#/task` | task.js | Task del team (lista + calendario settimana) — prima funzione di SCRITTURA |
| `#/sauron` | sauron.js | Finance, **solo admin** (alias `#/finance`): Dashboard, Costi, P&L, Delivery, Clienti & LTV, Report, Marketing |
| `#/accessi` | accessi.js + team.js | Admin: login/permessi + anagrafica Team |

## Stack — zero build

- HTML/CSS/JS statici, ES modules nativi. **Niente bundler, niente npm, niente framework.**
- supabase-js via CDN jsDelivr, versione **pinnata** in `js/config.js` (mai `@2` generico).
- Moduli condivisi: `data.js` (fetch + anagrafica persone), `tables.js`/`charts.js` (render), `format.js`, `filters.js` (barra filtri globale), `router.js` (hash routing), `supabase.js` (client + auth), `idle.js` (scadenza sessione), `track.js` (log utilizzo), `modal.js`.
- `css/app.css` unico foglio. Design system: gradiente turchese→blu (`--brand-grad`), serif Playfair Display, dark mode navy. Palette grafici validata: light `#2270d8`/`#0f9f85`, dark `#3d8be8`/`#14a88c`, `--series-3` rame. ⚠️ `svg text { font-family: inherit }` in app.css vince sugli attributi SVG.

## Deploy e cache — leggere PRIMA di toccare qualsiasi .js

- Deploy = commit **diretto su `main`** + push (niente PR nella storia di questo repo). Pages builda da sola in <1 min: `gh api repos/mach10account/manager-stats/pages/builds/latest`.
- ⚠️ **CACHE**: Pages serve i `.js` con `max-age=600`. Convenzione: `index.html` carica `app.js?v=NOME` e `app.js` importa le sezioni con `?v=N`. A ogni modifica di un modulo **bumpa il suo `?v=` E quello di `app.js` in index.html** — dimenticarlo = utenti con l'app vecchia o rotta a metà (sintomo classico: "la nuova sezione mi rimanda a Panoramica").
- Verifica live: `curl` con cache-buster (`?cb=123`), oppure browser in incognito / hard-refresh (⌘⇧R).
- Sviluppo locale: l'app è dietro login → per lavorare sulla UI pura creare un `mock.html` che importa i moduli di render (tables/charts/format) con dati finti, senza `supabase.js`.

## Database — Supabase, progetto `ueejjgocuvmmkxsogdvu`

Prefissi: `mkt_`/`perf_`/`fb_` (marketing centri) · `calls`/`leads`/`esiti` (beauty CRM4) · `set_` (vendita B2B) · `fin_` (finance, solo admin) · `notion_` (mirror Notion) · `ms_` (piattaforma: accessi, task, persone) · `kb_` (procedure operative per l'assistente).

**RLS per sezione**
- `ms_accessi(user_id, email, sezioni[], attivo)` + guardia `ms_puo(area)` (**security definer**, obbligatorio: la policy di ms_accessi chiama ms_puo che legge ms_accessi → senza definer è ricorsione).
- Tutte le viste sono `security_invoker=on` e le RPC `api_*` invoker → la RLS si propaga da sola; le policy servono **solo sulle tabelle base**.
- ⚠️ Policy sempre `using ((select ms_puo('area')))` — senza il `(select …)` Postgres rivaluta la funzione **per riga** (misurato: 778ms → 41ms). Vale per qualsiasi funzione in una policy, `auth.uid()` compreso.
- ⚠️ **POLICY, mai REVOKE**: un `permission denied` manda il frontend al login. Le righe negate devono semplicemente non esistere.
- Scoping per centro: `ms_centri_di`/`ms_centri_scope` (consulente = email che matcha `centri.consulente`, `centri_visibili[]`, media_buyer). Scope NULL = vede tutto. ⚠️ `x = any((select f()))` non compila: serve il cast `any(((select f()))::uuid[])`.
- Test RLS impersonando un utente (senza `set local role` il test MENTE, superuser bypassa):
  ```sql
  select set_config('request.jwt.claims', json_build_object('sub','<uuid>')::text, true);
  set local role authenticated;
  select count(*) from v_panoramica_centro;
  ```

## ⚠️ LA REGOLA PIÙ IMPORTANTE: migrations = storia, NON stato

- I file in `migrations/` si applicano a mano nel DB e si committano come **storia**. Alcuni sono stub ("vedi il DB per il corpo completo"). Il corpo vivo di una vista sta **solo nel DB**.
- Prima di ogni `create or replace view`: leggi il corpo vivo con `select pg_get_viewdef('public.<vista>'::regclass, true)` e modifica **quello**. Copiare il corpo da una vecchia migration ha già cancellato in silenzio un fix (gate esiti) falsando il funnel per 5 giorni — la migration 48 è il ripristino.
- `create or replace view` ammette solo **append** di colonne in coda e non cambia i tipi delle esistenti (castare esplicitamente, es. `::numeric`).
- Dopo ogni replace: confrontare un numero noto prima/dopo.
- Migration nuove: `YYYYMMDD_NN_nome.sql`, `NN` progressivo sull'ultimo presente.

## Da dove arrivano i dati

L'app in gran parte **legge soltanto**: a scrivere sono workflow n8n (istanza `n8n.srv1035791.hstgr.cloud`, serve un accesso a parte) che sincronizzano Notion, GHL, CRM4 e Facebook in Supabase — sync orari o notturni, più webhook di lancio manuale (URL dentro i workflow). Principali: WF-M1 centri (notturno, full-refresh: `centri` si RIFÀ ogni notte) · WF-M2/M3 lead+appuntamenti (orari) · WF-M5 FB insights ad-level (orario) · WF-M7 incassi/contratti · WF-M8 mirror `notion_*` · WF-M9 `fin_marketing` dal foglio KPI · realtime chiamate setter da webhook GHL.

Scrive invece **l'app** (PostgREST diretto sotto RLS): `fin_costi`, `fin_capacita`, `fin_mkt_mese`, `fin_vendita`, `ms_task`(+note), pannelli Accessi/Team (RPC `ms_*`).

## Convenzioni dati — sbagliarle = numeri falsi

- **Ratio sempre dai TOTALI del periodo, mai media di ratio per riga.** CPL = spesa/lead_fb · %show = presenze/(presenze+non_presentati) · %chiusura = pacchetti/presenze.
- **Campo vuoto ≠ zero**: `safeDiv(null, x)` fa 0 → per i KPI con numeratore mancante usare l'helper che torna `—`. Non "correggere" in `|| 0`.
- **"Appuntamento fissato"** (funnel centri) = SOLO esito del lead con `class='appuntamento'` in `mkt_esiti`. MAI dalla presenza di una riga in `appuntamenti` (include i disdetti).
- **Risposte** = `esiti.is_answered` sull'ultima chiamata CRM4 — unica fonte di verità, non derivarle dall'esito Notion.
- **Coorte** = mese di CREAZIONE del lead (regola del foglio KPI, coerente con CPL/CAC/ROAS); il blocco Vendita conta per ultimo cambio stage. ⚠️ `set_opportunita` conserva solo l'ULTIMO cambio stage → i mesi passati cambiano nel tempo: documentato e accettato.
- **Contratti** da `v_notion_contratti` (mirror del vero DB CONTRATTI), non da `fin_contratti` (che resta popolata ma non letta).
- **P&L**: mesi chiusi dal foglio (`fin_pnl`), mese corrente calcolato. `fin_costi` è lo stato di OGGI, inutile sul passato.
- **Churn** (Sauron → Delivery) = coorte di **FINE SERVIZIO**: dei clienti a cui il servizio finiva nel mese, quanti oggi hanno il tag `CLIENTE PERSO/SPARITO`. Numeratore e denominatore sono lo stesso gruppo. ⚠️ **Matura**: il tag arriva in media 4 mesi dopo la fine servizio → gli ultimi 3-4 mesi sono sempre sottostimati. Da non confondere con la tile **"Clienti persi"**, che conta la `DATA CLIENTE PERSO` nel mese (= quando li abbiamo *segnati*, non quando se ne sono andati; e metà dei persi non ce l'ha compilata).
- **Nomi persone**: mai dedurli dai dati — c'è l'anagrafica `ms_persona`/`ms_persona_alias` (`nomeDi()` in data.js). Si traducono solo le ETICHETTE: le email restano le chiavi di filtri e scoping.

## Trappole note nel codice

- `esc()` (format.js): la catena di replace DEVE iniziare da `&`, e escapa anche `"` e `'`.
- CSP nel `<meta>` di index.html: `script-src` senza `unsafe-inline` → niente handler inline (`onclick="…"`), solo `addEventListener`.
- `idle.js`: scadenza per **timestamp**, non countdown (il portatile che dorme); una ricarica NON azzera l'inattività; `signOut()` non lancia, torna `{error}`. Un login **con password** azzera SEMPRE i timbri (flag `loginConPassword` in app.js, alzato PRIMA dell'`await signIn`): senza, i timbri di una sessione revocata da un altro device (signOut è a scope globale) respingevano il primo login e solo il secondo entrava.
- `isAuthError` (supabase.js): `permission denied` NON è sessione scaduta.
- Formattazione numeri: `useGrouping:'always'` (in italiano il separatore parte da 5 cifre).
- `renderLineChart` (charts.js): `minY = Math.min(0, …)` per le serie negative (il mese in corso parte sottozero).
- Performance: `fetchAll` pagina da 1000 e `v_panoramica_centro` costa ~1,3s/pagina; l'istanza satura a ondate quando i sync si accavallano con gli utenti — un 500 con codice `57014` (statement timeout) di solito NON è un bug della query nuova.
- Debito noto: `boot()` non è idempotente al rilogin nella stessa tab (listener doppi).

## 🚨 Repo PUBBLICO — cosa non deve entrare

- GitHub Pages pubblica **l'intero repo** come sito; `_config.yml` esclude `migrations/` dal sito — **non rimuovere quell'exclude**. I file restano comunque visibili su github.com.
- Mai committare: segreti/token/service key (l'unica chiave ammessa è la publishable in `config.js`, pubblica by design), dati personali (nomi con compensi, email private del team), URL di webhook non autenticati.
- Seed o dati sensibili: applicarli solo nel DB, nel file di migration committato lasciare uno stub.

## Assistente AI (bolla flottante, ogni sezione)

- `js/assistente.js` monta una bolla in basso a destra (host `#asHost` appeso al `body`, nascosto sul login da `#shell.hidden ~ #asHost`). Init dentro `boot()` **dopo** `initFilters()`: legge il periodo selezionato per dare senso a "questo mese". `resetAssistente()` in `showLogin()` — la conversazione non deve sopravvivere al cambio utente.
- Backend: edge function **`ms-assistente`** (Claude Opus 5). Tre strumenti: `leggi_procedura`, `cerca_procedure` (RPC `kb_cerca`, full-text italiano), `interroga_dati` (PostgREST su una whitelist di viste).
- ⚠️ **Nessun modello di permessi nuovo**: ogni query passa il **JWT dell'utente**, quindi la RLS esistente (`ms_puo`/`ms_centri_scope`) decide cosa è visibile. Non aggiungere filtri per centro "di sicurezza" nel prompt o nel codice: sarebbero decorativi e darebbero una falsa garanzia.
- Il system prompt contiene l'**indice** delle procedure ed è marcato `cache_control` (prompt caching): tutto ciò che varia per utente o per richiesta (data, email, sezione, periodo) sta nel **secondo** blocco, non cacheato. Spostarlo nel primo blocco rompe la cache per tutti.
- Il prompt ripete le convenzioni di calcolo qui sotto: se cambia una definizione di KPI va aggiornata **anche lì**, altrimenti l'assistente dà numeri diversi dalla dashboard.
- Diagnostica: `POST` con `{"diagnostica": true}` → dice se il segreto Anthropic c'è, se l'apikey è iniettata e se la KB è leggibile, senza rivelare nulla.
- Richiede il segreto **`ANTHROPIC_API_KEY`** nel progetto Supabase. Facoltativi: `ASSISTENTE_MODELLO`, `ASSISTENTE_EFFORT`.
- Storico: `ms_chat` + `ms_chat_messaggio`, RLS su `auth.uid() = user_id` — **le conversazioni non le legge nessun altro, admin compresi** (qui non c'è `ms_puo`). La edge function salva la domanda *prima* di chiamare il modello, così una risposta mai arrivata non fa sparire la conversazione. La lista e l'apertura passano da PostgREST diretto (supabase-js), non dalla funzione.
- Knowledge: tabella `kb_documenti`, popolata ogni notte alle 04:10 da **WF-KB** (n8n `sMTpKJfUa41Qs2Fk`) dal Drive "STRUTTURA E GESTIONE". Esclude la cartella *"da eliminare"* (flussi 01-04 superati) e gli shortcut, che sono duplicati. Le cartelle `F07 - BS/Gestione Lead` e `FO6 - Off-Boarding` sono **vuote a monte**: su quei temi l'assistente non ha materiale.

## Chi decide cosa

- Leo (owner) decide schema dati, definizioni dei KPI e convenzioni Notion. In dubbio su una definizione → chiedere, non dedurre.
- Modifiche al DB richiedono accesso al progetto Supabase; modifiche frontend bastano repo + push su `main`.
