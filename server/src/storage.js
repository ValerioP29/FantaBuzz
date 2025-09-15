import fs from 'fs';
import path from 'path';
const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
function roomFile(roomId){
return path.join(DATA_DIR, `${roomId}.json`);
}
export function saveRoomSnapshot(room){
try{
const file = roomFile(room.id || 'DEFAULT');
const tmp = `${file}.tmp`;
const json = JSON.stringify(room, null, 2);
fs.writeFileSync(tmp, json);
fs.renameSync(tmp, file);
return true;
} catch(e){
console.error('saveRoomSnapshot error:', e);
return false;
}
}
export function loadRoomSnapshot(roomId){
try{
const file = roomFile(roomId);
if (!fs.existsSync(file)) return null;
const raw = fs.readFileSync(file, 'utf8');
return JSON.parse(raw);
} catch(e){
console.error('loadRoomSnapshot error:', e);
return null;
}
}

export function writeBackupFile(snap){
  const pad = n => String(n).padStart(2,'0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = DATA_DIR;
  const file = path.join(dir, `DEFAULT.${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
}

