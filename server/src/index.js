import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  rooms, makeRoom, snapshot, slugifyName, uniqueTeamId,
  rebuildView, addBackToMaster, mkHistoryPending,
  serialize, hydrate
} from './state.js';
import { saveRoomSnapshot, loadRoomSnapshot, writeBackupFile } from './storage.js';
import { parseCSV, mapPlayers } from './csv.js';
import crypto from 'crypto';

//const ORIGIN = process.env.ORIGIN || true;
//app.use(cors({ origin: ORIGIN }));
//const io = new Server(server, { cors: { origin: ORIGIN } });

const HOST_PIN = process.env.HOST_PIN || ''; // vuoto = disattivo

// Config stanza (puoi spostarla dove preferisci)
const ROOM_CFG = {
  allowOverbid: false,            // hard mode di default
  strictRules: false,             // se true blocca in offerta (non serve ora)
  enableRosterBudget: false,      // <<< DISATTIVO di default
  minRemainingCreditPerSlot: 0,   // irrilevante se enableRosterBudget=false
  slots: { P:3, D:8, C:8, A:6 }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

//const ORIGIN = process.env.ORIGIN || true;
//app.use(cors({ origin: ORIGIN }));
//const io = new Server(server, { cors: { origin: ORIGIN } });

const STATIC_DIR = path.resolve(__dirname, '../../client/public');
app.use('/', express.static(STATIC_DIR, {
  setHeaders(res, filePath){ if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store'); }
}));

const ROOM_ID = 'DEFAULT';
if (!rooms.has(ROOM_ID)) makeRoom(ROOM_ID);
rooms.get(ROOM_ID).config = ROOM_CFG; 

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

const now = () => Date.now();

function makeKey(){ return crypto.randomBytes(16).toString('hex'); }


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

function countByRole(acquisitions = []) {
  const c = { P:0, D:0, C:0, A:0 };
  for (const a of acquisitions) if (c[a.role] != null) c[a.role]++;
  return c;
}

function remainingSlots(room, team) {
  const tgt = room.config?.slots || { P:0, D:0, C:0, A:0 };
  const have = countByRole(team.acquisitions);
  return {
    P: Math.max(0, (tgt.P||0) - (have.P||0)),
    D: Math.max(0, (tgt.D||0) - (have.D||0)),
    C: Math.max(0, (tgt.C||0) - (have.C||0)),
    A: Math.max(0, (tgt.A||0) - (have.A||0)),
  };
}

function minBudgetStillNeeded(room, team, bidPrice) {
  const cfg = room.config || {};
  const teamAfter = (team.credits ?? 0) - (bidPrice || 0);
  const rem = remainingSlots(room, team);
  const totalSlotsMissing = rem.P + rem.D + rem.C + rem.A;
  if (totalSlotsMissing <= 0) return 0;
  const minPerSlot = Math.max(0, Number(cfg.minRemainingCreditPerSlot || 0));
  const required = minPerSlot * totalSlotsMissing;
  return required - teamAfter; // >0 significa "ti manca budget"
}

function validateBid(room, team, proposedPrice) {
  const cfg = room.config || {};

  // 1) Controllo crediti hard
  const credits = Number(team?.credits ?? 0);
  if (!cfg.allowOverbid && proposedPrice > credits) {
    return { ok: false, error: 'Crediti insufficienti' };
  }

  // 2) Regola rosa: applica SOLO se esplicitamente attiva e se ha senso
  if (!cfg.enableRosterBudget) return { ok: true };

  const tgt = cfg.slots || {};
  const have = countByRole(team?.acquisitions || []);

  const totalSlotsMissing =
    Math.max(0, (tgt.P||0) - (have.P||0)) +
    Math.max(0, (tgt.D||0) - (have.D||0)) +
    Math.max(0, (tgt.C||0) - (have.C||0)) +
    Math.max(0, (tgt.A||0) - (have.A||0));

  // se non ho dati di rosa o non manca nulla, non rompiamo
  const hasAnyAcq = (team?.acquisitions?.length || 0) > 0;
  if (!totalSlotsMissing || !hasAnyAcq) return { ok: true };

  const minPerSlot = Math.max(0, Number(cfg.minRemainingCreditPerSlot || 0));
  if (minPerSlot <= 0) return { ok: true };

  const teamAfter = credits - proposedPrice;
  const required = minPerSlot * totalSlotsMissing;

  if (cfg.strictRules && teamAfter < required) {
    return { ok: false, error: 'Regola rosa violata' };
  }
  if (teamAfter < required) {
    return { ok: true, warn: 'Regola rosa violata (soft)' };
  }
  return { ok: true };
}

function finalizePendingSale(room) {
  if (!room) return { ok: false, error: 'Room non trovata' };
  if (room.phase !== 'SOLD') return { ok: false, code: 'NOOP', error: 'Nessuna aggiudicazione' };

  const last = room.history[room.history.length - 1];
  if (!last) return { ok: false, code: 'NOOP', error: 'Nessuna aggiudicazione' };
  if (last.finalized) return { ok: false, code: 'NOOP', error: 'Già finalizzato' };

  const tid = last.teamId || room.leader;
  if (!tid) return { ok: false, error: 'Team non trovato' };

  const team = room.teams.get(tid);
  if (!team) return { ok: false, error: 'Team non trovato', teamId: tid };

  const price = Number(last.price || 0) || 0;
  if (team.credits < price) return { ok: false, error: 'Crediti insufficienti', teamId: team.id };

  if (room.config?.enableRosterBudget) {
    const debt = minBudgetStillNeeded(room, team, price);
    if (debt > 0) return { ok: false, error: 'Regola rosa violata', teamId: team.id };
  }

  const playerName = last.playerName && String(last.playerName).trim() ? last.playerName : '(??)';
  const role = last.role || '';
  const playerTeam = last.playerTeam || '';
  const playerFm = last.playerFm ?? null;

  last.playerName = playerName;
  last.role = role;
  last.playerTeam = playerTeam;
  last.playerFm = playerFm;
  last.teamId = team.id;
  last.teamName = team.name;

  team.credits -= price;
  if (!Array.isArray(team.acquisitions)) team.acquisitions = [];
  team.acquisitions.push({ player: playerName, role, price, at: Date.now() });

  removeFromMasterBySnapshot(room, last);

  room.topBid = 0;
  room.leader = null;
  room.phase = 'ROLLING';
  room.rolling = false;
  room.autoAssignError = null;

  last.finalized = true;
  last.finalizedAt = Date.now();

  return { ok: true, teamId: team.id, price };
}

function removeFromMasterBySnapshot(room, h) {
  if (!room || !h) return;

  const name = String(h.playerName || '').trim().toLowerCase();
  const role = String(h.role || '').trim();
  const team = String(h.playerTeam || '').trim().toLowerCase();
  const fm = h.playerFm ?? null;

  if (!name || !role) return;

  const idx = room.players.findIndex(p => {
    if (!p) return false;

    const pn = String(p.name || '').trim().toLowerCase();
    const pr = String(p.role || '').trim();
    if (pn !== name || pr !== role) return false;

    if (team) {
      const pt = String(p.team || '').trim().toLowerCase();
      if (!pt || pt !== team) return false;
    }

    if (fm !== null && fm !== undefined && fm !== '') {
      const pfm = p.fm ?? null;
      if (pfm === null || pfm === undefined || pfm === '') return false;
      if (Number(pfm) !== Number(fm)) return false;
    }

    return true;
  });

  if (idx >= 0) {
    room.players.splice(idx, 1);
    rebuildView(room);
  }
}

function recordAutoAssignError(room, result, source = 'auto') {
  const last = room.history[room.history.length - 1] || null;
  const fallbackTeamId = result?.teamId || last?.teamId || room.leader || null;
  const fallbackTeam = fallbackTeamId ? room.teams.get(fallbackTeamId) || null : null;

  room.autoAssignError = {
    message: result?.error || 'Errore auto-assegnazione',
    teamId: fallbackTeamId,
    teamName: fallbackTeam?.name || last?.teamName || null,
    price: last?.price ?? null,
    playerName: last?.playerName || null,
    role: last?.role || null,
    at: Date.now(),
    source,
  };
}

function scheduleAutoFinalize(room) {
  if (!room) return;
  if (room.__autoFinalizeScheduled) return;
  room.__autoFinalizeScheduled = true;
  setImmediate(() => {
    room.__autoFinalizeScheduled = false;
    let result;
    try {
      result = finalizePendingSale(room);
    } catch (err) {
      console.error('[autoFinalize] Errore inatteso durante l\'assegnazione automatica:', err);
      recordAutoAssignError(room, { error: err?.message || 'Errore sconosciuto' }, 'auto');
      broadcast(room);
      return;
    }
    if (!result.ok) {
      if (result.code === 'NOOP') return;
      recordAutoAssignError(room, result, 'auto');
      console.warn('[autoFinalize] Fallita auto-assegnazione:', room.autoAssignError);
      broadcast(room);
      return;
    }
    const snap = serialize(room);
    saveRoomSnapshot(snap);
    try { writeBackupFile(snap); } catch {}
    broadcast(room);
  });
}

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
          const pendingSnap = serialize(room);
          saveRoomSnapshot(pendingSnap);
          // >>> BACKUP TIMESTAMPED QUI <<<
          try { writeBackupFile(pendingSnap); } catch {}
          scheduleAutoFinalize(room);
        }
        broadcast(room);
      }
    }
  }
}, 150);


