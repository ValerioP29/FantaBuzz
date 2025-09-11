export function parseCSV(text){
// split in righe, gestendo CRLF
const rows = String(text || '').replace(/\r\n?/g,
'\n').split('\n').filter(r => r.trim() !== '');
if (rows.length === 0) return { header: [], items: [] };
const sep = guessSep(rows[0]);
const header = rows[0].split(sep).map(h => h.trim());
const items = [];
for (let i = 1; i < rows.length; i++){
const cols = safeSplit(rows[i], sep, header.length);
const obj = {};
header.forEach((h, idx) => obj[h] = cols[idx]);
items.push(obj);
}
return { header, items };
}
function guessSep(sample){
if (sample.includes(';')) return ';';
if (sample.includes('\t')) return '\t';
return ',';
}
function safeSplit(line, sep, expect){
// gestiamo virgolette basilari
const out = [];
let cur = '', inQ = false;
for (let i=0; i<line.length; i++){
const ch = line[i];
if (ch === '"') { inQ = !inQ; continue; }
if (!inQ && ch === sep) { out.push(cur.trim()); cur = ''; continue; }
cur += ch;
}
out.push(cur.trim());
while (out.length < expect) out.push('');
return out;
}
// csv.js
export function mapPlayers(items, map){
  // mappa delle colonne del CSV
  // Esempio: { name:'Nome', role:'Ruolo', team:'Squadra', fm:'FM', out:'Fuori lista' }
  const k = {
    name: map.name || 'name',
    role: map.role || 'role',
    team: map.team || 'team',
    fm:   map.fm   || 'fm',
    out:  map.out  || 'fuori_lista'
  };

  const normRole = v => {
    const s = String(v || '').trim().toUpperCase();
    if (!s) return '';
    if (['P','POR','PORTIERE','GK'].includes(s)) return 'P';
    if (['D','DIF','DIFENSORE','DEF'].includes(s)) return 'D';
    if (['C','CEN','CENTROCAMPISTA','MID'].includes(s)) return 'C';
    if (['A','ATT','ATTACCANTE','FW'].includes(s)) return 'A';
    return s[0]; // fallback: prima lettera
  };

  const normFM = v => {
    if (v === null || v === undefined) return null;
    const n = Number(String(v).replace(',', '.').replace(/\s/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const isOut = v => /\*/.test(String(v || '')); // scarta solo se c’è un asterisco

  const seen = new Set();
  const out = [];

  for (const it of items){
    const outFlag = it.hasOwnProperty(k.out) ? it[k.out] : it['Fuori lista'] ?? it['fuori_lista'] ?? '';
    if (isOut(outFlag)) continue; // fuori lista: skip se c’è *

    const name = String(it[k.name] || '').trim();
    const role = normRole(it[k.role]);
    const team = String(it[k.team] || '').trim();
    const fm   = normFM(it[k.fm]);

    if (!name || !['P','D','C','A'].includes(role)) continue;

    const key = `${name}#${role}`.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ name, role, team, fm });
  }

  return out;
}

