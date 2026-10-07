# Integrazione bancaria

Attiva dal 7 ottobre 2026 su richiesta esplicita, che estende la nota del 4 ottobre ai **saldi** e include nel budget anche i movimenti dei conti con movimenti privati. Gli stipendi previsti come entrate ricorrenti vengono sostituiti dall’accredito reale solo quando questo è riconoscibile come stipendio (ordinante già noto, causale o codice SEPA `SALA`, ordinante ricorrente). I versamenti verso conti risparmio e investimento sono archiviati in Risparmio e, se scelto, accantonati in un obiettivo. Il funzionamento per le persone è descritto nel README, sezione “Conti bancari (sola lettura)”.

## Fornitore

Enable Banking (`server/bank.mjs`). È stato preferito a GoCardless Bank Account Data (ex Nordigen), che secondo più fonti del 2025-2026 non accetta nuove iscrizioni gratuite, e ad aggregatori come Salt Edge, Tink o Yapily, che in produzione richiedono contratti commerciali. La modalità *restricted production* di Enable Banking è gratuita per uso personale ma legge soltanto i conti collegati dal pannello del titolare dell’applicazione: verificare condizioni e copertura aggiornate prima di estendere l’uso.

## Vincoli

- Solo consenso AIS di lettura (`/auth`, `/sessions`, `/accounts/{uid}/balances`, `/accounts/{uid}/transactions`). Nessun flusso PIS: il codice non contiene chiamate a pagamenti, bonifici o altre disposizioni.
- Il consenso avviene sul sito o nell’app della banca: Family Hub non chiede né conserva credenziali bancarie. Lo stato del redirect è monouso, scade dopo 30 minuti, è conservato solo come hash e deve appartenere all’utente con la sessione attiva.
- Chiave privata e identificativo dell’applicazione restano nelle variabili private del backend. Le sessioni Enable Banking sono cifrate nel database; gli IBAN non sono conservati in chiaro (solo ultime quattro cifre e un’impronta per riconoscere giroconti e rinnovi).
- Con l’app aperta, ogni titolare aggiorna i propri conti ogni 5 minuti inviando gli header PSU (titolare presente). L’accesso non presidiato ai conti di altri membri, dal cron o dalle app aperte, avviene al massimo ogni 6 ore per collegamento, entro le quattro letture giornaliere previste dalla PSD2.
- Disconnessione e revoca disponibili al titolare; consenso fino a 180 giorni, rinnovabile mantenendo lo stesso conto.
- Visibilità scelta per conto: “Saldo e movimenti” o “Movimenti privati”. Entrambe contano nel budget; per i movimenti privati gli altri membri ricevono soltanto totali per mese, tipo e categoria (anche in CSV), e lo ZIP familiare ne omette i dettagli.
- I movimenti in attesa (non contabilizzati) e i conti non in euro non entrano nei totali.

Un consenso esclusivamente AIS non autorizza disposizioni sul conto. Non si può garantire un rischio nullo: rimangono rischi di accesso ai dati e vulnerabilità dell’app o del fornitore.

Riferimenti ufficiali: [API Enable Banking](https://enablebanking.com/docs/api/reference/), [conti collegati](https://enablebanking.com/docs/api/linked-accounts/), [revoca del consenso](https://enablebanking.com/data-sharing-consents/).
