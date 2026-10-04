# Istruzioni di sviluppo

- Questo task cloud ha già un checkout isolato. Lavora nel checkout esistente; non creare worktree salvo richiesta esplicita dell’utente.
- Usa Node.js 24, npm e il lockfile. Per preparare l’ambiente usa `npm ci`; non aggiornare dipendenze o lockfile durante il solo onboarding.
- L’interfaccia e i messaggi rivolti alle persone sono in italiano. Gli importi sono in euro.
- Conserva gli importi come interi in centesimi e le percentuali come interi in centesimi di punto percentuale. Non usare numeri in virgola mobile per i saldi persistenti.
- Ogni risorsa condivisa appartiene a una famiglia: verifica sempre la proprietà lato server. Non affidarti ai controlli del client.
- Usa query parametrizzate. Non mostrare password, cookie, codici invito o variabili segrete nei log.
- Database e allegati sono in `.data`, o nel percorso configurato da `DATA_DIR`. Preserva i dati esistenti; i test devono usare directory temporanee separate.
- Il server legge `.env` facoltativamente. Non sovrascriverlo e non inserirlo in Git.
- Verifica modifiche funzionali con `npm test` e `npm run build`; per flussi dell’interfaccia usa `npm run test:e2e`, che testa desktop e mobile con un database temporaneo.
- Il cloud include `/usr/bin/chromium`. Non scaricare browser aggiuntivi se quello installato funziona.
- Avvia lo sviluppo con `npm run dev`. Per la build locale di produzione: `npm run build` e `npm start`. API e interfaccia devono raggiungere la stessa famiglia tramite sessione, non tramite dati fittizi nel browser.
- Durante l’onboarding non modificare codice, test, manifest o lockfile; salva installazione e startup nei campi di configurazione dell’ambiente. Le modifiche di codice richiedono una richiesta di sviluppo come quella che ha creato questo progetto.

- Le tabelle delle nuove funzioni vengono create in modo additivo da `server/workflows.mjs`; non resettare il database per aggiornare lo schema.
- Registrare una bolletta pagata e creare l’uscita devono avvenire nella stessa transazione SQLite. Mantieni l’unicità per bolletta e mese e il collegamento che si cancella se il movimento viene eliminato.
- Il menu usa ingredienti con identità stabile; trasferire lo stesso pasto nella spesa non deve duplicare quelli già collegati. Modifica solo prodotti ancora da acquistare.
- I backup dell’istanza contengono tutte le famiglie e credenziali derivate: non esporli via HTTP. Il ZIP familiare deve restare filtrato per famiglia e privo di password, sessioni e codici invito.
- Preserva `.data-backups` e ogni `BACKUP_DIR` configurato. Il ripristino deve verificare integrità e allegati e usare una destinazione nuova.
- Mantieni il blocco di accesso alle directory dei dati nel server Vite, anche con percorsi personalizzati.

- Il deployment Vercel usa `server/cloud.mjs` con PostgreSQL su Neon. Non ripiegare mai su SQLite temporaneo quando manca `DATABASE_URL`. Le credenziali del database restano sul backend, senza prefisso `VITE_`.
- Le scritture e le copie PostgreSQL usano un advisory lock condiviso tra istanze. Mantieni atomicità dei pagamenti, limiti degli allegati e isolamento familiare anche sul backend cloud.
- Gli upload dell’interfaccia usano parti da 2 MB; conserva il limite di 10 MB per file. Il limite complessivo cloud è 40 MB per lasciare spazio ai sette backup.
- I backup cloud sono riservati nel database; il cron Vercel giornaliero richiede `CRON_SECRET`. Non esporre gli archivi dell’istanza via HTTP. Il ripristino richiede un nuovo database senza schema `casa`.
- `npm run test:cloud` richiede `CASA_TEST_DATABASE_URL` su PostgreSQL temporaneo locale con permesso di creare database: cancella lo schema `casa` e crea/rimuove `casa_restore_test`. Non usare dati reali. TLS verificato per Neon; la modalità senza TLS è ammessa soltanto nei test su loopback.

- Le Scadenze usano `server/deadlines.mjs`: gestione e uscita facoltativa sono atomiche e uniche per scadenza e mese. Le gestioni senza pagamento non creano transazioni. Annullare la gestione rimuove l'eventuale uscita, eliminare l'uscita rimuove la gestione collegata.
- La migrazione dalle bollette è additiva e avviene una sola volta per famiglia; conserva giorno mensile e movimenti esistenti. Includi scadenze, gestioni e marcatori della migrazione nei backup completi e filtra le esportazioni per famiglia.
