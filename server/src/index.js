/* ================= DEPENDENCIES ================ */
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import {
  rooms,
  makeRoom,
  snapshot,
  slugifyName,
  uniqueTeamId,
  rebuildView,
  addBackToMaster,
  mkHistoryPending,
  serialize,
  hydrate,
  playerKey,
} from './state.js';
import { saveRoomSnapshot, loadRoomSnapshot, writeBackupFile } from './storage.js';
import { parseCSV, mapPlayers } from './csv.js';

/* ================= CONFIGURATION =============== */
const HOST_PIN = process.env.HOST_PIN || '';

const ROOM_CFG = {
  allowOverbid: false,
  strictRules: false,
  enableRosterBudget: false,
  minRemainingCreditPerSlot: 0,
  slots: { P: 3, D: 8, C: 8, A: 6 },
};

const ROOM_ID = 'DEFAULT';

/* ================= APPLICATION SETUP =========== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const STATIC_DIR = path.resolve(__dirname, '../../client/public');
app.use(
  '/',
  express.static(STATIC_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }),
);

if (!rooms.has(ROOM_ID)) makeRoom(ROOM_ID);
rooms.get(ROOM_ID).config = ROOM_CFG;

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

/* ================= GENERAL HELPERS ============ */
/** Restituisce il timestamp corrente in millisecondi. */
const now = () => Date.now();

/** Genera una chiave casuale per sessioni e token di squadra. */
function makeKey() {
  return crypto.randomBytes(16).toString('hex');
}

/* ================= AUTH HELPERS =============== */
/** Estrae il token host dagli header personalizzati o Bearer. */
function extractHostToken(req) {
  let headerToken = req.headers['x-host-token'];
  if (Array.isArray(headerToken)) headerToken = headerToken[0];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return null;
}

/** Middleware che valida il token host per le API riservate. */
function requireHostAuth(req, res, next) {
  const room = rooms.get(ROOM_ID);
  if (!room || !room.hostToken) {
    return res.status(403).json({ ok: false, error: 'Banditore non attivo' });
  }
  const token = extractHostToken(req);
  if (!token || token !== room.hostToken) {
    return res.status(403).json({ ok: false, error: 'Autorizzazione host richiesta' });
  }
  req.room = room;
  next();
}

/* ================= RATE LIMIT ================= */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const rateLimitBuckets = new Map();

/** Limita il numero di richieste di import per IP in una finestra temporale. */
function importRateLimit(req, res, next) {
  const nowTs = now();
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  let bucket = rateLimitBuckets.get(ip);
  if (!bucket || nowTs - bucket.start > RATE_LIMIT_WINDOW_MS) {
    bucket = { start: nowTs, count: 0 };
    rateLimitBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ ok: false, error: 'Troppi tentativi, riprova più tardi' });
  }
  next();
}

/** Genera e registra un nuovo token host per la stanza. */
function issueHostToken(room) {
  const token = crypto.randomBytes(16).toString('hex');
  room.hostToken = token;
  return token;
}

/* ================= ROOM SYNC =================== */
/** Invia lo stato aggiornato a tutti i socket connessi alla stanza. */
function broadcast(room) {
  for (const [, s] of io.of('/').sockets) {
    const data = s.data || {};
    if ((data.roomId || ROOM_ID) === room.id) {
      s.emit('state', snapshot(room, data.teamId || null, s.id));
    }
  }
}

/** Aggiorna la fase dell'asta e azzera i campi coerenti con il nuovo stato. */
function transitionPhase(room, nextPhase) {
  if (!room) return;
  if (room.phase === nextPhase) return;

  room.phase = nextPhase;

  switch (nextPhase) {
    case 'LOBBY':
    case 'ROLLING':
      room.topBid = 0;
      room.leader = null;
      room.rolling = false;
      room.deadline = 0;
      room.countdownSec = 0;
      room.lastBuzzBy = {};
      room.autoAssignError = null;
      break;
    case 'RUNNING':
      room.rolling = false;
      room.deadline = 0;
      room.countdownSec = 0;
      room.lastBuzzBy = {};
      break;
    case 'ARMED':
      room.deadline = now() + (room.armMs || 0);
      room.countdownSec = 0;
      break;
    case 'COUNTDOWN':
      room.countdownSec = 3;
      room.deadline = now() + 1000;
      break;
    case 'SOLD':
      room.deadline = 0;
      room.countdownSec = 0;
      break;
    default:
      break;
  }

  room.version = (room.version || 0) + 1;
  persistRoom(room);
  broadcast(room);
}

