# Family Hub — gestione familiare

Una webapp in italiano per organizzare le finanze e la vita quotidiana in uno spazio condiviso. Ogni persona ha un account personale; i membri della stessa famiglia vedono gli stessi dati.

## Installazione sul dispositivo

Dal sito pubblicato, usa **Installa app** nel browser Android/desktop oppure **Condividi → Aggiungi alla schermata Home** in Safari su iPhone. Il nome è **Family Hub** e l'apertura avviene in una finestra dedicata. Serve una connessione per accedere ai dati condivisi.

Il manifest e il titolo per iOS fissano il nome indipendentemente dalla sezione aperta. `public/family-hub.svg` è il logo condiviso da interfaccia e favicon: quadrato verde inclinato di 12° e casa bianca dritta. Le icone PNG di installazione sono esportate dallo stesso SVG, con una variante che lascia spazio al ritaglio delle icone Android.

Un'installazione precedente può conservare nome e icona: in quel caso rimuovila e aggiungila nuovamente dal sito. I dati restano nell'account sul server.

## Entrate, uscite e ripartizione budget

Il menu mostra **Panoramica**, **Ripartizione budget**, **Entrate**, **Uscite**, poi le altre sezioni della casa.

Entrate e Uscite hanno lo stesso flusso: il pulsante superiore aggiunge una registrazione occasionale; selezionando **Ricorrente (ogni mese)** compaiono giorno, mese iniziale e termine facoltativo. Il modulo è dedicato al tipo di movimento della sezione. Le ricorrenze e le registrazioni del mese sono mostrate in due sezioni separate.

Ogni ricorrenza produce un solo movimento per mese. Il giorno 31 viene adattato ai mesi più corti. Le ricorrenze recuperano i mesi mancanti fino a quello corrente; visualizzare un mese futuro crea le registrazioni pianificate di quel mese. Il totale mensile include l'intero mese. Non vengono eseguiti incassi o pagamenti bancari.

Una modifica alla ricorrenza ha un mese di validità e conserva lo storico precedente e le correzioni manuali. Eliminare un singolo movimento ricorrente lo salta soltanto per quel mese. **Sospendi** interrompe la ricorrenza dal mese scelto. **Elimina ricorrenza**, dopo conferma, rimuove la regola e tutti i suoi movimenti collegati, inclusi quelli precedenti o modificati a mano: serve a correggere inserimenti errati. Le altre registrazioni rimangono invariate. Fino a 100 ricorrenze per famiglia; mese iniziale fino a dieci anni prima.

Le Scadenze sono promemoria con eventuale pagamento manuale: evita di registrare lo stesso pagamento anche tra le uscite ricorrenti. Un reddito già registrato può duplicarsi creando la sua ricorrenza dallo stesso mese: scegli il mese successivo o rimuovi il duplicato.

**Ripartizione budget → Modifica schema** offre quattro schemi fissi e **Pers.**, il solo modificabile:

| Schema | Casa e bollette | Alimentari | Trasporti | Salute e famiglia | Svago | Risparmio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Conservativa | 30% | 15% | 10% | 5% | 5% | 35% |
| Prudente | 35% | 20% | 10% | 10% | 10% | 15% |
| Equilibrata | 35% | 15% | 10% | 5% | 15% | 20% |
| Svago | 30% | 15% | 10% | 5% | 30% | 10% |
| Pers. | Composizione della famiglia | | | | | |

**Salva schema** applica la scelta. Nei predefiniti, nomi e percentuali sono fissi anche lato server. In Pers. sono modificabili e devono sommare esattamente il 100%. Applicare un predefinito conserva Pers. e gli identificativi delle categorie, quindi non cambia i movimenti. Le precedenti modifiche ai predefiniti tornano ai valori di fabbrica senza cambiare automaticamente la ripartizione attuale. Lo schema 50/30/20 non è più proposto; i suoi eventuali dati storici restano nei backup.

## Risparmi degli obiettivi

**Obiettivi → Gestisci risparmi** permette di aggiungere accantonamenti, correggere gli importi con la matita e rimuoverli con il cestino dopo conferma. L’importo iniziale è separato dagli accantonamenti successivi: modificarlo o azzerarlo conserva gli altri importi. La gestione resta disponibile anche sugli obiettivi raggiunti e aggiorna automaticamente totale, progresso e dashboard.

