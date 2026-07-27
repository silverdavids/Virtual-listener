const PLACEHOLDERS = new Set([
  'invalid-value',
  'null',
  'undefined',
  'nan',
  'invalid date',
]);

function hasValidCalendarDate(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  if (!match) {
    return true;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeProviderTimestamp(value, context = {}) {
  void context;

  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  let candidate = value;
  if (typeof candidate === 'string') {
    candidate = candidate.trim();
    if (!candidate || PLACEHOLDERS.has(candidate.toLowerCase())) {
      return null;
    }

    if (/^[+-]?\d+(?:\.\d+)?$/.test(candidate)) {
      candidate = Number(candidate);
    } else if (!hasValidCalendarDate(candidate)) {
      return null;
    }
  }

  if (typeof candidate === 'number') {
    if (!Number.isFinite(candidate)) {
      return null;
    }
    candidate = Math.abs(candidate) < 100_000_000_000
      ? candidate * 1000
      : candidate;
  }

  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = {
  normalizeProviderTimestamp,
};
