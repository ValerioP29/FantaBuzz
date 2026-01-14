/* ================= DEPENDENCIES ================ */
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { logger } from './logger.js';

/* ================= CONSTANTS =================== */
const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ================= PATH HELPERS ================ */
/** Restituisce il percorso del file JSON associato a una stanza. */
function roomFile(roomId) {
  return path.join(DATA_DIR, `${roomId}.json`);
}

/* ================= PERSISTENCE API ============= */
/**
 * Salva in modo atomico lo snapshot della stanza su disco.
 * Ritorna true in caso di successo, false in caso di errore.
 */
async function writeSnapshotFile(room) {
  const file = roomFile(room.id || 'DEFAULT');
  const tmp = `${file}.tmp`;
  const json = JSON.stringify(room, null, 2);

  const fd = await fs.promises.open(tmp, 'w');
  try {
    await fd.writeFile(json);
    await fd.sync();
  } finally {
    await fd.close();
  }

  await fs.promises.rename(tmp, file);
  const dirFd = await fs.promises.open(path.dirname(file), 'r');
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

const writeState = new Map();

export function saveRoomSnapshot(room) {
  if (!room) return false;
  const roomId = room.id || 'DEFAULT';
  const now = Date.now();
  const state = writeState.get(roomId) || {
    lastWriteAt: 0,
    timer: null,
    pending: null,
    writing: false,
  };

  state.pending = room;

  const elapsed = now - state.lastWriteAt;
  const delay = Math.max(0, config.persistIntervalMs - elapsed);
  if (!state.timer) {
    state.timer = setTimeout(() => flushRoomSnapshot(roomId), delay);
  }
  writeState.set(roomId, state);
  return true;
}

async function flushRoomSnapshot(roomId) {
  const state = writeState.get(roomId);
  if (!state) return;
  if (state.writing) {
    state.timer = setTimeout(() => flushRoomSnapshot(roomId), config.persistIntervalMs);
    return;
  }

  const pending = state.pending;
  if (!pending) {
    state.timer = null;
    return;
  }

  state.pending = null;
  state.timer = null;
  state.writing = true;

  try {
    await writeSnapshotFile(pending);
    state.lastWriteAt = Date.now();
  } catch (error) {
    logger.error({ err: error, roomId }, 'saveRoomSnapshot error');
  } finally {
    state.writing = false;
    if (state.pending) {
      state.timer = setTimeout(() => flushRoomSnapshot(roomId), config.persistIntervalMs);
    }
  }
}

export async function flushRoomSnapshotNow(roomId) {
  const state = writeState.get(roomId);
  if (!state) return false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.writing) {
    await new Promise((resolve) => setTimeout(resolve, config.persistIntervalMs));
  }
  if (state.writing) return false;
  if (!state.pending) return false;

  const pending = state.pending;
  state.pending = null;
  state.writing = true;
  try {
    await writeSnapshotFile(pending);
    state.lastWriteAt = Date.now();
    return true;
  } catch (error) {
    logger.error({ err: error, roomId }, 'flushRoomSnapshotNow error');
    return false;
  } finally {
    state.writing = false;
  }
}

/** Carica lo snapshot di una stanza, restituendo null se non esiste o in caso di errore. */
export function loadRoomSnapshot(roomId) {
  try {
    const file = roomFile(roomId);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    logger.error({ err: e, roomId }, 'loadRoomSnapshot error');
    return null;
  }
}

/**
 * Scrive una copia di backup dello snapshot corrente con timestamp nel nome file.
 */
export async function writeBackupFile(snap) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = DATA_DIR;
  const file = path.join(dir, `DEFAULT.${stamp}.json`);
  const json = JSON.stringify(snap, null, 2);
  const fd = await fs.promises.open(file, 'w');
  try {
    await fd.writeFile(json);
    await fd.sync();
  } finally {
    await fd.close();
  }

  await pruneBackups();
}

async function pruneBackups() {
  try {
    const entries = await fs.promises.readdir(DATA_DIR);
    const backups = entries
      .filter((name) => name.startsWith('DEFAULT.') && name.endsWith('.json'))
      .sort();
    if (backups.length <= config.maxBackups) return;
    const excess = backups.length - config.maxBackups;
    const toDelete = backups.slice(0, excess);
    await Promise.all(toDelete.map((name) => fs.promises.unlink(path.join(DATA_DIR, name))));
  } catch (error) {
    logger.warn({ err: error }, 'pruneBackups failed');
  }
}
