/* ================= CSV PARSING ================= */
import { parse } from 'csv-parse/sync';

/**
 * Converte il testo CSV in un oggetto con header e righe, gestendo quoting/escape.
 */
export function parseCSV(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { header: [], items: [] };

  const rows = parse(raw, {
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
    delimiter: [',', ';', '\t'],
  });

  if (!rows.length) return { header: [], items: [] };

  const header = rows[0].map((h) => String(h ?? '').trim());
  const items = rows.slice(1).map((row) => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = row[idx] ?? '';
    });
    return obj;
  });

  return { header, items };
}

/* ================= PLAYER MAPPING ============== */
/**
 * Converte le righe del CSV in oggetti giocatore normalizzati secondo la mappa di colonne.
 */
const HDR = {
  name: [/^nome$/i],
  role: [/^r\.?$|^ruolo$/i],
  team: [/^sq\.?$|^squadra$/i],
  fm: [/^fm$|^fantamedia$/i],
  out: [/^fuori\s*lista$|^fuorilista$/i],
};

function findAliasKey(keys, rxArr) {
  return keys.find((key) => rxArr.some((rx) => rx.test(key))) || null;
}

export function mapPlayers(items, map) {
  const k = {
    name: map.name || 'name',
    role: map.role || 'role',
    team: map.team || 'team',
    fm: map.fm || 'fm',
    out: map.out || 'fuori_lista',
  };

  const aliasCache = {};

  const resolveField = (it, field, extraFallback = null) => {
    const explicitKey = k[field];
    if (explicitKey && Object.prototype.hasOwnProperty.call(it, explicitKey)) {
      return it[explicitKey];
    }

    if (!Object.prototype.hasOwnProperty.call(aliasCache, field)) {
      const keys = Object.keys(it);
      aliasCache[field] = HDR[field] ? findAliasKey(keys, HDR[field]) : null;
    }
    const aliasKey = aliasCache[field];
    if (aliasKey && Object.prototype.hasOwnProperty.call(it, aliasKey)) {
      return it[aliasKey];
    }

    if (extraFallback) {
      for (const key of extraFallback) {
        if (Object.prototype.hasOwnProperty.call(it, key)) return it[key];
      }
    }

    return undefined;
  };

  const normRole = (v) => {
    const s = String(v || '').trim().toUpperCase();
    if (!s) return '';
    if (['P', 'POR', 'PORTIERE', 'GK'].includes(s)) return 'P';
    if (['D', 'DIF', 'DIFENSORE', 'DEF'].includes(s)) return 'D';
    if (['C', 'CEN', 'CENTROCAMPISTA', 'MID'].includes(s)) return 'C';
    if (['A', 'ATT', 'ATTACCANTE', 'FW'].includes(s)) return 'A';
    return s[0];
  };

  const normFM = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(String(v).replace(',', '.').replace(/\s/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const isOut = (v) => /\*/.test(String(v || ''));

  const seen = new Set();
  const out = [];

  for (const it of items) {
    const outFlag = resolveField(it, 'out', ['Fuori lista', 'fuori_lista']) ?? '';
    if (isOut(outFlag)) continue;

    const name = String(resolveField(it, 'name') || '').trim();
    const role = normRole(resolveField(it, 'role'));
    const team = String(resolveField(it, 'team') || '').trim();
    const fm = normFM(resolveField(it, 'fm'));

    if (!name || !['P', 'D', 'C', 'A'].includes(role)) continue;

    const key = `${name}#${role}#${team.toLowerCase()}#${fm ?? ''}`.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ name, role, team, fm });
  }

  return out;
}
