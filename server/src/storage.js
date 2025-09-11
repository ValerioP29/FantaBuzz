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
