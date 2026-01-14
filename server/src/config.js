const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseList = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

const corsOriginsEnv = process.env.CORS_ORIGINS;
const defaultCorsOrigins = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

const corsOrigins = corsOriginsEnv ? parseList(corsOriginsEnv) : defaultCorsOrigins;

const exportToken = process.env.EXPORT_TOKEN || '';
const hostPin = process.env.HOST_PIN || '';

const hostTokenTtlHours = parseNumber(process.env.HOST_TOKEN_TTL_HOURS, 12);
const persistIntervalMs = parseNumber(process.env.PERSIST_INTERVAL_MS, 1000);
const maxBackups = parseNumber(process.env.MAX_BACKUPS, 50);
const broadcastIntervalMs = parseNumber(process.env.BROADCAST_INTERVAL_MS, 80);
const logLevel = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

if (isProd && !exportToken) {
  throw new Error('EXPORT_TOKEN mancante: configurare EXPORT_TOKEN in produzione.');
}

if (isProd && !hostPin) {
  throw new Error('HOST_PIN mancante: configurare HOST_PIN in produzione.');
}

const isLocalOrigin = (origin) => {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
};

const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (corsOriginsEnv) {
    return corsOrigins.includes(origin);
  }
  return isLocalOrigin(origin);
};

export const config = {
  nodeEnv,
  isProd,
  port: parseNumber(process.env.PORT, 8080),
  corsOrigins,
  corsOriginsEnv,
  exportToken,
  hostPin,
  hostTokenTtlHours,
  persistIntervalMs,
  maxBackups,
  broadcastIntervalMs,
  logLevel,
  isOriginAllowed,
};
