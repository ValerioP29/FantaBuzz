# GO-LIVE Checklist

## Configurazione
- [ ] `NODE_ENV=production`
- [ ] `HOST_PIN` impostato (obbligatorio)
- [ ] `EXPORT_TOKEN` impostato (obbligatorio)
- [ ] `CORS_ORIGINS` configurato con i domini reali
- [ ] `HOST_TOKEN_TTL_HOURS` verificato
- [ ] `PERSIST_INTERVAL_MS` e `MAX_BACKUPS` verificati

## Verifiche funzionali
- [ ] `/health` restituisce `ok: true`
- [ ] Login host con PIN funzionante
- [ ] Token host scade e richiede rinnovo
- [ ] Export accessibile solo con `X-Export-Token`
- [ ] Import listone da XLSX/CSV funzionante
- [ ] Export CSV non contiene formule (mitigazione injection)

## Verifiche sicurezza
- [ ] CORS blocca origin non autorizzati
- [ ] Nessun export pubblico senza token
- [ ] Token host non persistente oltre TTL

## Verifiche performance
- [ ] Carico minimo: 10 client simultanei
- [ ] Broadcast regolare senza lag visibile
- [ ] Persistenza su disco non blocca UI

## Backup & ripristino
- [ ] Backup automatici presenti in `server/data`
- [ ] Procedura restore provata su snapshot

## Post‑deploy
- [ ] Monitoraggio log pino attivo
- [ ] Endpoint `/health` monitorato