/* ===== RULLO ADATTIVO SU rollMs ===== */
setInterval(() => {
  const room = rooms.get(ROOM_ID);
  if (!room) return;

  // inizializza tick interno (non persistente)
  if (!room.__rollTickAt) room.__rollTickAt = now();

  // gira solo in ROLLING
  if (room.rolling && room.phase === 'ROLLING' && room.viewPlayers.length > 0) {
    const ms = Math.max(300, Math.min(5000, Number(room.rollMs || 2000)));
    const t = now();
    if (t - room.__rollTickAt >= ms) {
      room.__rollTickAt = t;
      room.currentIndex = (room.currentIndex + 1) % room.viewPlayers.length;
      broadcast(room);
    }
  } else {
    // se non sta girando, riallinea il tick per evitare scatti alla ripartenza
    room.__rollTickAt = now();
  }
}, 120);

function ensureHostToken(room){
  if(!room.hostToken) room.hostToken = crypto.randomBytes(16).toString('hex');
  return room.hostToken;
}

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


socket.on('host:toggle', ({ pin } = {}, cb) => {
  if (room.hostOwner && room.hostOwner !== socket.id) {
    return cb && cb({ error: 'Banditore già assegnato' });
  }
  if (!room.hostOwner) {
    if (HOST_PIN && pin !== HOST_PIN) return cb && cb({ error: 'PIN mancante o errato' });
    room.hostOwner = socket.id;
    if (room.phase === 'LOBBY') room.phase = 'ROLLING';
    const token = ensureHostToken(room);            // <<< genera/recupera token
    saveRoomSnapshot(serialize(room));
    broadcast(room);
    return cb && cb({ ok:true, host:true, hostToken: token });  // <<< invia token
  } else if (room.hostOwner === socket.id) {
    room.hostOwner = null;
    saveRoomSnapshot(serialize(room));
    broadcast(room);
    return cb && cb({ ok:true, host:false });
  }
});

