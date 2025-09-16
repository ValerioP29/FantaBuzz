// Stato stanza unica + gestione listone + filtraggio/ordinamento + rimozione/ripristino venduti

export const rooms = new Map();

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function makeRoom(id){
  if (rooms.has(id)) return rooms.get(id);

  const r = {
    id,
    createdAt: Date.now(),
    // Sessioni d'asta: ogni volta che chiudi l'asta e resetti, incrementi sessionEpoch
    sessionEpoch: 1,

    hostOwner: null,        // socket.id banditore
    teams: new Map(),       // teamId -> { id,name,credits,acquisitions: [] }

    // Stato asta
    phase: 'LOBBY',         // LOBBY | ROLLING | RUNNING | ARMED | COUNTDOWN | SOLD
    topBid: 0,
    leader: null,           // teamId leader
    deadline: 0,
    countdownSec: 0,
    armMs: 2000,
    rollMs: 1000, // velocità rullo di default (ms tra un giocatore e il successivo)
    lastBuzzBy: {},         // teamId -> ts

    // Storico SOLO della stanza; ogni entry ora è marcata con sessionEpoch
    history: [],            // {id, at, sessionEpoch, teamId, teamName, price, playerName, role}

    // Listone: parte vuoto, si popola SOLO via import
    players: [],

    // Vista filtrata
    filterRole: 'ALL',
    viewPlayers: [],
    currentIndex: 0,
    rolling: false
  };

  rebuildView(r);
  rooms.set(id, r);
  return r;
}

export function rebuildView(room, startLetter /* opzionale: 'A'..'Z' */){
  const src = room.players.slice();
  let list = room.filterRole === 'ALL'
    ? src
    : src.filter(p => p.role === room.filterRole);

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
    idx = room.viewPlayers.findIndex(p => p.name.toUpperCase().startsWith(L));
    if (idx >= 0) break;
    L = nextLetter(L);
    attempts += 1;
  }

  room.currentIndex = idx >= 0 ? idx : 0;
  return { usedStart: idx >= 0 ? L : null };
}

export function removeCurrentFromMaster(room){
  const cp = room.viewPlayers[room.currentIndex];
  if (!cp) return;
  const idx = room.players.findIndex(p => p.name === cp.name && p.role === cp.role);
  if (idx >= 0) room.players.splice(idx, 1);
  rebuildView(room);
}

export function addBackToMaster(room, player){
  // evita doppioni
  const exists = room.players.some(p => p.name === player.name && p.role === player.role);
  if (!exists) room.players.push({ name: player.name, role: player.role, team: player.team || '', fm: player.fm });
  rebuildView(room);
}

export function snapshot(room, perspectiveTeamId = null, socketId = null){
  const you = perspectiveTeamId || null;
  const youState = you ? (room.leader === you ? 'LEADING' : 'OUTBID') : null;
  const youCredits = you ? (room.teams.get(you)?.credits ?? null) : null;
  const acquisitions = you ? (room.teams.get(you)?.acquisitions ?? []) : [];

  // Mostra solo le aggiudicazioni della sessione corrente
  const currentEpoch = room.sessionEpoch || 1;
  const recent = room.history
    .filter(h => (h.sessionEpoch || 1) === currentEpoch)
    .slice(-12);

  // prev/next per il rullo
  const n = room.viewPlayers.length;
  const cur = n ? room.viewPlayers[room.currentIndex] : null;
  const prev = n ? room.viewPlayers[(room.currentIndex - 1 + n) % n] : null;
  const next = n ? room.viewPlayers[(room.currentIndex + 1) % n] : null;

  return {
    id: room.id,
    sessionEpoch: currentEpoch,

    phase: room.phase,
    hostLockedBy: room.hostOwner,

    topBid: room.topBid,
    leader: room.leader,
    leaderName: room.leader ? (room.teams.get(room.leader)?.name || '—') : null,

    timeMs: Math.max(0, room.deadline - Date.now()),
    countdownSec: room.phase === 'COUNTDOWN' ? Math.max(0, room.countdownSec) : 0,
    rollMs: room.rollMs,

    participants: Array.from(room.teams.values()).map(t => ({
      id: t.id, name: t.name, credits: t.credits
    })),

    recentAssignments: recent,
    you, youState, youCredits, acquisitions,
    youAreHost: socketId ? room.hostOwner === socketId : false,

    filterRole: room.filterRole,
    rolling: room.rolling,

    currentPlayer: cur || null,
    prevPlayer: prev || null,
    nextPlayer: next || null
  };
}

export function mkHistoryPending(room){
  if (!room.leader) return null;
  const team = room.teams.get(room.leader);
  if (!team) return null;

  const cur = room.viewPlayers[room.currentIndex] || null;

  const entry = {
    id: uid(),
    at: Date.now(),
    sessionEpoch: room.sessionEpoch || 1,  // << marcatura sessione
    teamId: team.id,
    teamName: team.name,
    price: room.topBid || 0,
    playerName: cur?.name || '',           // subito nome/ruolo correnti
    role: cur?.role || ''
  };

  room.history.push(entry);
  return entry;
}

export function slugifyName(name){
  return String(name || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 16) || 'TEAM';
}

export function uniqueTeamId(room, base){
  let id = base, i = 2;
  while (room.teams.has(id)) id = `${base}-${i++}`;
  return id;
}

/* ===== Persistenza: serialize/hydrate ===== */
export function serialize(room){
  return {
    id: room.id,
    createdAt: room.createdAt,

    // Sessione corrente
    sessionEpoch: room.sessionEpoch || 1,

    hostOwner: null, // non persistiamo chi è host

    teams: [...room.teams.values()].map(t => ({
      id: t.id, name: t.name, credits: t.credits, acquisitions: t.acquisitions || [], key: t.key || null
    })),

    phase: room.phase,
    topBid: room.topBid,
    leader: room.leader,

    history: room.history,   // contiene sessionEpoch per ogni voce

    players: room.players,   // nasce vuoto, si popola via import

    filterRole: room.filterRole,
    currentIndex: room.currentIndex,
    armMs: room.armMs,
    rollMs: room.rollMs,
  };
}

export function hydrate(room, snap){
  room.id = snap.id;
  room.createdAt = snap.createdAt || Date.now();

  // Sessione
  room.sessionEpoch = snap.sessionEpoch || 1;

  // Stato asta
  room.phase = snap.phase || 'LOBBY';
  room.topBid = snap.topBid || 0;
  room.leader = snap.leader || null;

  // Storico e listone
  room.history = Array.isArray(snap.history) ? snap.history : [];
  room.players = Array.isArray(snap.players) ? snap.players : [];

  // Vista
  room.filterRole = snap.filterRole || 'ALL';
  room.currentIndex = snap.currentIndex || 0;
  room.armMs = snap.armMs || 2000;
  room.rollMs = snap.rollMs || 1000;

  // Team
  room.teams = new Map();
  for (const t of snap.teams || []) {
    room.teams.set(t.id, { id: t.id, name: t.name, credits: t.credits, acquisitions: t.acquisitions || [], key: t.key || null, socketId: null });
  }

  // Volatili
  room.hostOwner = null;
  room.deadline = 0;
  room.countdownSec = 0;
  room.rolling = false;
  room.lastBuzzBy = {};

  rebuildView(room);
}
