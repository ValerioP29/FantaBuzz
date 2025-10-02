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

/*
////////////////////////////////////////////////////////////////
// PERSISTENZA UTENTI REGISTRATI (COMMENTATA)
// --------------------------------------------------------------
// Il blocco sottostante implementa una semplice persistenza su
// file JSON per utenti e sessioni JWT. Scommentarlo solo dopo
// aver aggiunto le dipendenze e le route che ne fanno uso.
//
// NOTE OPERATIVE:
// - Il file `users.json` viene creato automaticamente nella
//   cartella `data` già usata per gli snapshot.
// - Attenzione: le sessioni sono tenute solo in memoria (Map);
//   ogni riavvio dell'app azzera tutte le sessioni attive.
////////////////////////////////////////////////////////////////
// const USERS_FILE = path.join(DATA_DIR, 'users.json');
// const userSessionRegistry = new Map();
//
// async function ensureUsersFile() {
//   if (fs.existsSync(USERS_FILE)) return;
//   await fs.promises.writeFile(USERS_FILE, '[]', 'utf8');
// }
//
// export async function readUsers() {
//   try {
//     await ensureUsersFile();
//     const raw = await fs.promises.readFile(USERS_FILE, 'utf8');
//     const parsed = JSON.parse(raw);
//     if (!Array.isArray(parsed)) {
//       console.warn('[readUsers] formato inatteso, resetto a []');
//       await fs.promises.writeFile(USERS_FILE, '[]', 'utf8');
//       return [];
//     }
//     return parsed;
//   } catch (err) {
//     console.error('[readUsers] errore lettura utenti:', err);
//     return [];
//   }
// }
//
// export async function writeUsers(users) {
//   try {
//     const json = JSON.stringify(users, null, 2);
//     // Nota: scrittura concorrente non protetta; meglio prevedere lock o DB.
//     await fs.promises.writeFile(USERS_FILE, json, 'utf8');
//     return true;
//   } catch (err) {
//     console.error('[writeUsers] errore salvataggio utenti:', err);
//     return false;
//   }
// }
//
// export function touchUserSession(userId, token, ttl) {
//   if (!userId || !token) return false;
//   const now = Date.now();
//   const ms = parseJwtExpiry(ttl);
//   const expiresAt = ms > 0 ? now + ms : now + 12 * 60 * 60 * 1000;
//   userSessionRegistry.set(token, { userId, expiresAt });
//   pruneSessions(now);
//   return true;
// }
//
// export function revokeUserSession(token) {
//   if (!token) return;
//   // Revoca solo la singola sessione associata a questo token. Per invalidare
//   // tutte le sessioni di un utente servirà mantenere un indice per userId.
//   userSessionRegistry.delete(token);
// }
//
// export function isSessionValid(token) {
//   if (!token) return false;
//   const data = userSessionRegistry.get(token);
//   if (!data) return false;
//   if (Date.now() > data.expiresAt) {
//     userSessionRegistry.delete(token);
//     return false;
//   }
//   return true;
// }
//
// function pruneSessions(now = Date.now()) {
//   for (const [token, data] of userSessionRegistry.entries()) {
//     if (!data || now > data.expiresAt) userSessionRegistry.delete(token);
//   }
// }
//
// function parseJwtExpiry(value) {
//   if (value == null) return 0;
//   if (typeof value === 'number' && Number.isFinite(value)) {
//     return value > 0 ? value * 1000 : 0;
//   }
//   const str = String(value).trim();
//   if (!str) return 0;
//   if (/^\d+$/.test(str)) return Number(str) * 1000;
//   const match = str.match(/^(\d+)([smhd])$/i);
//   if (!match) {
//     console.warn('[parseJwtExpiry] formato TTL non riconosciuto:', value);
//     return 0;
//   }
//   const qty = Number(match[1]);
//   const unit = match[2].toLowerCase();
//   switch (unit) {
//     case 's': return qty * 1000;
//     case 'm': return qty * 60 * 1000;
//     case 'h': return qty * 60 * 60 * 1000;
//     case 'd': return qty * 24 * 60 * 60 * 1000;
//     default:
//       console.warn('[parseJwtExpiry] unità TTL non supportata:', unit);
//       return 0;
//   }
// }
////////////////////////////////////////////////////////////////
*/