const FILTER_LOCKED_PHASES = ['RUNNING','ARMED','COUNTDOWN'];
const FILTER_LOCKED_ERROR = 'Puoi cambiare filtri solo quando l’asta è ferma o dopo l’assegnazione.';

socket.on('host:setFilterName', ({ q }, cb) => {
  if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
  if (FILTER_LOCKED_PHASES.includes(room.phase)) {
    return cb && cb({ error: FILTER_LOCKED_ERROR });
  }
  room.filterName = String(q || '');
  rebuildView(room);
  saveRoomSnapshot(serialize(room));
  broadcast(room);
  cb && cb({ ok: true });
});



  /* FILTRO RUOLO E RANDOM */
  socket.on('host:setRoleFilter', ({ role }, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    if (FILTER_LOCKED_PHASES.includes(room.phase)) {
      return cb && cb({ error: FILTER_LOCKED_ERROR });
    }
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
    if (FILTER_LOCKED_PHASES.includes(room.phase)) {
      return cb && cb({ error: FILTER_LOCKED_ERROR });
    }
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
  if (room.rolling) {
    room.__rollTickAt = now();
    room.phase = 'ROLLING';
  }
  saveRoomSnapshot(serialize(room)); // <<< aggiunto
  broadcast(room);
  cb && cb({ ok: true, rolling: room.rolling });
});


