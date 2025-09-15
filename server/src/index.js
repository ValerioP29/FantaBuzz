import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  rooms, makeRoom, snapshot, slugifyName, uniqueTeamId,
  rebuildView, removeCurrentFromMaster, addBackToMaster, mkHistoryPending,
  serialize, hydrate
} from './state.js';
import { saveRoomSnapshot, loadRoomSnapshot, writeBackupFile } from './storage.js';
import { parseCSV, mapPlayers } from './csv.js';
import { randomBytes } from 'crypto';

const HOST_PIN = process.env.HOST_PIN || ''; // vuoto = disattivo

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const STATIC_DIR = path.resolve(__dirname, '../../client/public');
app.use('/', express.static(STATIC_DIR, {
  setHeaders(res, filePath){ if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store'); }
}));

const ROOM_ID = 'DEFAULT';
if (!rooms.has(ROOM_ID)) makeRoom(ROOM_ID);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

const now = () => Date.now();

function makeKey(){ return randomBytes(16).toString('hex'); }


function broadcast(room){
  for (const [, s] of io.of('/').sockets) {
    const data = s.data || {};
    if ((data.roomId || ROOM_ID) === room.id) {
      s.emit('state', snapshot(room, data.teamId || null, s.id));
    }
  }
}

function setArmed(room){ room.phase = 'ARMED'; room.deadline = now() + room.armMs; room.countdownSec = 0; }
function setCountdown(room){ room.phase = 'COUNTDOWN'; room.countdownSec = 3; room.deadline = now() + 1000; }

/* ===== Re-hydration all'avvio ===== */
try {
  const snap = loadRoomSnapshot(ROOM_ID);
  if (snap) hydrate(rooms.get(ROOM_ID), snap);
} catch { /* pace */ }

/* ===== API: Import CSV listone =====
  Body: { csv: "<testo csv>", map: { name: 'name', role: 'role' } }
*/
app.post('/api/listone/import', (req, res) => {
  try{
    const room = rooms.get(ROOM_ID);
    const { csv, map = { name: 'name', role: 'role' } } = req.body || {};
    if (!csv || typeof csv !== 'string') return res.status(400).json({ ok:false, error:'CSV mancante' });

    const { header, items } = parseCSV(csv);
    const total = items.length;
    const players = mapPlayers(items, map);
    const imported = players.length;
    const rejected = Math.max(0, total - imported);

    if (players.length === 0) return res.status(400).json({ ok:false, error:'Nessun giocatore valido', header, imported, rejected });

    room.players = players;
    room.currentIndex = 0;
    rebuildView(room);
    saveRoomSnapshot(serialize(room));
    broadcast(room);
    return res.json({ ok:true, imported, rejected, header });
  } catch(e){
    return res.status(500).json({ ok:false, error: e?.message || 'Errore import' });
  }
});


/* ===== API Export ===== */
app.get('/api/export/teams.csv', (_req, res) => {
  const room = rooms.get(ROOM_ID);
  const rows = [['team','credits']].concat([...room.teams.values()].map(t => [t.name, t.credits]));
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.send(rows.map(r => r.map(v => String(v).replaceAll('"','""')).join(',')).join('\n'));
});

app.get('/api/export/history.csv', (_req, res) => {
  const room = rooms.get(ROOM_ID);
  const rows = [['at','team','player','role','price']]
    .concat(room.history.map(h => [new Date(h.at).toISOString(), h.teamName, h.playerName, h.role, h.price]));
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.send(rows.map(r => r.map(v => String(v).replaceAll('"','""')).join(',')).join('\n'));
});

app.get('/api/export/all.json', (_req, res) => {
  const room = rooms.get(ROOM_ID);
  res.json({ teams: [...room.teams.values()], history: room.history, players: room.players });
});

app.get('/api/export/team/:id.csv', (req, res) => {
  const room = rooms.get(ROOM_ID);
  const t = room.teams.get(req.params.id);
  if (!t) return res.status(404).send('Team non trovato');
  const rows = [['player','role','price','at']]
    .concat((t.acquisitions||[]).map(a => [a.player, a.role, a.price, new Date(a.at).toISOString()]));
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.send(rows.map(r => r.join(',')).join('\n'));
});

app.get('/api/export/remaining.csv', (_req, res) => {
  const room = rooms.get(ROOM_ID);
  const rows = [['name','role','team','fm']]
    .concat(room.players.map(p => [p.name, p.role, p.team || '', p.fm ?? '']));
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.send(rows.map(r => r.join(',')).join('\n'));
});


/* ===== API: Link invito con prefill team opzionale ===== */
app.get('/api/invite', (req, res) => {
  const team = (req.query.team || '').trim();
  const base = req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']
    ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
    : `http://localhost:${PORT}`;
  const url = team ? `${base}/?team=${encodeURIComponent(team)}` : base;
  res.json({ ok:true, url });
});

/* ===== COUNTDOWN ===== */
setInterval(() => {
  const room = rooms.get(ROOM_ID);
  if (!room) return;
  const t = now();
  if (room.deadline && t >= room.deadline){
    if (room.phase === 'ARMED'){
      setCountdown(room); broadcast(room);
    } else if (room.phase === 'COUNTDOWN'){
      if (room.countdownSec > 1){
        room.countdownSec -= 1; room.deadline = now() + 1000; broadcast(room);
      } else {
        room.phase = 'SOLD';
        room.deadline = 0; room.countdownSec = 0;
        if (room.leader){
          // crea entry pending, verrà completata in winner:autoAssign
          mkHistoryPending(room);
          saveRoomSnapshot(serialize(room));
          // >>> BACKUP TIMESTAMPED QUI <<<
          try { writeBackupFile(serialize(room)); } catch {}
        }
        broadcast(room);
      }
    }
  }
}, 150);


/* ===== RULLO 2.5s ===== */
setInterval(() => {
  const room = rooms.get(ROOM_ID);
  if (!room) return;
  if (room.rolling && room.phase === 'ROLLING' && room.viewPlayers.length > 0) {
    room.currentIndex = (room.currentIndex + 1) % room.viewPlayers.length;
    broadcast(room);
  }
}, 2500);

io.on('connection', socket => {
  const room = rooms.get(ROOM_ID);
  socket.data = { roomId: ROOM_ID, teamId: null, displayName: null };
  socket.join(ROOM_ID);
  socket.emit('state', snapshot(room, null, socket.id));

  /* REGISTRAZIONE */
socket.on('team:register', ({ name, credits }, cb) => {
  try {
    if (!name) return cb && cb({ error: 'Nome squadra obbligatorio' });
    const base = slugifyName(name);

    // <<< BLOCCA NOMI GIÀ USATI >>>
    for (const t of room.teams.values()) {
      if (slugifyName(t.name) === base) {
        return cb && cb({ error: 'Nome già registrato. Ricarica la pagina per riprendere la sessione.' });
      }
    }

    const tid = uniqueTeamId(room, base);
    const team = {
      id: tid,
      name: String(name).trim(),
      credits: Number(credits || 0),
      acquisitions: [],
      socketId: socket.id,
      key: makeKey()
    };
    room.teams.set(tid, team);
    socket.data.teamId = tid;
    socket.data.displayName = team.name;
    saveRoomSnapshot(serialize(room));
    broadcast(room);
    cb && cb({ ok: true, teamId: tid, key: team.key });
  } catch (e) {
    cb && cb({ error: e?.message || 'Errore registrazione' });
  }
});


/* RIPRESA SESSIONE dopo refresh: ricollega il socket a un team esistente */
socket.on('team:resume', ({ teamId, key }, cb) => {
  try{
    if (!teamId || !key) return cb && cb({ error: 'Dati mancanti' });
    const team = room.teams.get(teamId);
    if (!team) return cb && cb({ error: 'Team non trovato' });
    if (team.key && key !== team.key) return cb && cb({ error: 'Token non valido' });

    // collega questo socket al team
    socket.data.teamId = team.id;
    socket.data.displayName = team.name;
    team.socketId = socket.id;

    saveRoomSnapshot(serialize(room));
    broadcast(room);
    cb && cb({ ok:true, teamId: team.id, name: team.name, credits: team.credits });
  } catch(e){
    cb && cb({ error: e?.message || 'Errore resume' });
  }
});


  /* BANDITORE UNICO */
 socket.on('host:toggle', ({ pin } = {}, cb) => {
  if (room.hostOwner && room.hostOwner !== socket.id) {
    return cb && cb({ error: 'Banditore già assegnato' });
  }
  if (!room.hostOwner) {
    if (HOST_PIN && pin !== HOST_PIN) return cb && cb({ error: 'PIN mancante o errato' });
    room.hostOwner = socket.id;
    if (room.phase === 'LOBBY') room.phase = 'ROLLING';
    broadcast(room);
    return cb && cb({ ok:true, host:true });
  } else if (room.hostOwner === socket.id) {
    room.hostOwner = null;
    broadcast(room);
    return cb && cb({ ok:true, host:false });
  }
});


  /* FILTRO RUOLO E RANDOM */
  socket.on('host:setRoleFilter', ({ role }, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    const allowed = ['ALL','P','D','C','A'];
    const r = (role || 'ALL').toUpperCase();
    if (!allowed.includes(r)) return cb && cb({ error: 'Ruolo non valido' });
    room.filterRole = r;
    rebuildView(room);
    if (room.viewPlayers.length === 0) { room.rolling = false; }
    saveRoomSnapshot(serialize(room));
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on('host:randomStart', (_, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const pick = letters[Math.floor(Math.random() * letters.length)];
    const { usedStart } = rebuildView(room, pick);
    saveRoomSnapshot(serialize(room));
    broadcast(room);
    cb && cb({ ok: true, letter: usedStart || pick });
  });

  /* PAUSA/PLAY RULLO */
  socket.on('host:toggleRoll', (_, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    if (['RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Ferma l’asta prima' });
    if (!room.viewPlayers.length) return cb && cb({ error: 'Nessun giocatore da scorrere' });
    room.rolling = !room.rolling;
    if (room.rolling) room.phase = 'ROLLING';
    broadcast(room);
    cb && cb({ ok: true, rolling: room.rolling });
  });

  /* OFFERTE: prima offerta in ROLLING avvia RUNNING e stoppa rullo. No auto-rialzo. */
  function ensureAuctionStartedByBid(){
    if (room.phase === 'ROLLING') {
      room.phase = 'RUNNING';
      room.rolling = false;
      room.deadline = 0;
      room.countdownSec = 0;
      room.lastBuzzBy = {};
    }
  }

  socket.on('team:bid_inc', ({ amount }, cb) => {
    const tid = socket.data.teamId;
    if (!tid) return cb && cb({ error: 'Registrati prima' });
    if (!['ROLLING','RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Asta non in corso' });

    if (room.leader === tid && room.phase !== 'ROLLING') return cb && cb({ error: 'Sei già in testa' });

    const inc = Math.floor(Number(amount || 0));
    if (inc <= 0) return cb && cb({ error: 'Importo non valido' });

    ensureAuctionStartedByBid();

    const nowTs = now(); const last = room.lastBuzzBy[tid] || 0;
    if (nowTs - last < 80) return cb && cb({ ok: true }); // antispam

    room.lastBuzzBy[tid] = nowTs;
    room.topBid += inc;
    room.leader = tid;
    setArmed(room);
    broadcast(room);
    cb && cb({ ok: true, topBid: room.topBid });
  });

  socket.on('team:bid_free', ({ value }, cb) => {
    const tid = socket.data.teamId;
    if (!tid) return cb && cb({ error: 'Registrati prima' });
    if (!['ROLLING','RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Asta non in corso' });

    if (room.leader === tid && room.phase !== 'ROLLING') return cb && cb({ error: 'Sei già in testa' });

    const val = Math.floor(Number(value || 0));
    if (!Number.isFinite(val) || val <= room.topBid) return cb && cb({ error: 'Offerta troppo bassa' });

    ensureAuctionStartedByBid();

    room.topBid = val;
    room.leader = tid;
    setArmed(room);
    broadcast(room);
    cb && cb({ ok: true, topBid: room.topBid });
  });

  /* AUTO-ASSEGNAZIONE + RIMOZIONE DALLA LISTA + RESET RIEPILOGO */
  socket.on('winner:autoAssign', (_, cb) => {
    const room = rooms.get(ROOM_ID);
    const last = room.history[room.history.length - 1];
    if (room.phase !== 'SOLD' || !last) return cb && cb({ error: 'Nessuna aggiudicazione' });
    const tid = last.teamId || room.leader; // fallback se serve
    const team = room.teams.get(tid);
    if (!team) return cb && cb({ error: 'Team non trovato' });
    const p = last.price;
    if (team.credits < p) return cb && cb({ error: 'Crediti insufficienti' });

    team.credits -= p;
    const player = room.viewPlayers[room.currentIndex];
    last.playerName = player?.name || '(??)';
    last.role = player?.role || '';
    team.acquisitions.push({ player: last.playerName, role: last.role, price: p, at: Date.now() });

    removeCurrentFromMaster(room);

    room.topBid = 0;
    room.leader = null;
    room.phase = 'ROLLING';
    room.rolling = false; // fermo finché il banditore non fa Play
    saveRoomSnapshot(serialize(room));
    broadcast(room);
    cb && cb({ ok: true });
  });

  /* KICK PARTECIPANTE (host only, non durante asta) */
  socket.on('host:kick', ({ teamId }, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    if (['RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Non puoi rimuovere durante l’asta' });
    if (!teamId || !room.teams.has(teamId)) return cb && cb({ error: 'Team inesistente' });

    const wasHost = [...io.of('/').sockets.values()].find(s => s.id === room.hostOwner)?.data?.teamId === teamId;
    if (wasHost) room.hostOwner = null;

    room.teams.delete(teamId);
    if (room.leader === teamId) { room.leader = null; room.topBid = 0; }
    saveRoomSnapshot(serialize(room));
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    if (room.hostOwner === socket.id) { room.hostOwner = null; broadcast(room); }
  });
  /* USCITA PARTECIPANTE: rimuove il team dalla stanza (solo fuori asta) */
socket.on('team:leave', (_ , cb) => {
  try {
    const tid = socket.data.teamId;
    if (!tid) return cb && cb({ error: 'Nessuna sessione attiva' });

    // non consentire durante l’asta
    if (['RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) {
      return cb && cb({ error: 'Non puoi uscire durante un’asta in corso' });
    }

    // se era leader resetta eventuale topBid
    if (room.leader === tid) { room.leader = null; room.topBid = 0; }

    // se era host, libera
    if (room.hostOwner === socket.id) room.hostOwner = null;

    // rimuovi team
    room.teams.delete(tid);

    // sgancia il socket
    socket.data.teamId = null;
    socket.data.displayName = null;

    saveRoomSnapshot(serialize(room));
    broadcast(room);
    cb && cb({ ok: true });
  } catch (e) {
    cb && cb({ error: e?.message || 'Errore uscita' });
  }
});

/* AGGIORNA PROFILO TEAM (nome/crediti) */
socket.on('team:updateProfile', ({ name, credits }, cb) => {
  try {
    const tid = socket.data.teamId;
    if (!tid) return cb && cb({ error: 'Nessuna sessione attiva' });
    const team = room.teams.get(tid);
    if (!team) return cb && cb({ error: 'Team non trovato' });

    if (typeof name === 'string' && name.trim()) {
      const base = slugifyName(name);
      // blocca collisioni con altri team (lo stesso id può cambiare nome)
      for (const t of room.teams.values()) {
        if (t.id !== tid && slugifyName(t.name) === base) {
          return cb && cb({ error: 'Nome già usato da un altro team' });
        }
      }
      team.name = name.trim();
    }

    if (credits != null) {
      const c = Number(credits);
      if (!Number.isFinite(c) || c < 0) return cb && cb({ error: 'Crediti non validi' });
      team.credits = c;
    }

    saveRoomSnapshot(serialize(room));
    broadcast(room);
    cb && cb({ ok: true, team: { id: team.id, name: team.name, credits: team.credits } });
  } catch (e) {
    cb && cb({ error: e?.message || 'Errore aggiornamento profilo' });
  }
});

socket.on('host:stopRoll', (_ , cb) => {
  const room = rooms.get(ROOM_ID);
  if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
  room.rolling = false;
  if (room.phase === 'ROLLING') room.phase = 'ROLLING'; // resta in ROLLING ma fermo
  saveRoomSnapshot(serialize(room));
  broadcast(room);
  cb && cb({ ok:true });
});

socket.on('host:undoPurchase', ({ historyId }, cb) => {
  const room = rooms.get(ROOM_ID);
  if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
  if (['RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Non puoi fare UNDO durante l’asta' });

  const idx = room.history.findIndex(h => h.id === historyId);
  if (idx < 0) return cb && cb({ error: 'Voce storico non trovata' });

  const h = room.history[idx];
  if (!h.playerName || !h.role || !h.teamId) return cb && cb({ error: 'Voce incompleta' });

  // 1) restituisci i crediti
  const team = room.teams.get(h.teamId);
  if (team) team.credits += (h.price || 0);

  // 2) togli l’acquisto dalla rosa del team
  if (team && Array.isArray(team.acquisitions)) {
    const pos = team.acquisitions.findIndex(a => a.player === h.playerName && a.role === h.role && a.price === h.price);
    if (pos >= 0) team.acquisitions.splice(pos, 1);
  }

  // 3) rimetti il giocatore nel master
  addBackToMaster(room, { name: h.playerName, role: h.role });

  // 4) rimuovi la voce di storico
  room.history.splice(idx, 1);

  // 5) reset eventuali riepiloghi asta ferma
  if (!['RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) {
    room.topBid = 0; room.leader = null;
  }

  saveRoomSnapshot(serialize(room));
  // backup puntuale
  try { writeBackupFile(serialize(room)); } catch {}
  broadcast(room);
  cb && cb({ ok:true });
});

socket.on('host:exitAndClose', (_ , cb) => {
  const room = rooms.get(ROOM_ID);
  if (!room) return cb && cb({ error:'Room inesistente' });
  if (room.hostOwner !== socket.id) return cb && cb({ error:'Non sei il banditore' });

  // 1) nuova sessione
  room.sessionEpoch = (room.sessionEpoch || 1) + 1;

  // 2) pulizia partecipanti e aggiudicazioni
  room.teams = new Map();      // se usi oggetto, fai {}
  room.history = [];

  // 3) reset banditore e stato gara
  room.hostOwner = null;
  room.leader = null;
  room.topBid = 0;
  room.deadline = 0;
  room.countdownSec = 0;
  room.currentIndex = 0;       // opzionale: riparti dall’inizio del listone
  room.phase = 'LOBBY';        // o 'ROLLING' se preferisci pre-roll pronto

  saveRoomSnapshot(serialize(room));
  broadcast(room);

  cb && cb({ ok:true });
});


});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces(); const ips = [];
  for (const name of Object.keys(nets)) for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
  console.log(`FantaBid server on: http://localhost:${PORT}`); if (ips.length) console.log('LAN access:', ips.map(ip => `http://${ip}:${PORT}`).join('  '));
});
