# Integrazione bancaria futura

Richiesta conservata il 4 ottobre 2026. L'integrazione non è attualmente attiva.

- Banca dell'utente: Intesa Sanpaolo, Italia.
- Possibile fornitore: Enable Banking; verificare copertura e condizioni aggiornate prima di implementare.
- Importare automaticamente solo le operazioni per classificare le spese. Saldi esclusi: richiedono una futura richiesta esplicita.
- Richiedere esclusivamente un consenso AIS di lettura, con `transactions: true` e `balances: false`. Nessun flusso PIS, nessuna funzione o chiamata API per pagamenti, bonifici o altre disposizioni.
- Il consenso avviene sul sito/app della banca: Family Hub non deve chiedere né conservare credenziali bancarie. Verificare nella schermata della banca i permessi realmente concessi.
- Consentire disconnessione/revoca; gestire scadenza e rinnovo del consenso. Deduplicare gli import e far scegliere come condividere i dati nella famiglia.
- Prima dell'attivazione: valutare autenticazione forte, cifratura delle connessioni/segreti sul backend, protezione del redirect e minimizzazione dei dati conservati, inclusi i backup.

Un consenso esclusivamente AIS non autorizza disposizioni sul conto. Non si può garantire un rischio nullo: rimangono rischi di accesso ai dati e vulnerabilità dell'app o del fornitore. L'accesso ai saldi, se richiesto in futuro, resta lettura e non deve introdurre autorizzazioni di pagamento.

Riferimenti ufficiali: [API Enable Banking](https://enablebanking.com/docs/api/reference/), [conti collegati](https://enablebanking.com/docs/api/linked-accounts/), [revoca del consenso](https://enablebanking.com/data-sharing-consents/).