Le correzioni usano `server/goal-savings.mjs` e mantengono totale e storico nella stessa transazione, con isolamento per famiglia. Non creano o modificano movimenti del budget. Nessuna migrazione distruttiva: l’importo iniziale degli obiettivi esistenti si ricava dal totale meno gli accantonamenti registrati; gli stessi dati restano inclusi nei backup.

## Dashboard e consultazione degli appunti

**Dove vanno le nostre uscite** mostra per ogni categoria la spesa effettiva e il massimale del mese, calcolato sulle entrate e sulla ripartizione attuale. Categoria e importi restano affiancati nella legenda; il grafico a sinistra si adatta agli schermi piccoli. Nuova entrata e Nuova uscita rimangono sulla stessa riga, con colori jade e coral, rispettivamente + e −. I testi sono ingranditi di circa il 4%. Le card delle entrate, uscite, saldo e risparmi aprono rispettivamente Entrate, Uscite, Ripartizione budget e Obiettivi. Anche i riquadri di ripartizione, traguardi e movimenti aprono le relative sezioni; i pulsanti di creazione mantengono la loro azione.

**La vita di casa** offre, senza separatori, Lista della spesa, Menu settimanale, Conferimento rifiuti, Scadenze e Lavagna di famiglia. La lavagna appare solo come collegamento. I prossimi traguardi precedono gli ultimi movimenti.

Toccare una nota nella lavagna apre il testo completo e gli allegati in sola lettura; il titolo è anche un pulsante accessibile da tastiera. La matita apre la modifica. Evidenziare una nota o scaricare un allegato dalla scheda conserva la propria azione senza aprire la consultazione.

## Recupero password via email

In **Accedi → Password dimenticata?** inserisci l'email del tuo account. Il messaggio di conferma è identico anche per indirizzi non registrati. Il link è monouso, vale 30 minuti e si trova nel frammento URL, ripulito quando si apre la pagina. Scegli e conferma una nuova password di almeno 10 caratteri, poi accedi di nuovo. Il cambio disconnette tutti gli accessi precedenti di quell'account e conserva i dati della famiglia.

Un nuovo link sostituisce il precedente; l'invio allo stesso indirizzo è limitato a uno al minuto. Cambio email o password annullano i link pendenti. Il database conserva soltanto l'hash della chiave; le copie di backup non ripristinano link attivi. Nessun link viene mostrato nella risposta pubblica o nei log. Su Vercel l'invio continua con `waitUntil` dopo la risposta, senza far dipendere la conferma dalla presenza dell'account o dai tempi del servizio email.

Per l'invio gratuito **senza acquistare un dominio**, usa Brevo: crea un mittente con nome Family Hub e un tuo indirizzo email, poi verificalo con il codice ricevuto. Nelle variabili private **Production** di Vercel configura `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY` e `EMAIL_FROM=Family Hub <indirizzo-verificato>`. Non usare prefissi `VITE_` e non salvare le chiavi nel repository.

In alternativa, Resend richiede un dominio che puoi verificare tramite DNS: imposta `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` ed `EMAIL_FROM`. Il dominio `vercel.app` non fornisce il controllo DNS del mittente; `onboarding@resend.dev` consente solo invii di prova all'indirizzo dell'account Resend.

Senza credenziali di invio, il recupero restituisce un messaggio di indisponibilità. La scelta del provider non cambia la conservazione dei dati e delle password. In locale i test iniettano un mittente simulato e non inviano email reali.

## Account e famiglia

Il pulsante account nella barra superiore o il nome nella barra laterale apre **Il tuo account**. È possibile modificare nome, email, password e, per l'amministratore, nome della casa. Cambiare email richiede la password attuale; email e password aggiornate disconnettono gli altri accessi allo stesso account. Le impostazioni e gli inviti rimangono riservati alla propria famiglia.

La sezione **Famiglia e inviti** genera un link valido sette giorni, oltre al codice. Il link usa un frammento URL, che non viene inviato al server, apre la registrazione con il codice già compilato e viene ripulito dalla barra degli indirizzi. Generare un nuovo invito sostituisce il precedente. Il logout è il pulsante con freccia accanto al nome nella barra laterale.

Le nuove tabelle sono create in modo additivo, senza modificare o cancellare i dati esistenti. Ricorrenze, versioni, mesi saltati e template fanno parte dei backup dell'istanza, del ripristino cloud e dell'esportazione familiare. I backup precedenti alle nuove tabelle possono ancora essere ripristinati in un nuovo database.

