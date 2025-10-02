/* ================= STATE MANAGEMENT =========== */
// Stato stanza unica + gestione listone + filtraggio/ordinamento + rimozione/ripristino venduti

export const rooms = new Map();

/* ================= UTILITIES =================== */
/** Genera un identificativo pseudo-univoco per voci di storico. */
function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Genera una chiave deterministica per identificare univocamente un giocatore
 * a partire dagli attributi principali (nome, ruolo, squadra, fm).
 */
export function playerKey(player) {
  if (!player) return null;

  const rawName =
    player.name ?? player.playerName ?? player.player_name ?? player.nome ?? '';
  const rawRole = player.role ?? player.ruolo ?? player.roleCode ?? '';
  const rawTeam =
    player.team ?? player.squadra ?? player.playerTeam ?? player.teamName ?? '';
  const rawFm =
    player.fm ?? player.playerFm ?? player.fantamedia ?? player.fmValue ?? null;

  const name = String(rawName || '').trim().toLowerCase();
  const role = String(rawRole || '').trim().toUpperCase();
  if (!name || !role) return null;

  const team = String(rawTeam || '').trim().toLowerCase();
  const fmNumber = Number.parseFloat(rawFm);
  const fm = Number.isFinite(fmNumber) ? fmNumber : null;

  const fmPart = fm === null ? '' : fm.toString();
  return `${name}#${role}#${team}#${fmPart}`;
}

/* ================= ROOM FACTORY ================ */
/** Crea (o recupera) una stanza d'asta inizializzata con i valori di default. */
export function makeRoom(id) {
  if (rooms.has(id)) return rooms.get(id);

  const r = {
    id,
    createdAt: Date.now(),
    version: 0,
    sessionEpoch: 1,

    hostOwner: null,
    hostOwnerClientId: null,
    hostToken: null,
    teams: new Map(),

    phase: 'LOBBY',
    topBid: 0,
    leader: null,
    deadline: 0,
    countdownSec: 0,
    armMs: 2000,
    rollMs: 1000,
    lastBuzzBy: {},

    history: [],

    players: [],

    filterRole: 'ALL',
    viewPlayers: [],
    currentIndex: 0,
    rolling: false,
    filterName: '',
    autoAssignError: null,
    __lastSnapshotVersion: 0,
  };

  rebuildView(r);
  rooms.set(id, r);
  return r;
}

/* ================= PLAYER VIEW ================= */
/** Ricostruisce la vista dei giocatori applicando filtri e ordinamenti. */
export function rebuildView(room, startLetter /* opzionale: 'A'..'Z' */) {
  const src = room.players.slice();

  const nameQ = (room.filterName || '').trim().toUpperCase();
  let list = room.filterRole === 'ALL' ? src : src.filter((p) => p.role === room.filterRole);
  if (nameQ) list = list.filter((p) => p.name.toUpperCase().includes(nameQ));

  list.sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
  room.viewPlayers = list;

  if (room.viewPlayers.length === 0) {
    room.currentIndex = 0;
    return { usedStart: null };
  }
  if (!startLetter || !/^[A-ZÀ-Ü]$/.test(startLetter)) {
    room.currentIndex = Math.min(room.currentIndex, room.viewPlayers.length - 1) || 0;
    return { usedStart: null };
  }

  const nextLetter = (ch) => {
    const code = ch.charCodeAt(0);
    return code >= 65 && code <= 90 ? String.fromCharCode(code === 90 ? 65 : code + 1) : 'A';
  };

  let attempts = 0;
  let L = startLetter.toUpperCase();
  let idx = -1;

  while (attempts < 26) {
    idx = room.viewPlayers.findIndex((p) => p.name.toUpperCase().startsWith(L));
    if (idx >= 0) break;
    L = nextLetter(L);
    attempts += 1;
  }

  room.currentIndex = idx >= 0 ? idx : 0;
  return { usedStart: idx >= 0 ? L : null };
}

