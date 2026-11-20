# Termosifoni

Pannello locale per i termosifoni gestiti da un **eQ-3 MAX! Cube**: temperature,
programmi settimanali, modalità e impostazioni, senza cloud.

## Installazione

```bash
./install.sh 192.168.1.100
```

L'IP è facoltativo: senza, il Cube viene cercato in rete, anche se cambia indirizzo. Dal pannello
(pulsante di stato in alto a destra) puoi vedere il Cube in uso, cercarlo in rete o inserirne l'IP.
L'installer:

- copia l'app in `~/Library/Application Support/Termosifoni`;
- crea `~/Applications/Termosifoni.app`, che apre il pannello in una finestra dedicata
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
