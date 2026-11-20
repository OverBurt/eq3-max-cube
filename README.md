# Termosifoni

Un'app per Mac per gestire il riscaldamento con il sistema **eQ-3 MAX!**: le valvole
termostatiche sui termosifoni, i termostati a parete e il **MAX! Cube**, il gateway LAN
che li collega alla rete di casa.

## A cosa serve

Il sistema MAX! si gestiva con il software ufficiale di eQ-3 e con il portale online
per il controllo da fuori casa. Il prodotto è fuori produzione:

- il software ufficiale non è più scaricabile dal sito eQ-3, e la versione per Mac
  richiedeva Java e versioni di macOS ormai superate;
- il portale online è stato chiuso.

Chi ha ancora un impianto MAX! funzionante si ritrova senza un modo comodo di vedere
le temperature o cambiare i programmi. Termosifoni **sostituisce il software ufficiale
dismesso** e permette di:

- vedere a colpo d'occhio la temperatura di ogni stanza, la temperatura obiettivo e il
  prossimo cambio di programma;
- cambiare la temperatura e la modalità: programma, manuale, boost, vacanza;
- modificare il programma settimanale di ogni stanza;
- regolare le impostazioni: temperature comfort/eco, minima e massima, finestra aperta,
  boost, anticalcare;
- ricevere avvisi su batterie scariche e dispositivi che non rispondono.

## Come funziona

Termosifoni lavora **solo in rete locale**, parlando direttamente con il Cube: niente
cloud, niente account, nessun dato che esce di casa.

```
 Mac (Termosifoni)  ──rete di casa──▶  MAX! Cube  ──radio 868 MHz──▶  valvole e termostati
```

- Il Mac deve essere sulla **stessa rete** del Cube (Wi-Fi o cavo, stesso router).
- Il Cube viene **trovato da solo** in rete, anche se cambia indirizzo; in alternativa
  si inserisce il suo IP.
- Funziona con l'impianto già configurato: stanze e dispositivi sono quelli salvati nel
  Cube. L'abbinamento di nuovi dispositivi non è supportato.
- Non serve Internet. Da fuori casa non è raggiungibile, a meno di usare una VPN verso
  la rete di casa.

Requisiti: un Mac con Python 3.9 o successivo in `/usr/bin/python3` (lo installano gli
strumenti da riga di comando di Xcode: se manca, macOS propone di installarli al primo uso)
e un browser; con Chrome, Edge o Brave il pannello si apre in una finestra a sé.

## Installazione

```bash
./install.sh 192.168.1.100
```

L'IP è facoltativo: senza, il Cube viene cercato in rete, anche se cambia indirizzo. Dal pannello
(pulsante di stato in alto a destra) puoi vedere il Cube in uso, cercarlo in rete o inserirne l'IP.
L'installer:

- copia l'app in `~/Library/Application Support/Termosifoni`;
- crea `Termosifoni.app` in `/Applications` (o in `~/Applications` se quella di sistema non è scrivibile), che compare nel Finder, nel Launchpad e in Spotlight e apre il pannello in una finestra dedicata
  (Chrome/Edge/Brave in modalità app, altrimenti il browser predefinito).

Non resta niente acceso in background: aprendo Termosifoni.app parte il server (solo su
`127.0.0.1:8765`), che si spegne da solo 3 minuti dopo la chiusura del pannello. Se aggiorni da
una versione precedente, l'installer rimuove il vecchio servizio sempre attivo.

Serve comunque un piccolo server locale: il Cube parla solo TCP/UDP grezzo, che un browser
non può usare. Il server fa da traduttore tra il Cube e la pagina.

Al primo avvio macOS potrebbe chiedere il permesso di accedere alla **rete locale**:
va concesso, altrimenti il server non raggiunge il Cube.

Disinstallazione: `~/Library/Application Support/Termosifoni/uninstall.sh` (aggiungi `--tutto` per cancellare anche i dati locali).

## Cosa fa

- **Casa**: temperatura di ogni stanza, obiettivo, prossimo cambio di programma, avvisi (batteria scarica, dispositivo non raggiungibile, comando non confermato). Azioni per tutta la casa: programma, eco, vacanza.
- **Stanza**: temperatura con "fino al prossimo cambio" o "sempre"; modalità programma, manuale, boost e vacanza; editor del programma settimanale (fino a 13 fasce, copia tra giorni); impostazioni: comfort/eco, minima/massima, finestra aperta, boost, anticalcare.

Il Cube non conserva uno storico, dà solo i valori del momento. Le valvole senza termostato a parete comunicano la temperatura solo ogni tanto: il pannello ricorda l'ultima misura ricevuta mentre era aperto (in `data/stato.json`) e mostra quanto è vecchia.

## Note tecniche

- Ricerca del Cube: broadcast UDP ufficiale eQ-3 (porta 23272) su ogni rete del Mac, più una scansione della porta TCP 62910 su tutti gli indirizzi delle reti locali (fino a /22), per i router che bloccano i broadcast.
- Spegnimento automatico: con `--idle-exit SECONDI` il server si ferma quando nessuna pagina lo contatta per quel tempo; la pagina aperta invia un segnale ogni 30 secondi, anche se ridotta a icona.
- Solo libreria standard Python 3.9+ (`/usr/bin/python3` di macOS va bene).
- Il server interroga il Cube ogni 2 minuti; il Cube accetta un solo client alla volta, quindi chiudi altri software MAX! mentre è attivo.
- Le trasmissioni radio sono limitate all'1% del tempo (duty cycle): se il Cube rifiuta i comandi, riprova dopo circa un'ora.
- Protocollo ricavato da python-maxcube-api e dal modulo MAX di FHEM.

Avvio manuale per sviluppo: `python3 server.py 192.168.1.100` e poi http://127.0.0.1:8765 (senza `--idle-exit` resta acceso finché non lo fermi).

## Licenza

MIT. Progetto non ufficiale, non affiliato a eQ-3: i comandi inviati al Cube sono ricavati da progetti open source e usati a proprio rischio.
