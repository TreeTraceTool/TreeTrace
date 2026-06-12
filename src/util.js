import { createHash } from 'node:crypto';

const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (open, close) => (s) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function truncate(s, n = 80) {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1).trimEnd()}...`;
}

export function plural(n, word, pluralWord) {
  return `${n} ${n === 1 ? word : pluralWord || `${word}s`}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3600000;
  if (hours < 48) return `${Math.round(hours * 10) / 10} hours`;
  const days = Math.round(ms / 86400000);
  return `${days} days`;
}

export function formatDay(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function daySpan(timestamps) {
  const valid = timestamps.map((t) => new Date(t).getTime()).filter(Number.isFinite);
  if (!valid.length) return null;
  const span = Math.max(...valid) - Math.min(...valid);
  const days = Math.max(1, Math.ceil(span / 86400000));
  return days;
}

export function shannonEntropy(s) {
  if (!s) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function mdEscapePipe(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function escapeMd(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