/* ================= MASTER LIST OPS ============ */
/** Rimuove dal listone il giocatore appena aggiudicato. */
export function removeCurrentFromMaster(room) {
  const last = room.history[room.history.length - 1];
  if (!last) return;

  const targetName = last.playerName || '';
  const targetRole = last.role || '';
  if (!targetName || !targetRole) return;

  const idx = room.players.findIndex((p) => {
    if (!p) return false;
    if (p.name !== targetName || p.role !== targetRole) return false;

    if (last.playerTeam && (p.team || '') !== last.playerTeam) return false;

    if (last.playerFm != null && last.playerFm !== '') {
      if (p.fm != null && p.fm !== '') return String(p.fm) === String(last.playerFm);
      return true;
    }

    return true;
  });

  if (idx >= 0) {
    room.players.splice(idx, 1);
    rebuildView(room);
  }
}

/** Reinserisce nel listone un giocatore rimosso in precedenza. */
export function addBackToMaster(room, player) {
  if (!player || !player.name || !player.role) {
    rebuildView(room);
    return;
  }

  const normName = String(player.name).trim();
  const normRole = String(player.role).trim();
  const normTeam = player.team != null ? String(player.team).trim() : '';
  const hasTeam = normTeam !== '';
  const hasFm = player.fm != null && player.fm !== '';

  let idx = -1;
  if (hasTeam && hasFm) {
    idx = room.players.findIndex((p) => {
      if (!p) return false;
      if ((p.name || '').trim() !== normName) return false;
      if ((p.role || '').trim() !== normRole) return false;
      if ((p.team || '').trim() !== normTeam) return false;
      if (p.fm == null || p.fm === '') return false;
      return Number(p.fm) === Number(player.fm);
    });
    if (idx < 0) {
      idx = room.players.findIndex(
        (p) => p && (p.name || '').trim() === normName && (p.role || '').trim() === normRole,
      );
    }
  } else {
    idx = room.players.findIndex(
      (p) => p && (p.name || '').trim() === normName && (p.role || '').trim() === normRole,
    );
  }

  if (idx >= 0) {
    const target = room.players[idx];
    if (hasTeam) target.team = normTeam;
    if (hasFm) target.fm = player.fm;
  } else {
    room.players.push({
      name: normName,
      role: normRole,
      team: normTeam,
      fm: hasFm ? player.fm : player.fm ?? null,
    });
  }

  rebuildView(room);
}

/* ================= SNAPSHOTS =================== */
/** Compone lo snapshot condiviso con i client, filtrato per team. */
export function snapshot(room, perspectiveTeamId = null, socketId = null) {
  const you = perspectiveTeamId || null;
  const youState = you ? (room.leader === you ? 'LEADING' : 'OUTBID') : null;
  const youCredits = you ? room.teams.get(you)?.credits ?? null : null;
  const acquisitions = you ? room.teams.get(you)?.acquisitions ?? [] : [];

  const currentEpoch = room.sessionEpoch || 1;
  const recent = room.history.filter((h) => (h.sessionEpoch || 1) === currentEpoch).slice(-12);

  const n = room.viewPlayers.length;
  const cur = n ? room.viewPlayers[room.currentIndex] : null;
  const prev = n ? room.viewPlayers[(room.currentIndex - 1 + n) % n] : null;
  const next = n ? room.viewPlayers[(room.currentIndex + 1) % n] : null;

  const withId = (player) =>
    player
      ? {
          ...player,
          playerId: playerKey(player),
        }
      : null;

  return {
    id: room.id,
    sessionEpoch: currentEpoch,

    phase: room.phase,
    hostLockedBy: room.hostOwner,
    autoAssignError: room.autoAssignError || null,

    topBid: room.topBid,
    leader: room.leader,
    leaderName: room.leader ? room.teams.get(room.leader)?.name || '—' : null,

    timeMs: Math.max(0, room.deadline - Date.now()),
    countdownSec: room.phase === 'COUNTDOWN' ? Math.max(0, room.countdownSec) : 0,
    rollMs: room.rollMs,

    participants: Array.from(room.teams.values()).map((t) => ({
      id: t.id,
      name: t.name,
      credits: t.credits,
    })),

    recentAssignments: recent,
    you,
    youState,
    youCredits,
    acquisitions,
    youAreHost: socketId ? room.hostOwner === socketId : false,

    filterRole: room.filterRole,
    rolling: room.rolling,

    currentPlayer: withId(cur),
    prevPlayer: withId(prev),
    nextPlayer: withId(next),
  };
}