// reclaim su reload
socket.on('host:reclaim', ({ token }, cb)=>{
  if(!token || token !== room.hostToken) return cb && cb({ error:'Token host non valido' });
  room.hostOwner = socket.id;
  saveRoomSnapshot(serialize(room));
  cb && cb({ ok:true });
  broadcast(room);
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

  const lastBidBySocket = new Map();
function hitSpam(socketId){
  const t = now(); const last = lastBidBySocket.get(socketId) || 0;
  if (t - last < 120) return true;
  lastBidBySocket.set(socketId, t);
  return false;
}

/* BID INCREMENTALE */
socket.on('team:bid_inc', ({ amount }, cb) => {
  const tid = socket.data.teamId;
  if (!tid) return cb && cb({ error: 'Registrati prima' });
  if (!['ROLLING','RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Asta non in corso' });
  if (room.leader === tid && room.phase !== 'ROLLING') return cb && cb({ error: 'Sei già in testa' });

  const inc = Math.floor(Number(amount || 0));
  if (inc <= 0) return cb && cb({ error: 'Importo non valido' });

  if (hitSpam(socket.id)) return cb && cb({ ok: true }); // antispam

  const team = room.teams.get(tid);
  if (!team) return cb && cb({ error: 'Team non trovato' });

  const proposed = room.topBid + inc;

  // valida PRIMA di muovere la state machine
  const v = validateBid(room, team, proposed);
  if (!v.ok) return cb && cb({ error: v.error }); // rifiutata, l’asta prosegue col leader corrente

  // ora puoi “avviare” la fase gara se serve
  ensureAuctionStartedByBid();

  const nowTs = now();
  const last = room.lastBuzzBy[tid] || 0;
  if (nowTs - last < 80) return cb && cb({ ok: true });

  room.lastBuzzBy[tid] = nowTs;
  room.topBid = proposed;
  room.leader = tid;
  setArmed(room);
  broadcast(room);
  cb && cb({ ok: true, topBid: room.topBid, warn: v.warn });
});


/* BID LIBERO */
socket.on('team:bid_free', ({ value }, cb) => {
  const tid = socket.data.teamId;
  if (!tid) return cb && cb({ error: 'Registrati prima' });
  if (!['ROLLING','RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Asta non in corso' });
  if (room.leader === tid && room.phase !== 'ROLLING') return cb && cb({ error: 'Sei già in testa' });

  const val = Math.floor(Number(value || 0));
  if (!Number.isFinite(val) || val <= room.topBid) return cb && cb({ error: 'Offerta troppo bassa' });

  if (hitSpam(socket.id)) return cb && cb({ ok: true }); // antispam

  const team = room.teams.get(tid);
  if (!team) return cb && cb({ error: 'Team non trovato' });

  // valida PRIMA di muovere la state machine
  const v = validateBid(room, team, val);
  if (!v.ok) return cb && cb({ error: v.error }); // rifiutata, l’asta prosegue

  // ok, ora avvia la gara se serve
  ensureAuctionStartedByBid();

  room.topBid = val;
  room.leader = tid;
  setArmed(room);
  broadcast(room);
  cb && cb({ ok: true, topBid: room.topBid, warn: v.warn });
});



  /* AUTO-ASSEGNAZIONE + RIMOZIONE DALLA LISTA + RESET RIEPILOGO */
  socket.on('winner:autoAssign', (_, cb) => {
    const room = rooms.get(ROOM_ID);
    const result = finalizePendingSale(room);
    if (!result.ok) {
      if (room.phase === 'SOLD' && result.code !== 'NOOP') {
        recordAutoAssignError(room, result, 'manual');
        broadcast(room);
      }
      return cb && cb({ error: result.error });
    }
    const snap = serialize(room);
    saveRoomSnapshot(snap);
    try { writeBackupFile(snap); } catch {}
    broadcast(room);
    cb && cb({ ok: true });
  });

  /* KICK PARTECIPANTE (host only, non durante asta) */
socket.on('host:kick', ({ teamId }, cb) => {
  if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
  if (['RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Non puoi rimuovere durante l’asta' });
  if (!teamId || !room.teams.has(teamId)) return cb && cb({ error: 'Team inesistente' });

  const t = room.teams.get(teamId);
  // avvisa il socket del team (se è online)
  if (t?.socketId) io.to(t.socketId).emit('you:kicked', { reason: 'Rimosso dal banditore' });

  // rimetti i giocatori presi nel listone, senza riaccredito
  if (t && Array.isArray(t.acquisitions)) {
    for (const a of t.acquisitions) addBackToMaster(room, { name: a.player, role: a.role });
    t.acquisitions = [];
  }

  // se era leader, resetta
  if (room.leader === teamId) { room.leader = null; room.topBid = 0; }

  // elimina il team
  room.teams.delete(teamId);

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
  addBackToMaster(room, { name: h.playerName, role: h.role, team: h.playerTeam, fm: h.playerFm });

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

socket.on('host:skip', (_ , cb) => {
  if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
  if (!room.viewPlayers.length) return cb && cb({ error: 'Lista vuota' });
  if (['RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Ferma l’asta prima' });
  room.currentIndex = (room.currentIndex + 1) % room.viewPlayers.length;
  saveRoomSnapshot(serialize(room)); broadcast(room);
  cb && cb({ ok:true, index: room.currentIndex });
});

socket.on('host:backN', ({ n }, cb) => {
  if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
  if (!room.viewPlayers.length) return cb && cb({ error: 'Lista vuota' });
  if (['RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Ferma l’asta prima' });
  const k = Math.max(1, Math.floor(Number(n||1)));
  const len = room.viewPlayers.length;
  room.currentIndex = ( (room.currentIndex - (k % len)) + len ) % len;
  saveRoomSnapshot(serialize(room)); broadcast(room);
  cb && cb({ ok:true, index: room.currentIndex });
});

socket.on('host:pinPlayer', ({ index }, cb) => {
  if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
  const i = Math.floor(Number(index));
  if (!Number.isFinite(i) || i < 0 || i >= room.viewPlayers.length) return cb && cb({ error: 'Indice non valido' });
  if (['RUNNING','ARMED','COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Ferma l’asta prima' });
  room.currentIndex = i;
  saveRoomSnapshot(serialize(room)); broadcast(room);
  cb && cb({ ok:true });
});

socket.on('host:setRollMs', ({ ms }, cb) => {
  const room = rooms.get(ROOM_ID);
  if (!room) return cb && cb({ error: 'Room non trovata' });
  if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
  const v = Math.floor(Number(ms || 0));
  if (!Number.isFinite(v) || v < 300 || v > 5000) return cb && cb({ error: 'Valore non valido (300–5000 ms)' });
  room.rollMs = v;
  saveRoomSnapshot(serialize(room));
  room.__rollTickAt = now();
  broadcast(room);
  cb && cb({ ok: true, rollMs: v });
});

});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces(); const ips = [];
  for (const name of Object.keys(nets)) for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
  console.log(`FantaBid server on: http://localhost:${PORT}`); if (ips.length) console.log('LAN access:', ips.map(ip => `http://${ip}:${PORT}`).join('  '));
});
