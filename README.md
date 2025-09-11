FantAstaBuzz
Asta fantacalcio realtime con banditore unico, rullo giocatori, offerte sincronizzate, import da Excel/CSV e persistenza su file.
Requisiti
•	Node.js 20+
•	NPM
Installazione
npm install
npm start
Apri http://localhost:8080.
Funzionalità principali
•	Banditore unico con play/pausa rullo
•	Filtri per ruolo (P, D, C, A)
•	Start asta alla prima offerta
•	Countdown 3-2-1 → SOLD
•	No auto-rialzo
•	Auto-assegnazione giocatore a SOLD
•	Storico con undo host
•	Import diretto da XLSX/CSV
•	Export risultati in CSV/JSON
•	Resume dopo refresh con token salvato
Import listone
Formato atteso (intestazioni):
•	Nome
•	Ruolo (P/D/C/A)
•	Squadra
•	FM (fantamedia)
•	Fuori lista → righe con * escluse
Export
•	/api/export/teams.csv
•	/api/export/history.csv
•	/api/export/all.json
Struttura progetto
•	client/public/ → frontend
•	server/src/ → backend
•	server/data/ → salvataggi (ignorato da git)