/** Aggiunge allo storico l'aggiudicazione in stato "pending". */
export function mkHistoryPending(room) {
  if (!room.leader) return null;
  const team = room.teams.get(room.leader);
  if (!team) return null;

  const cur = room.viewPlayers[room.currentIndex] || null;

  const entry = {
    id: uid(),
    at: Date.now(),
    sessionEpoch: room.sessionEpoch || 1,
    teamId: team.id,
    teamName: team.name,
    price: room.topBid || 0,
    playerName: cur?.name || '',
    role: cur?.role || '',
    playerTeam: cur?.team || '',
    playerFm: cur?.fm ?? null,
    playerId: cur ? playerKey(cur) : null,
  };

  room.history.push(entry);
  return entry;
}

/* ================= IDENTIFIERS ================= */
/** Normalizza il nome di un team per l'uso come ID. */
export function slugifyName(name) {
  return (
    String(name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 16) || 'TEAM'
  );
}

/** Genera un teamId univoco partendo dallo slug base. */
export function uniqueTeamId(room, base) {
  let id = base;
  let i = 2;
  while (room.teams.has(id)) id = `${base}-${i++}`;
  return id;
}

/* ================= SERIALIZATION =============== */
/** Converte lo stato della stanza in un oggetto serializzabile. */
export function serialize(room) {
  return {
    id: room.id,
    createdAt: room.createdAt,
    version: room.version || 0,

    sessionEpoch: room.sessionEpoch || 1,

    hostOwner: null,

    teams: [...room.teams.values()].map((t) => ({
      id: t.id,
      name: t.name,
      credits: t.credits,
      acquisitions: t.acquisitions || [],
      key: t.key || null,
      sessionEpoch: t.sessionEpoch || room.sessionEpoch || 1,
    })),

    phase: room.phase,
    topBid: room.topBid,
    leader: room.leader,

    history: room.history,

    players: room.players,

    filterRole: room.filterRole,
    currentIndex: room.currentIndex,
    armMs: room.armMs,
    rollMs: room.rollMs,
  };
}

/** Ricostruisce lo stato della stanza a partire da uno snapshot serializzato. */
export function hydrate(room, snap) {
  room.id = snap.id;
  room.createdAt = snap.createdAt || Date.now();
  room.version = snap.version || 0;

  room.sessionEpoch = snap.sessionEpoch || 1;

  room.phase = snap.phase || 'LOBBY';
  room.topBid = snap.topBid || 0;
  room.leader = snap.leader || null;

  room.history = Array.isArray(snap.history) ? snap.history : [];
  room.players = Array.isArray(snap.players) ? snap.players : [];

  room.filterRole = snap.filterRole || 'ALL';
  room.currentIndex = snap.currentIndex || 0;
  room.armMs = snap.armMs || 2000;
  room.rollMs = snap.rollMs || 1000;

  // Team
  room.teams = new Map();
  for (const t of snap.teams || []) {
    room.teams.set(t.id, {
      id: t.id,
      name: t.name,
      credits: t.credits,
      acquisitions: t.acquisitions || [],
      key: t.key || null,
      sessionEpoch: t.sessionEpoch || room.sessionEpoch || 1,
      socketId: null
    });
  }

  // Volatili
  room.hostOwner = null;
  room.hostOwnerClientId = null;
  room.hostToken = null;
  room.deadline = 0;
  room.countdownSec = 0;
  room.rolling = false;
  room.lastBuzzBy = {};
  room.autoAssignError = null;
  room.__lastSnapshotVersion = room.version || 0;

  rebuildView(room);
}
