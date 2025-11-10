// Simple console-only logger with levels and optional network filtering
// Env vars:
// - LOG_LEVEL: debug|info|warn|error (default: info)
// - LOG_NETWORK: true|false (default: true)
// - LOG_IGNORE_EVENTS: comma-separated event names to suppress (e.g., "playerPosition,playerPositionUpdate")
// - LOG_SAMPLE_N: number for noisy events sampling (default: 10)

const LEVELS = ["debug", "info", "warn", "error"]; // network logs go through debug/info depending on config

const cfg = {
  level: (process.env.LOG_LEVEL || "info").toLowerCase(),
  network: (process.env.LOG_NETWORK || "true").toLowerCase() !== "false",
  // By default ignore extremely frequent movement updates
  ignore: new Set((process.env.LOG_IGNORE_EVENTS || "playerPosition,playerPositionUpdate").split(",").map(s => s.trim()).filter(Boolean)),
  sampleN: Math.max(1, parseInt(process.env.LOG_SAMPLE_N || "50", 10) || 50),
};

const currentLevelIndex = () => Math.max(0, LEVELS.indexOf(cfg.level));

function ts() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function shouldLog(level) {
  const idx = LEVELS.indexOf(level);
  return idx >= currentLevelIndex();
}

function preview(data) {
  try {
    if (data === undefined) return undefined;
    if (data === null) return null;
    if (typeof data === 'string') {
      return data.length > 200 ? data.slice(0, 200) + '…' : data;
    }
    const json = JSON.stringify(data);
    return json.length > 200 ? json.slice(0, 200) + '…' : JSON.parse(json);
  } catch {
    return '[unserializable]';
  }
}

function baseLog(level, tag, msg, meta) {
  if (!shouldLog(level)) return;
  const line = `[${ts()}] [${level.toUpperCase()}] ${tag}${msg ? ' - ' + msg : ''}`;
  if (meta !== undefined) {
    // Use console[level] if exists, else console.log
    const fn = console[level] || console.log;
    fn(line, meta);
  } else {
    const fn = console[level] || console.log;
    fn(line);
  }
}

// per-key counters for sampling
const counters = new Map(); // key -> count

function sampleKey(key, everyN = cfg.sampleN) {
  const n = Math.max(1, everyN || cfg.sampleN);
  const c = (counters.get(key) || 0) + 1;
  counters.set(key, c);
  return c % n === 0;
}

const logger = {
  config: cfg,
  debug: (msg, meta) => baseLog('debug', 'app', msg, meta),
  info: (msg, meta) => baseLog('info', 'app', msg, meta),
  warn: (msg, meta) => baseLog('warn', 'app', msg, meta),
  error: (msg, meta) => baseLog('error', 'app', msg, meta),

  // Network logging helpers
  netIn: (event, { from, data, sampled, note } = {}) => {
    if (!cfg.network) return;
    if (cfg.ignore.has(event)) return;
    const tag = 'net:IN';
    const msg = `${event}${from ? ` <- ${from}` : ''}${sampled ? ' (sampled)' : ''}${note ? ` | ${note}` : ''}`;
    baseLog('info', tag, msg, preview(data));
  },
  netOut: (event, { to, from, data, sampled, note } = {}) => {
    if (!cfg.network) return;
    if (cfg.ignore.has(event)) return;
    const tag = 'net:OUT';
    const msg = `${event}${from ? ` from ${from}` : ''}${to ? ` -> ${to}` : ''}${sampled ? ' (sampled)' : ''}${note ? ` | ${note}` : ''}`;
    baseLog('info', tag, msg, preview(data));
  },

  // sampling API for noisy events like playerPosition
  shouldLogSampled: (key, everyN) => sampleKey(key, everyN),
};

module.exports = logger;