## Conferimento rifiuti

La sezione **Conferimento rifiuti** contiene un calendario settimanale condiviso. Crea e modifica una voce per ogni tipologia, scegliendo uno o più giorni (da lunedì a domenica), un colore, un orario o fascia facoltativa e indicazioni utili. Organico, carta/cartone, plastica/metalli, vetro e indifferenziato sono scorciatoie per il nome: non inseriscono giorni ipotizzati. Sono ammesse anche tipologie personalizzate.

I riquadri **Oggi** e **Domani** usano la data locale del dispositivo; il calendario mostra tutti i giorni della settimana. Inserisci i giorni in cui esporre i rifiuti, che possono precedere il giorno di raccolta. Il calendario si ripete settimanalmente: aggiorna eventuali variazioni comunali o festive. Non invia notifiche esterne.

Le voci sono condivise e modificabili dai membri della stessa famiglia; altre famiglie non possono accedervi. La tabella `waste_schedules` viene creata in modo additivo, ed è inclusa nei backup e nel ripristino cloud, oltre che nell'esportazione ZIP familiare.

## Funzioni della prima versione

- **Panoramica:** entrate, uscite e saldo del mese, distribuzione delle spese, avvisi di sforamento e riepilogo degli obiettivi.
- **Entrate e Uscite:** sezioni separate per registrazioni occasionali e ricorrenti, con modifica, eliminazione, selezione del mese, ricerca, filtri per categoria ed esportazione CSV di tutti i mesi.
- **Budget:** quattro schemi fissi (Conservativa, Prudente, Equilibrata, Svago) e lo schema **Pers.**, l’unico modificabile, con totale obbligatorio del 100%. Gli importi sono calcolati sulle entrate effettivamente registrate. Vedi [Entrate, uscite e ripartizione budget](#entrate-uscite-e-ripartizione-budget).
- **Scadenze:** impegni singoli, mensili o annuali, con promemoria, modifica e archivio. Il pagamento è facoltativo: segnare una scadenza come gestita crea una sola uscita se previsto, anche con richieste contemporanee. Annullare la gestione rimuove l’uscita collegata. Gli addebiti automatici vanno nelle Uscite ricorrenti. Le vecchie bollette e i loro pagamenti sono conservati come scadenze.
- **Menu settimanale:** pranzo e cena per ogni giorno, porzioni, ingredienti e note di preparazione. Trasferimento degli ingredienti nella spesa senza duplicati dello stesso pasto; gli ingredienti già collegati e ancora da acquistare seguono le modifiche del menu.
- **Backup:** copie automatiche dell’app ogni 24 ore (ultime sette conservate), esportazione ZIP della propria famiglia e strumenti di verifica e ripristino in una nuova directory.
- **Obiettivi:** breve, medio e lungo termine, importo da raggiungere, scadenza facoltativa, risparmio iniziale, accantonamenti successivi correggibili ed eliminabili, modifica ed eliminazione.
- **Spesa:** prodotti, quantità, reparti, prodotti acquistati e pulizia della lista.
- **Lavagna:** appunti modificabili, colori, elementi in evidenza e fino a cinque allegati da 10 MB per appunto. I file si scaricano solo dopo l’accesso alla famiglia corretta.
- **Famiglia:** l’amministratore genera un link o un codice invito valido sette giorni. Un nuovo invito sostituisce il precedente. Gli altri membri creano un account scegliendo “Ho un invito” o aprendo il link. Ogni account modifica soltanto il proprio profilo.

Gli aggiornamenti condivisi vengono letti ogni 15 secondi, quando la scheda è visibile, e quando si ritorna alla finestra. Dopo una modifica locale la vista si aggiorna subito.

## Sviluppo

Richiede **Node.js 24** e npm. In sviluppo locale non servono database esterni né chiavi API. La pubblicazione gratuita su Vercel usa PostgreSQL persistente su Neon.

```sh
npm ci
npm run dev
```

Il comando avvia l’API sulla porta 3000 e Vite sulla porta 5173. Vite inoltra le richieste `/api` al server. Le porte possono essere esposte con gli strumenti della piattaforma utilizzata; l’onboarding cloud non offre anteprime web.

La pagina iniziale consente di creare il primo account e lo spazio familiare. Il database parte vuoto: nessun dato dimostrativo o credenziale predefinita.

Il server legge facoltativamente `.env`. Per configurarlo, copia `.env.example` in `.env` e personalizza i valori. Non sovrascrivere una configurazione esistente e non versionare credenziali o dati personali.

| Variabile | Predefinito | Uso |
| --- | --- | --- |
| `PORT` | `3000` | Porta dell’API; Vite usa la stessa configurazione per il proxy. |
| `DATA_DIR` | `.data` nella radice del progetto | Directory persistente del database e degli allegati. |
| `BACKUP_DIR` | percorso `DATA_DIR` seguito da `-backups` | Destinazione persistente dei backup automatici. |
| `AUTO_BACKUPS` | attivo | Impostare `0` per disattivare la pianificazione automatica. |
| `TRUST_PROXY` | disattivato | Impostare `1` solo dietro un reverse proxy HTTPS fidato a un singolo hop. |

## Build e avvio

```sh
npm run build
npm start
```

In questo caso il server distribuisce anche l’interfaccia compilata, dalla stessa porta dell’API. Il build include il controllo TypeScript.

Per un utilizzo su Internet, configura HTTPS e un volume persistente per `DATA_DIR`. I processi devono essere riavviati dopo il ripristino di un ambiente cloud. Il database e gli allegati rimangono sul filesystem; conservare solo `dist` non conserva i dati.

### Distribuzione con Docker

Il `Dockerfile` compila l’interfaccia e avvia un solo processo Node.js 24 come utente non privilegiato, con verifica di disponibilità su `/api/health`. Il contesto di build ammette soltanto il codice necessario: database, allegati, backup e `.env` non entrano nell’immagine.

```sh
docker build -t gestione-casa .
docker volume create gestione-casa-data
docker run -d --name gestione-casa --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v gestione-casa-data:/var/lib/casa \
  -e TRUST_PROXY=1 gestione-casa
```

Questo avvio è destinato a un server con un reverse proxy HTTPS fidato che inoltra al servizio locale e imposta `X-Forwarded-Proto`. Non espone un sito pubblico da solo. Senza quel proxy, ometti `TRUST_PROXY=1`. Il volume conserva dati e backup quando il container viene sostituito; non eliminarlo durante gli aggiornamenti. Serve comunque una copia dei backup fuori dal server.

### Pubblicazione gratuita: Vercel + Neon

La configurazione è in `vercel.json`. L’interfaccia compilata è servita da Vercel; `/api` usa funzioni Node.js 24 e un database PostgreSQL su Neon. Account, sessioni, dati familiari, allegati e backup automatici restano nel database, nello schema privato `casa`. Il filesystem temporaneo serve soltanto per preparare esportazioni, mai per conservare i dati cloud. Una connessione assente o non funzionante produce un errore di disponibilità: non si ripiega su un SQLite temporaneo.

1. In [Vercel → New Project](https://vercel.com/new), importa `giuseppecatalano989/Gestione-Casa`, ramo `main`. Usa il piano **Hobby**, preset **Vite** e **Node.js 24**. Il repository fornisce build, output e percorsi API. Prima di collegare il database, l’interfaccia può caricarsi ma le API restituiscono 503.
2. Installa [Neon dal Marketplace Vercel](https://vercel.com/marketplace/neon), scegli il piano **Free** e una regione europea. Collega il database al progetto per **Production**: l’integrazione inserisce `DATABASE_URL` con la connessione pooled. Non applicare prefissi alla variabile. Se usi Neon separatamente, inserisci il suo URL PostgreSQL pooled in `DATABASE_URL` nelle impostazioni riservate di Vercel.
3. Nelle variabili di Vercel per Production aggiungi `CRON_SECRET`, una stringa casuale lunga, per proteggere il backup pianificato. Generala sul tuo dispositivo e inseriscila direttamente nel pannello riservato; non inviarla in chat e non committarla. Non usare nomi con prefisso `VITE_` per credenziali del backend.
4. Esegui **Redeploy**. Vercel assegna l’indirizzo HTTPS. Verifica `/api/health` (`status: ok`) e crea il tuo account dalla pagina iniziale; genera l’invito dalla sezione Famiglia per gli altri membri. Una modifica al ramo collegato avvia una nuova pubblicazione.

Le tabelle vengono create automaticamente in modo additivo. Il codice non modifica altri schemi PostgreSQL e verifica i certificati TLS. Il limite ai tentativi di accesso è condiviso nel database anche tra istanze serverless. Gli allegati restano protetti dall’accesso alla famiglia corretta; non hanno URL pubblici dello storage. L’interfaccia li carica in parti da 2 MB per rispettare i limiti delle richieste Vercel, mantenendo il massimo di **10 MB per file** e cinque allegati per appunto. La configurazione cloud ammette **40 MB complessivi di allegati nell’istanza**, per lasciare spazio alle sette copie automatiche; oltre il limite il caricamento viene rifiutato con un messaggio.

Il cron protetto esegue un backup al giorno. Su Vercel Hobby l’orario è indicativo, nella finestra del cron giornaliero; la prossima esecuzione mostrata nell’app è una previsione. `CRON_SECRET` deve essere presente: senza di esso l’app segnala la pianificazione disattivata e l’endpoint rifiuta le richieste. Le ultime sette copie comprendono account, database e byte degli allegati. Sono archivi riservati nel database e non vengono distribuiti dalle API. Le copie nello stesso database proteggono da errori sui dati; scaricane una in una destinazione separata per proteggerti anche dalla perdita del servizio.

Per uso personale questi piani possono restare gratuiti entro le loro quote. La [documentazione Neon Free](https://neon.com/docs/introduction/plans) consultata indica 1 GB per progetto e 100 CU-hours mensili per progetto; verifica le condizioni mostrate alla creazione. Download, backup e allegati consumano spazio e trasferimento. Il database può sospendersi quando è inattivo e la prima richiesta può richiedere più tempo. Non abilitare piani a pagamento o aggiornamenti automatici per questo progetto. Una preview non deve ricevere la connessione al database della famiglia: usa un database separato per i test.

Per verificare il backend cloud in sviluppo serve un **PostgreSQL temporaneo locale**:

```sh
CASA_TEST_DATABASE_URL=postgresql://utente:password@127.0.0.1:5432/database_temporaneo npm run test:cloud
```

Questi otto test verificano isolamento e condivisione tra istanze, pagamenti concorrenti, persistenza, conferma degli upload soltanto dopo il commit, allegati da 10 MB e ZIP familiare, sette snapshot verificati, ripristino SQLite e PostgreSQL e limiti di accesso persistenti. Il comando cancella lo schema `casa` del database temporaneo e crea/rimuove un database `casa_restore_test`: non usare un database reale. Richiede un ruolo locale autorizzato a creare il database di test. Gli URL remoti vengono rifiutati.

Per scaricare una copia riservata dell’istanza, configura `DATABASE_URL` sul dispositivo del gestore in un `.env` riservato:

```sh
npm run cloud:backup -- list
npm run cloud:backup -- download ID_DELLA_COPIA /percorso/nuovo-backup.zip
```

Il download rifiuta un file già esistente. Estrai l’archivio in una nuova directory e verifica con `npm run backup:verify -- /directory-estratta`. Per ripristinare in locale usa il comando SQLite descritto sotto. Per ripristinare in Neon crea un **nuovo database senza schema `casa`**, configura il suo URL come `RESTORE_DATABASE_URL` nell’ambiente riservato del gestore ed esegui:

```sh
npm run cloud:backup -- restore /directory-estratta
```

Il ripristino verifica integrità e allegati, rifiuta un database che contiene già lo schema dell’app e inserisce dati e file in una transazione. Dopo la verifica collega il nuovo `DATABASE_URL` a Vercel e ridistribuisci; conserva il vecchio database fino al controllo del funzionamento.

## Verifiche

```sh
npm test
npm run test:e2e
```

I test Node verificano account e sessioni, inviti, condivisione e isolamento tra famiglie, CSRF, movimenti e mesi, budget, obiettivi, allegati, esportazione e persistenza dopo il riavvio, pagamenti senza duplicati, menu collegato alla spesa, limiti di mese e settimana, integrità dei backup, ripristino completo e conservazione delle ultime sette copie e segnalazione degli errori senza perdita dei dati. Verificano anche ricorrenze senza duplicati, modifiche datate, mesi saltati ed eliminazione delle ricorrenze, schemi fissi e impostazioni account. I test browser percorrono le sezioni di base con due account e i flussi di scadenze con e senza pagamento, menu, spesa, backup ZIP, redditi, ricorrenze, template e conferimento rifiuti, su desktop e su un viewport mobile. Verificano anche i download, il contenuto dell’archivio, l’assenza di errori JavaScript e di scorrimento orizzontale, oltre alla barra fissa durante lo scorrimento.

I test usano database temporanei separati, rimossi alla fine: non modificano `.data`. I risultati del browser rimangono in `test-results`, ignorato da Git.

Nell’ambiente cloud è già disponibile `/usr/bin/chromium` e la configurazione lo usa automaticamente. Su un’altra macchina, puoi indicare un browser installato con `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` oppure installare quello di Playwright:

```sh
npm run test:browser:install
```

Il download Playwright richiede accesso a `cdn.playwright.dev` e alle destinazioni di reindirizzamento del servizio. Questa installazione non serve quando Chromium è già disponibile.

## Dati e calcoli

Gli importi sono interi in centesimi. Le percentuali sono interi in centesimi di punto percentuale; gli eventuali centesimi di arrotondamento del budget vengono assegnati in modo deterministico per mantenere la somma uguale alle entrate. Il saldo è relativo ai movimenti del mese selezionato, non al saldo reale del conto bancario.

Lo schema percentuale è unico per famiglia e si applica anche consultando i mesi precedenti. Non conserva versioni storiche del budget. L’accantonamento di un obiettivo ne aggiorna il progresso; non crea automaticamente un’uscita. Se vuoi conteggiarlo nel budget, registra un movimento nella categoria destinata al risparmio.

Le password vengono derivate con scrypt e un salt casuale. Le sessioni durano 14 giorni e usano cookie HttpOnly, SameSite e Secure su HTTPS. Le API verificano l’appartenenza alla famiglia; gli allegati sono serviti come download, non come pagine eseguibili. I codici invito vengono conservati come hash. Il CSV neutralizza i prefissi interpretati dai fogli di calcolo come formule.

### Scadenze e menu

Le scadenze possono essere singole, mensili o annuali. Il giorno 29, 30 o 31 si adatta all’ultimo giorno dei mesi più corti; un anniversario del 29 febbraio cade il 28 negli anni non bisestili. Il promemoria compare nella panoramica e nello scadenziario: non invia email o notifiche esterne.

Il pagamento è facoltativo e l’importo previsto non modifica le uscite. “Segna gestita” registra la gestione; se è previsto un pagamento, crea un’uscita alla data e all’importo scelti. “Annulla gestione” elimina la gestione e l’eventuale uscita. Eliminare direttamente un movimento collegato rende nuovamente da gestire la scadenza. Modifica e archivio conservano gestioni e pagamenti precedenti. La conversione delle vecchie bollette avviene una sola volta per famiglia e conserva i movimenti esistenti. Le bollette con addebito automatico vanno configurate come Uscite ricorrenti per evitare doppie registrazioni.

Il menu mostra settimane dal lunedì alla domenica e consente un pranzo e una cena al giorno. Le quantità sono testo libero e si riferiscono alle porzioni dichiarate; cambiare il numero di porzioni non ricalcola automaticamente le quantità. Due pasti distinti possono aggiungere lo stesso prodotto: non vengono sommate quantità con unità diverse. Ripetere l’aggiunta **dello stesso pasto** non duplica i suoi ingredienti finché gli elementi sono ancora in lista. Gli elementi acquistati non vengono modificati da un successivo cambio del menu. Eliminare un pasto conserva ciò che è già stato aggiunto alla lista.

### Backup automatici e ripristino

Il server crea una prima copia al primo avvio, se non ne esiste una recente, e poi una ogni 24 ore mentre è in funzione. Dopo un riavvio legge la cronologia e recupera una copia scaduta. Conserva le ultime **sette copie riuscite**. Gli errori di backup compaiono nella sezione Backup e nei log del server. La pianificazione non funziona mentre il processo è arrestato.

Ogni directory contiene `casa.sqlite`, `uploads` e `manifest.json`. Il database viene fotografato con SQLite `VACUUM INTO`; gli allegati referenziati vengono copiati nella stessa operazione del processo. Le copie sono verificate con SHA-256, controllo d’integrità SQLite e controllo delle chiavi esterne prima di essere dichiarate riuscite. Il servizio è pensato per **un processo applicativo** che gestisce database e upload: la coerenza con altri processi che modificano direttamente gli stessi file non è garantita.

I backup automatici sono copie dell’**intera istanza**, inclusi tutti gli account e le famiglie. Restano riservati al gestore del filesystem; nessuna API ne distribuisce il database. Anche il server Vite blocca l’accesso alle directory di dati e backup. Il creatore di ciascuna famiglia può invece scaricare un ZIP con `casa.json` e gli allegati **della sola famiglia**: sono esclusi password, email degli account, sessioni e codici invito. Questo ZIP è un’esportazione dei dati; non si importa automaticamente dall’interfaccia.

Per verificare e ripristinare una copia automatica:

```sh
npm run backup:verify -- /percorso/backup-selezionato
npm run backup:restore -- /percorso/backup-selezionato /percorso/nuova-directory-dati
```

Il ripristino verifica prima il backup, crea una **nuova directory** e rifiuta una destinazione già esistente. Non sovrascrive i dati correnti. Arresta il server, configura `DATA_DIR` con la nuova directory e riavvia. Password e dati provengono dalla copia ripristinata. Conserva la vecchia directory fino alla verifica del funzionamento. L’operazione viene testata con un database temporaneo e byte degli allegati confrontati con gli originali.

La directory predefinita `.data-backups` è ignorata da Git. Se scegli un altro percorso, mantienilo fuori dal checkout o aggiungilo alla tua configurazione locale di esclusione. I backup sullo stesso server proteggono da errori sui dati, non dalla perdita del disco: usa un volume persistente e conserva una copia anche in una destinazione separata. Non committare database o archivi.

## Struttura

```text
src/                     Interfaccia React e calcoli del budget
server/app.mjs           API Express, autenticazione, autorizzazione e SQLite
server/index.mjs         Avvio locale, pianificazione backup e arresto
server/schema.mjs        Schema delle tabelle, creato in modo additivo
server/planning.mjs      Entrate e uscite ricorrenti, schemi di budget
server/deadlines.mjs     Scadenze e gestioni con eventuale uscita
server/goal-savings.mjs  Accantonamenti degli obiettivi
server/workflows.mjs     Menu, collegamenti alla spesa e compatibilità bollette
server/waste.mjs         Calendario del conferimento rifiuti
server/uploads.mjs       Allegati della lavagna caricati a parti
server/recovery.mjs      Recupero password con link monouso
server/reset-email.mjs   Invio email tramite Brevo o Resend
server/backups.mjs       Snapshot, ZIP familiare, verifica e ripristino
server/postgres.mjs      Persistenza PostgreSQL per Neon
server/cloud.mjs         Backend condiviso per il deployment serverless
server/cloud-backups.mjs Backup cloud e copie portabili
server/*-cli.mjs         Comandi privati del gestore (backup, rimozione membri, diagnostica email), senza rotte HTTP
api/index.mjs            Funzione Vercel; nessun fallback a dati temporanei
vercel.json              Deployment e cron giornaliero
tests/                   Test API, calcoli, backend cloud e flussi browser
public/                  Logo, icone e manifest dell’app
.data/                   Dati locali e allegati, ignorati da Git
.data-backups/           Backup automatici, ignorati da Git
```

## Prossimi sviluppi utili

1. Ricorrenze annuali o trimestrali e notifiche esterne.
2. Confronto tra mesi, budget storici e categorie aggiuntive.
3. Copie automatiche verso uno spazio esterno al server e importazione del ZIP familiare.
4. Verifica email e gestione dei membri dall’interfaccia.

La prima versione non include collegamenti alle banche, pagamenti o notifiche push. Il recupero password richiede la configurazione del servizio email descritta sopra. Il deployment gratuito richiede il collegamento dei propri account Vercel e Neon; la pubblicazione dell’ambiente Codex non pubblica la webapp. Il comando di build Vercel è `npm run build`, impostato nel progetto (o ricavato dal framework Vite).

La rimozione di un membro richiesta al gestore usa esclusivamente il comando privato `server/member-removal-cli.mjs`, con `DATABASE_URL` backend e argomenti `--request-id`, `--member` e `--admin`. Richiede una corrispondenza univoca dei nomi nella stessa famiglia, conserva una copia privata prima della rimozione, revoca gli accessi e trasferisce i record condivisi all’amministratore. Non rimuove amministratori né dati familiari. Riutilizzare lo stesso identificativo di richiesta non elimina un account ricreato. Il comando non è esposto via HTTP e non fa parte della build ordinaria; può essere eseguito con un comando di build specifico di un singolo deployment.

La richiesta di integrazione bancaria futura, esclusivamente di lettura dei movimenti e senza saldi né pagamenti, è annotata in [docs/banking-integration.md](docs/banking-integration.md).
