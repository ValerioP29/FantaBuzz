/* ================= DEPENDENCIES ================ */
import fs from 'fs';
import path from 'path';

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
export function saveRoomSnapshot(room) {
  try {
    const file = roomFile(room.id || 'DEFAULT');
    const tmp = `${file}.tmp`;
    const json = JSON.stringify(room, null, 2);

    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmp, file);

    const dirFd = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
    return true;
  } catch (e) {
    console.error('saveRoomSnapshot error:', e);
    return false;
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
    console.error('loadRoomSnapshot error:', e);
    return null;
  }
}

/**
 * Scrive una copia di backup dello snapshot corrente con timestamp nel nome file.
 */
export function writeBackupFile(snap) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = DATA_DIR;
  const file = path.join(dir, `DEFAULT.${stamp}.json`);
  const json = JSON.stringify(snap, null, 2);
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

