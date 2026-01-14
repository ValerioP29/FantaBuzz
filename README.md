# FantAstaBuzz

Asta fantacalcio realtime con banditore unico, rullo giocatori, offerte sincronizzate, import da Excel/CSV e persistenza su file.

## Requisiti
- Node.js 20+
- npm

## Setup sviluppo
```bash
npm install
npm run dev
```
Apri http://localhost:8080.

### Workflow sviluppo
- Importa listone da XLSX/CSV dal pannello host.
- Le sessioni vengono salvate in `server/data` (ignorato da git).

## Setup produzione
1. Configura le variabili d’ambiente (vedi tabella sotto).
2. Avvia il server con `npm start` dietro reverse proxy (nginx) e HTTPS.
3. Proteggi l’accesso agli endpoint di export con `X-Export-Token`.

### Variabili d’ambiente
| Variabile | Default | Descrizione |
| --- | --- | --- |
| `NODE_ENV` | `development` | Impostare `production` in prod. |
| `PORT` | `8080` | Porta HTTP. |
| `CORS_ORIGINS` | `http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://127.0.0.1:5173` | Lista di origin consentiti (comma-separated). |
| `HOST_PIN` | *(vuoto)* | **Obbligatorio in produzione.** PIN banditore. |
| `EXPORT_TOKEN` | *(vuoto)* | **Obbligatorio in produzione.** Token per proteggere gli export. |
| `HOST_TOKEN_TTL_HOURS` | `12` | Durata massima del token host. |
| `PERSIST_INTERVAL_MS` | `1000` | Frequenza massima di salvataggio snapshot. |
| `MAX_BACKUPS` | `50` | Numero massimo di backup timestampati. |
| `BROADCAST_INTERVAL_MS` | `80` | Intervallo minimo di broadcast a client. |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | Livello logging (pino). |

### Export protetti
Gli endpoint di export richiedono l’header:
```
X-Export-Token: <EXPORT_TOKEN>
```
Nel client web, al primo download viene richiesto l’export token e salvato in sessione.

## Runbook
### Backup & restore
- Snapshot corrente: `server/data/DEFAULT.json`
- Backup timestampati: `server/data/DEFAULT.YYYYMMDD-HHMM.json`
- Restore: sostituire `DEFAULT.json` con un backup (server spento).

### Troubleshooting
- Verifica healthcheck: `GET /health`
- Errori di import: controllare formato CSV/XLSX e intestazioni attese.

## Funzionalità principali
- Banditore unico con play/pausa rullo
- Filtri per ruolo (P, D, C, A)
- Start asta alla prima offerta
- Countdown 3-2-1 → SOLD
- No auto-rialzo
- Auto-assegnazione giocatore a SOLD
- Storico con undo host
- Import diretto da XLSX/CSV
- Export risultati in CSV/JSON (protetto da token)
- Resume dopo refresh con token salvato

## Struttura progetto
- `client/public/` → frontend
- `server/src/` → backend
- `server/data/` → salvataggi (ignorato da git)