/* ================= PERSISTENCE HELPERS ========= */
/** Serializza e salva lo stato della stanza, gestendo eventuali errori. */
function persistRoom(room) {
  if (!room) return null;
  try {
    const snap = serialize(room);
    saveRoomSnapshot(snap);
    return snap;
  } catch (err) {
    console.error('[persistRoom] Errore durante il salvataggio della stanza:', err);
    return null;
  }
}

/** Porta rapidamente la stanza nella fase ARMATA. */
function setArmed(room) {
  transitionPhase(room, 'ARMED');
}

/** Porta rapidamente la stanza nella fase COUNTDOWN. */
function setCountdown(room) {
  transitionPhase(room, 'COUNTDOWN');
}

/* ================= ROSTER HELPERS ============== */
/** Conta il numero di giocatori per ruolo in una lista acquisizioni. */
function countByRole(acquisitions = []) {
  const c = { P: 0, D: 0, C: 0, A: 0 };
  for (const a of acquisitions) if (c[a.role] != null) c[a.role]++;
  return c;
}

/** Calcola gli slot residui per ciascun ruolo rispetto alla configurazione. */
function remainingSlots(room, team) {
  const tgt = room.config?.slots || { P: 0, D: 0, C: 0, A: 0 };
  const have = countByRole(team.acquisitions);
  return {
    P: Math.max(0, (tgt.P || 0) - (have.P || 0)),
    D: Math.max(0, (tgt.D || 0) - (have.D || 0)),
    C: Math.max(0, (tgt.C || 0) - (have.C || 0)),
    A: Math.max(0, (tgt.A || 0) - (have.A || 0)),
  };
}

/** Determina il budget minimo ancora necessario considerando gli slot residui. */
function minBudgetStillNeeded(room, team, bidPrice) {
  const cfg = room.config || {};
  const teamAfter = (team.credits ?? 0) - (bidPrice || 0);
  const rem = remainingSlots(room, team);
  const totalSlotsMissing = rem.P + rem.D + rem.C + rem.A;
  if (totalSlotsMissing <= 0) return 0;
  const minPerSlot = Math.max(0, Number(cfg.minRemainingCreditPerSlot || 0));
  const required = minPerSlot * totalSlotsMissing;
  return required - teamAfter;
}

