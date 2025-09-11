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
import { saveRoomSnapshot, loadRoomSnapshot } from './storage.js';
import { parseCSV, mapPlayers } from './csv.js';
import { randomBytes } from 'crypto';


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
    const players = mapPlayers(items, map);
    if (players.length === 0) return res.status(400).json({ ok:false, error:'Nessun giocatore valido' });

    room.players = players;
    room.currentIndex = 0;
    rebuildView(room);
    saveRoomSnapshot(serialize(room));
    broadcast(room);
    return res.json({ ok:true, imported: players.length, header });
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
  socket.on('host:toggle', (_, cb) => {
    if (room.hostOwner && room.hostOwner !== socket.id) {
      return cb && cb({ error: 'Banditore già assegnato' });
    }
    if (room.hostOwner === socket.id) {
      room.hostOwner = null; // rilascio
      broadcast(room);
      return cb && cb({ ok: true, host:false });
    }
    room.hostOwner = socket.id; // prendo
    if (room.phase === 'LOBBY') room.phase = 'ROLLING';
    broadcast(room);
    cb && cb({ ok: true, host:true });
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
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces(); const ips = [];
  for (const name of Object.keys(nets)) for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
  console.log(`FantaBid server on: http://localhost:${PORT}`); if (ips.length) console.log('LAN access:', ips.map(ip => `http://${ip}:${PORT}`).join('  '));
});