/** Applica i controlli di validità alle offerte effettuate dai team. */
function validateBid(room, team, proposedPrice) {
  const cfg = room.config || {};

  const credits = Number(team?.credits ?? 0);
  if (!cfg.allowOverbid && proposedPrice > credits) {
    return { ok: false, error: 'Crediti insufficienti' };
  }

  if (!cfg.enableRosterBudget) return { ok: true };

  const tgt = cfg.slots || {};
  const have = countByRole(team?.acquisitions || []);

  const totalSlotsMissing =
    Math.max(0, (tgt.P || 0) - (have.P || 0)) +
    Math.max(0, (tgt.D || 0) - (have.D || 0)) +
    Math.max(0, (tgt.C || 0) - (have.C || 0)) +
    Math.max(0, (tgt.A || 0) - (have.A || 0));

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

/** Invia ai client l'evento canonico di aggiudicazione completata. */
function emitAuctionSold(room, payload, source = 'auto') {
  if (!room || !payload) return;
  const data = {
    ...payload,
    source,
    emittedAt: Date.now(),
  };
  io.to(room.id || ROOM_ID).emit('auction:sold', data);
}

/* ================= SALE MANAGEMENT ============ */
/** Finalizza l'aggiudicazione pendente, aggiornando team e storico. */
function finalizePendingSale(room) {
  if (!room) return { ok: false, error: 'Room non trovata' };
  if (room.phase !== 'SOLD') return { ok: false, code: 'NOOP', error: 'Nessuna aggiudicazione' };

  const cfg = room.config || {};
  const last = room.history[room.history.length - 1];
  if (!last) return { ok: false, code: 'NOOP', error: 'Nessuna aggiudicazione' };
  if (last.finalized) return { ok: false, code: 'NOOP', error: 'Già finalizzato' };

  const tid = last.teamId || room.leader;
  if (!tid) return { ok: false, error: 'Team non trovato' };

  const team = room.teams.get(tid);
  if (!team) return { ok: false, error: 'Team non trovato', teamId: tid };

  const price = Number(last.price || 0) || 0;
  if (team.credits < price) return { ok: false, error: 'Crediti insufficienti', teamId: team.id };

  let warn;
  if (cfg.enableRosterBudget) {
    const debt = minBudgetStillNeeded(room, team, price);
    if (cfg.strictRules && debt > 0) {
      return { ok: false, error: 'Regola rosa violata', teamId: team.id };
    }
    if (debt > 0) {
      warn = 'Regola rosa violata (soft)';
    }
  }

  const playerName = last.playerName && String(last.playerName).trim() ? last.playerName : '(??)';
  const role = last.role || '';
  const playerTeam = last.playerTeam || '';
  const playerFm = last.playerFm ?? null;

  last.playerName = playerName;
  last.role = role;
  last.playerTeam = playerTeam;
  last.playerFm = playerFm;
  last.playerId = last.playerId || playerKey({ name: playerName, role, team: playerTeam, fm: playerFm });
  last.teamId = team.id;
  last.teamName = team.name;

  team.credits -= price;
  if (!Array.isArray(team.acquisitions)) team.acquisitions = [];
  team.acquisitions.push({ player: playerName, role, price, at: Date.now() });

  removeFromMasterBySnapshot(room, last);

  last.finalized = true;
  last.finalizedAt = Date.now();

  transitionPhase(room, 'ROLLING');

  const sale = {
    historyId: last.id,
    teamId: team.id,
    teamName: team.name,
    price,
    playerName,
    role,
    playerTeam,
    playerFm,
    playerId: last.playerId,
    at: last.finalizedAt,
  };


  const result = { ok: true, teamId: team.id, price, sale };

  try {
    const snap = serialize(room);
    writeBackupFile(snap);
  } catch (err) {
    console.error('[finalizePendingSale] Errore durante la scrittura del backup:', err);
  }

  return result;
}

/** Rimuove dal listone il giocatore indicato dallo snapshot di storico. */
function removeFromMasterBySnapshot(room, h) {
  if (!room || !h) return;

  const name = String(h.playerName || '').trim().toLowerCase();
  const role = String(h.role || '').trim();
  const team = String(h.playerTeam || '').trim().toLowerCase();
  const fm = h.playerFm ?? null;
  const historyKey = h.playerId || playerKey({ name: h.playerName, role: h.role, team: h.playerTeam, fm: h.playerFm });

  if (!name || !role) return;

  const idx = room.players.findIndex((p) => {
    if (!p) return false;

    if (historyKey && playerKey(p) === historyKey) return true;

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

/** Memorizza l'errore verificatosi durante l'assegnazione automatica. */
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

/** Pianifica la finalizzazione automatica fuori dal loop del socket. */
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

    if (result.sale) emitAuctionSold(room, result.sale, 'auto');
  });
}

/* ================= BOOTSTRAP ================== */
try {
  const snap = loadRoomSnapshot(ROOM_ID);
  if (snap) hydrate(rooms.get(ROOM_ID), snap);
} catch {
  /* silent restore failure */
}

/* ================= IMPORT API ================= */
// Body: { csv: "<testo csv>", map: { name: 'name', role: 'role' } }
app.post('/api/listone/import', importRateLimit, requireHostAuth, (req, res) => {
  try{
    const room = req.room || rooms.get(ROOM_ID);
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
    persistRoom(room);
    broadcast(room);
    return res.json({ ok:true, imported, rejected, header });
  } catch(e){
    return res.status(500).json({ ok:false, error: e?.message || 'Errore import' });
  }
});


/* ================= EXPORT API ================= */
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
/* ================= COUNTDOWN LOOP ============== */
setInterval(() => {
  const room = rooms.get(ROOM_ID);
  if (!room) return;
  const t = now();
  if (room.deadline && t >= room.deadline){
    if (room.phase === 'ARMED'){
      setCountdown(room);
    } else if (room.phase === 'COUNTDOWN'){
      if (room.countdownSec > 1){
        room.countdownSec -= 1; room.deadline = now() + 1000; broadcast(room);
      } else {
        if (room.leader){
          // crea entry pending, verrà completata in winner:autoAssign
          mkHistoryPending(room);
        }
        transitionPhase(room, 'SOLD');
        if (room.leader){
          const pendingSnap = serialize(room);
          // >>> BACKUP TIMESTAMPED QUI <<<
          try {
            const pendingSnap = serialize(room);
            writeBackupFile(pendingSnap);
          } catch {}
          scheduleAutoFinalize(room);
        }
      }
    }
  }
}, 150);


/* ================= ROLLING LOOP ================= */
setInterval(() => {
  const room = rooms.get(ROOM_ID);
  if (!room) return;

  if (!room.__rollTickAt) room.__rollTickAt = now();

  if (room.rolling && room.phase === 'ROLLING' && room.viewPlayers.length > 0) {
    const ms = Math.max(300, Math.min(5000, Number(room.rollMs || 2000)));
    const t = now();
    if (t - room.__rollTickAt >= ms) {
      room.__rollTickAt = t;
      room.currentIndex = (room.currentIndex + 1) % room.viewPlayers.length;
      broadcast(room);
    }
  } else {
    room.__rollTickAt = now();
  }
}, 120);

const FILTER_LOCKED_PHASES = ['RUNNING', 'ARMED', 'COUNTDOWN'];
const FILTER_LOCKED_ERROR = 'Puoi cambiare filtri solo quando l’asta è ferma o dopo l’assegnazione.';

/* ================= SOCKET HANDLERS ============ */
io.on('connection', (socket) => {
  const room = rooms.get(ROOM_ID);
  const auth = socket.handshake?.auth || {};
  const claimedClientId = typeof auth.clientId === 'string' && auth.clientId ? auth.clientId : null;
  const claimedHostToken = typeof auth.hostToken === 'string' && auth.hostToken ? auth.hostToken : null;

  socket.data = socket.data || {};
  socket.data.clientId = claimedClientId || socket.data.clientId || null;

  if (!socket.data.clientId) {
    const generatedId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    socket.data.clientId = generatedId;
    socket.emit('session:clientId', { clientId: generatedId });
  }

  const liveSockets = io.of('/').sockets;
  if (room.hostOwner && !liveSockets.has(room.hostOwner)) {
    room.hostOwner = null;
  }

  let hostRecovered = false;
  const canRecoverHost =
    !room.hostOwner &&
    room.hostOwnerClientId &&
    socket.data.clientId &&
    room.hostOwnerClientId === socket.data.clientId &&
    room.hostToken &&
    claimedHostToken &&
    claimedHostToken === room.hostToken;

  if (canRecoverHost) {
    room.hostOwner = socket.id;
    if (socket.data?.clientId) room.hostOwnerClientId = socket.data.clientId;
    hostRecovered = true;
  }

  socket.join(ROOM_ID);
  socket.emit('state', snapshot(room, null, socket.id));
  if (hostRecovered) broadcast(room);

  /* ================= TEAM SESSION ============== */
  // Gestisce registrazione e ripresa delle squadre
  socket.on('team:register', ({ name, credits }, cb) => {
    try {
      if (!name) return cb && cb({ error: 'Nome squadra obbligatorio' });
      const base = slugifyName(name);
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
        key: makeKey(),
        sessionEpoch: room.sessionEpoch || 1,
      };
      room.teams.set(tid, team);
      socket.data.teamId = tid;
      socket.data.displayName = team.name;
      persistRoom(room);
      broadcast(room);
      cb && cb({ ok: true, teamId: tid, key: team.key });
    } catch (e) {
      cb && cb({ error: e?.message || 'Errore registrazione' });
    }
  });

  socket.on('team:resume', ({ teamId, key }, cb) => {
    try {
      if (!teamId || !key) return cb && cb({ error: 'Dati mancanti' });
      const team = room.teams.get(teamId);
      if (!team) return cb && cb({ error: 'Team non trovato' });
      const currentEpoch = room.sessionEpoch || 1;
      const teamEpoch = team.sessionEpoch || 1;
      if (teamEpoch !== currentEpoch) {
        return cb && cb({ error: 'Sessione scaduta' });
      }
      if (team.key && key !== team.key) return cb && cb({ error: 'Token non valido' });

      const prevSocketId = team.socketId;
      if (prevSocketId && prevSocketId !== socket.id) {
        const prevSocket = io.of('/').sockets.get(prevSocketId);
        if (prevSocket) {
          prevSocket.emit('session:revoked');
          try {
            prevSocket.disconnect(true);
          } catch (_) {}
        }
      }

      socket.data.teamId = team.id;
      socket.data.displayName = team.name;
      team.socketId = socket.id;
      team.key = makeKey();
      team.sessionEpoch = currentEpoch;

      persistRoom(room);
      broadcast(room);
      cb && cb({ ok: true, teamId: team.id, name: team.name, credits: team.credits, key: team.key });
    } catch (e) {
      cb && cb({ error: e?.message || 'Errore resume' });
    }
  });

  /* ================= HOST SESSION ============== */
  // Consente di acquisire o rilasciare il ruolo di banditore
  socket.on('host:toggle', ({ pin } = {}, cb) => {
    if (room.hostOwner && !io.of('/').sockets.has(room.hostOwner)) {
      room.hostOwner = null;
    }
    if (room.hostOwner && room.hostOwner !== socket.id) {
      return cb && cb({ error: 'Banditore già assegnato' });
    }
    if (!room.hostOwner) {
      if (HOST_PIN && pin !== HOST_PIN) return cb && cb({ error: 'PIN mancante o errato' });
      room.hostOwner = socket.id;
      if (socket.data?.clientId) room.hostOwnerClientId = socket.data.clientId;
      if (room.phase === 'LOBBY') transitionPhase(room, 'ROLLING');
      const token = issueHostToken(room);
      const wasLobby = room.phase === 'LOBBY';
      if (wasLobby) {
        transitionPhase(room, 'ROLLING');
      } else {
        persistRoom(room);
        broadcast(room);
      }
      return cb && cb({ ok: true, host: true, hostToken: token });
    } else if (room.hostOwner === socket.id) {
      room.hostOwner = null;
      room.hostOwnerClientId = null;
      room.hostToken = null;
      persistRoom(room);
      broadcast(room);
      return cb && cb({ ok: true, host: false });
    }
  });

  socket.on('host:reclaim', ({ token }, cb) => {
    if (!token || token !== room.hostToken) return cb && cb({ error: 'Token host non valido' });
    room.hostOwner = socket.id;
    room.hostOwnerClientId = socket.data?.clientId ?? null;
    persistRoom(room);
    broadcast(room);
    cb && cb({ ok: true });
  });

  /* ================= HOST FILTERS ============== */
  // Gestione filtri e selezione casuale del listone
  socket.on('host:setFilterName', ({ q }, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    if (FILTER_LOCKED_PHASES.includes(room.phase)) {
      return cb && cb({ error: FILTER_LOCKED_ERROR });
    }
    room.filterName = String(q || '');
    rebuildView(room);
    persistRoom(room);
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on('host:setRoleFilter', ({ role }, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    if (FILTER_LOCKED_PHASES.includes(room.phase)) {
      return cb && cb({ error: FILTER_LOCKED_ERROR });
    }
    const allowed = ['ALL', 'P', 'D', 'C', 'A'];
    const r = (role || 'ALL').toUpperCase();
    if (!allowed.includes(r)) return cb && cb({ error: 'Ruolo non valido' });
    room.filterRole = r;
    rebuildView(room);
    if (room.viewPlayers.length === 0) {
      room.rolling = false;
    }
    persistRoom(room);
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
    persistRoom(room);
    broadcast(room);
    cb && cb({ ok: true, letter: usedStart || pick });
  });

  /* ================= ROLL CONTROL ============== */
  // Controlla il rullo automatico e la velocità di scorrimento
  socket.on('host:toggleRoll', (_, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    if (['RUNNING', 'ARMED', 'COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Ferma l’asta prima' });
    if (!room.viewPlayers.length) return cb && cb({ error: 'Nessun giocatore da scorrere' });

    room.rolling = !room.rolling;
    if (room.rolling) {
      room.__rollTickAt = now();
      transitionPhase(room, 'ROLLING');
    }
    persistRoom(room);
    broadcast(room);
    cb && cb({ ok: true, rolling: room.rolling });
  });

  socket.on('host:stopRoll', (_, cb) => {
    const currentRoom = rooms.get(ROOM_ID);
    if (currentRoom.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    currentRoom.rolling = false;
    if (currentRoom.phase === 'ROLLING') transitionPhase(currentRoom, 'ROLLING');
    persistRoom(currentRoom);
    broadcast(currentRoom);
    cb && cb({ ok: true });
  });

  socket.on('host:setRollMs', ({ ms }, cb) => {
    const currentRoom = rooms.get(ROOM_ID);
    if (!currentRoom) return cb && cb({ error: 'Room non trovata' });
    if (currentRoom.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    const v = Math.floor(Number(ms || 0));
    if (!Number.isFinite(v) || v < 300 || v > 5000) return cb && cb({ error: 'Valore non valido (300–5000 ms)' });
    currentRoom.rollMs = v;
    persistRoom(currentRoom);
    currentRoom.__rollTickAt = now();
    broadcast(currentRoom);
    cb && cb({ ok: true, rollMs: v });
  });

  /* ================= BIDDING =================== */
  // Gestisce offerte incrementali e libere
  function ensureAuctionStartedByBid() {
    if (room.phase === 'ROLLING') {
      transitionPhase(room, 'RUNNING');
    }
  }

  const lastBidBySocket = new Map();
  function hitSpam(socketId) {
    const t = now();
    const last = lastBidBySocket.get(socketId) || 0;
    if (t - last < 120) return true;
    lastBidBySocket.set(socketId, t);
    return false;
  }

  socket.on('team:bid_inc', ({ amount }, cb) => {
    const tid = socket.data.teamId;
    if (!tid) return cb && cb({ error: 'Registrati prima' });
    if (!['ROLLING', 'RUNNING', 'ARMED', 'COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Asta non in corso' });
    if (room.leader === tid && room.phase !== 'ROLLING') return cb && cb({ error: 'Sei già in testa' });

    const inc = Math.floor(Number(amount || 0));
    if (inc <= 0) return cb && cb({ error: 'Importo non valido' });
    if (hitSpam(socket.id)) return cb && cb({ ok: true });

    const team = room.teams.get(tid);
    if (!team) return cb && cb({ error: 'Team non trovato' });

    const proposed = room.topBid + inc;
    const v = validateBid(room, team, proposed);
    if (!v.ok) return cb && cb({ error: v.error });

    ensureAuctionStartedByBid();

    const nowTs = now();
    const last = room.lastBuzzBy[tid] || 0;
    if (nowTs - last < 80) return cb && cb({ ok: true });

    room.lastBuzzBy[tid] = nowTs;
    room.topBid = proposed;
    room.leader = tid;
    setArmed(room);
    cb && cb({ ok: true, topBid: room.topBid, warn: v.warn });
  });

  socket.on('team:bid_free', ({ value }, cb) => {
    const tid = socket.data.teamId;
    if (!tid) return cb && cb({ error: 'Registrati prima' });
    if (!['ROLLING', 'RUNNING', 'ARMED', 'COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Asta non in corso' });
    if (room.leader === tid && room.phase !== 'ROLLING') return cb && cb({ error: 'Sei già in testa' });

    const val = Math.floor(Number(value || 0));
    if (!Number.isFinite(val) || val <= room.topBid) return cb && cb({ error: 'Offerta troppo bassa' });
    if (hitSpam(socket.id)) return cb && cb({ ok: true });

    const team = room.teams.get(tid);
    if (!team) return cb && cb({ error: 'Team non trovato' });

    const v = validateBid(room, team, val);
    if (!v.ok) return cb && cb({ error: v.error });

    ensureAuctionStartedByBid();

    room.topBid = val;
    room.leader = tid;
    setArmed(room);
    cb && cb({ ok: true, topBid: room.topBid, warn: v.warn });
  });

  /* ================= ASSIGNMENTS =============== */
  // Gestisce auto assegnazioni e ripristini storico
  socket.on('winner:autoAssign', (_, cb) => {
    const currentRoom = rooms.get(ROOM_ID);
    const result = finalizePendingSale(currentRoom);
    if (!result.ok) {
      if (currentRoom.phase === 'SOLD' && result.code !== 'NOOP') {
        recordAutoAssignError(currentRoom, result, 'manual');
        broadcast(currentRoom);
      }
      return cb && cb({ error: result.error });
    }
    if (result.sale) emitAuctionSold(currentRoom, result.sale, 'finalize');
    cb && cb({ ok: true, warn: result.warn });
  });

  socket.on('host:assignPlayer', ({ playerId, teamId, price }, cb) => {
    const currentRoom = rooms.get(ROOM_ID);
    if (currentRoom.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });

    if (!playerId || typeof playerId !== 'string') {
      return cb && cb({ error: 'Giocatore non valido' });
    }

    if (!teamId || !currentRoom.teams.has(teamId)) {
      return cb && cb({ error: 'Team non trovato' });
    }

    const phaseBlocked = ['RUNNING', 'ARMED', 'COUNTDOWN', 'SOLD'];
    if (phaseBlocked.includes(currentRoom.phase)) {
      return cb && cb({ error: 'Completa o interrompi l’asta prima di assegnare manualmente' });
    }

    const normalizedId = playerId.trim();
    const playerIndex = currentRoom.players.findIndex((p) => normalizedId && playerKey(p) === normalizedId);
    if (playerIndex < 0) {
      return cb && cb({ error: 'Giocatore non presente nel listone' });
    }

    const player = currentRoom.players[playerIndex];
    const team = currentRoom.teams.get(teamId);

    const priceValue = Number(price);
    if (!Number.isFinite(priceValue) || priceValue < 0) {
      return cb && cb({ error: 'Prezzo non valido' });
    }

    const prevPhase = currentRoom.phase;
    const prevLeader = currentRoom.leader;
    const prevTopBid = currentRoom.topBid;
    const prevDeadline = currentRoom.deadline;
    const prevCountdown = currentRoom.countdownSec;
    const prevRolling = currentRoom.rolling;

    const entry = {
      id:
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : crypto.randomBytes(8).toString('hex'),
      at: Date.now(),
      sessionEpoch: currentRoom.sessionEpoch || 1,
      teamId: team.id,
      teamName: team.name,
      price: priceValue,
      playerName: player.name || '',
      role: player.role || '',
      playerTeam: player.team || '',
      playerFm: player.fm ?? null,
      playerId: playerKey(player),
    };

    currentRoom.history.push(entry);
    currentRoom.leader = team.id;
    currentRoom.topBid = priceValue;
    currentRoom.phase = 'SOLD';
    currentRoom.deadline = 0;
    currentRoom.countdownSec = 0;
    currentRoom.rolling = false;

    let result;
    try {
      result = finalizePendingSale(currentRoom);
    } catch (err) {
      result = { ok: false, error: err?.message || 'Errore assegnazione' };
    }

    if (!result?.ok) {
      currentRoom.history.pop();
      currentRoom.phase = prevPhase;
      currentRoom.leader = prevLeader;
      currentRoom.topBid = prevTopBid;
      currentRoom.deadline = prevDeadline;
      currentRoom.countdownSec = prevCountdown;
      currentRoom.rolling = prevRolling;
      return cb && cb({ error: result?.error || 'Errore assegnazione' });
    }

    if (result.sale) emitAuctionSold(currentRoom, result.sale, 'manual');
    cb && cb({ ok: true, warn: result.warn });
  });

  socket.on('host:undoPurchase', ({ historyId }, cb) => {
    const currentRoom = rooms.get(ROOM_ID);
    if (currentRoom.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    if (['RUNNING', 'ARMED', 'COUNTDOWN'].includes(currentRoom.phase)) return cb && cb({ error: 'Non puoi fare UNDO durante l’asta' });

    const idx = currentRoom.history.findIndex((h) => h.id === historyId);
    if (idx < 0) return cb && cb({ error: 'Voce storico non trovata' });

    const h = currentRoom.history[idx];
    if (!h.playerName || !h.role || !h.teamId) return cb && cb({ error: 'Voce incompleta' });

    const team = currentRoom.teams.get(h.teamId);
    if (team) team.credits += h.price || 0;

    if (team && Array.isArray(team.acquisitions)) {
      const pos = team.acquisitions.findIndex((a) => a.player === h.playerName && a.role === h.role && a.price === h.price);
      if (pos >= 0) team.acquisitions.splice(pos, 1);
    }

    addBackToMaster(currentRoom, { name: h.playerName, role: h.role, team: h.playerTeam, fm: h.playerFm });

    currentRoom.history.splice(idx, 1);

    if (!['RUNNING', 'ARMED', 'COUNTDOWN'].includes(currentRoom.phase)) {
      currentRoom.topBid = 0;
      currentRoom.leader = null;
    }

    persistRoom(currentRoom);
    try {
      const snap = serialize(currentRoom);
      writeBackupFile(snap);
    } catch (err) {
      console.error('[host:undoPurchase] Errore durante la scrittura del backup:', err);
    }
    broadcast(currentRoom);
    cb && cb({ ok: true });
  });

  /* ================= PARTICIPANT MGMT ========== */
  // Kick, uscita e aggiornamento profilo squadre
  socket.on('host:kick', ({ teamId }, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    if (['RUNNING', 'ARMED', 'COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Non puoi rimuovere durante l’asta' });
    if (!teamId || !room.teams.has(teamId)) return cb && cb({ error: 'Team inesistente' });

    const target = room.teams.get(teamId);
    if (target?.socketId) io.to(target.socketId).emit('you:kicked', { reason: 'Rimosso dal banditore' });

    if (target && Array.isArray(target.acquisitions)) {
      for (const a of target.acquisitions) addBackToMaster(room, { name: a.player, role: a.role });
      target.acquisitions = [];
    }

    if (room.leader === teamId) {
      room.leader = null;
      room.topBid = 0;
    }

    room.teams.delete(teamId);

    persistRoom(room);
    broadcast(room);
    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    if (room.hostOwner === socket.id) {
      room.hostOwner = null;
      broadcast(room);
    }
  });

  socket.on('team:leave', (_, cb) => {
    try {
      const tid = socket.data.teamId;
      if (!tid) return cb && cb({ error: 'Nessuna sessione attiva' });
      if (['RUNNING', 'ARMED', 'COUNTDOWN'].includes(room.phase)) {
        return cb && cb({ error: 'Non puoi uscire durante un’asta in corso' });
      }

      if (room.leader === tid) {
        room.leader = null;
        room.topBid = 0;
      }

      if (room.hostOwner === socket.id) {
        room.hostOwner = null;
        room.hostOwnerClientId = null;
        room.hostToken = null;
      }

      room.teams.delete(tid);
      socket.data.teamId = null;
      socket.data.displayName = null;

      persistRoom(room);
      broadcast(room);
      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ error: e?.message || 'Errore uscita' });
    }
  });

  socket.on('team:updateProfile', ({ name, credits }, cb) => {
    try {
      const tid = socket.data.teamId;
      if (!tid) return cb && cb({ error: 'Nessuna sessione attiva' });
      const team = room.teams.get(tid);
      if (!team) return cb && cb({ error: 'Team non trovato' });

      if (typeof name === 'string' && name.trim()) {
        const base = slugifyName(name);
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

      persistRoom(room);
      broadcast(room);
      cb && cb({ ok: true, team: { id: team.id, name: team.name, credits: team.credits } });
    } catch (e) {
      cb && cb({ error: e?.message || 'Errore aggiornamento profilo' });
    }
  });

  /* ================= HOST ACTIONS ============== */
  // Reset asta e navigazione del listone
  socket.on('host:exitAndClose', (_, cb) => {
    const currentRoom = rooms.get(ROOM_ID);
    if (!currentRoom) return cb && cb({ error: 'Room inesistente' });
    if (currentRoom.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });

    currentRoom.sessionEpoch = (currentRoom.sessionEpoch || 1) + 1;
    currentRoom.teams = new Map();
    currentRoom.history = [];

    currentRoom.hostOwner = null;
    currentRoom.hostOwnerClientId = null;
    currentRoom.hostToken = null;
    currentRoom.currentIndex = 0;
    transitionPhase(currentRoom, 'LOBBY');

    cb && cb({ ok: true });
  });

  socket.on('host:skip', (_, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    if (!room.viewPlayers.length) return cb && cb({ error: 'Lista vuota' });
    if (['RUNNING', 'ARMED', 'COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Ferma l’asta prima' });
    room.currentIndex = (room.currentIndex + 1) % room.viewPlayers.length;
    persistRoom(room);
    broadcast(room);
    cb && cb({ ok: true, index: room.currentIndex });
  });

  socket.on('host:backN', ({ n }, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    if (!room.viewPlayers.length) return cb && cb({ error: 'Lista vuota' });
    if (['RUNNING', 'ARMED', 'COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Ferma l’asta prima' });
    const parsed = Math.floor(Number(n));
    if (!Number.isFinite(parsed)) return cb && cb({ error: 'Valore non valido' });
    const k = Math.max(1, Math.min(10, parsed));
    if (parsed !== k) return cb && cb({ error: 'Puoi tornare indietro da 1 a 10 giocatori' });
    const len = room.viewPlayers.length;
    room.currentIndex = ((room.currentIndex - (k % len)) + len) % len;
    persistRoom(room);
    broadcast(room);
    cb && cb({ ok: true, index: room.currentIndex, applied: k });
  });

  socket.on('host:pinPlayer', ({ index }, cb) => {
    if (room.hostOwner !== socket.id) return cb && cb({ error: 'Non sei il banditore' });
    const i = Math.floor(Number(index));
    if (!Number.isFinite(i) || i < 0 || i >= room.viewPlayers.length) return cb && cb({ error: 'Indice non valido' });
    if (['RUNNING', 'ARMED', 'COUNTDOWN'].includes(room.phase)) return cb && cb({ error: 'Ferma l’asta prima' });
    room.currentIndex = i;
    persistRoom(room);
    broadcast(room);
    cb && cb({ ok: true });
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log(`FantaBid server on: http://localhost:${PORT}`);
  if (ips.length) {
    console.log('LAN access:', ips.map((ip) => `http://${ip}:${PORT}`).join('  '));
  }
});
