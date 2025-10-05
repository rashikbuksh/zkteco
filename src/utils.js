const { parseISO, isValid, formatISO, format } = require('date-fns');

// Map verify codes to method (adjust if your firmware differs)
const CODE_TO_METHOD = {
  0: 'password',
  1: 'fingerprint',
  2: 'password',
  3: 'card',
  4: 'fingerprint+password',
  5: 'card+password',
  6: 'fingerprint+card',
  7: 'fingerprint+card+password',
  8: 'face',
  9: 'face+password',
  10: 'face+card',
  11: 'face+card+password',
  12: 'face+fingerprint',
  13: 'face+fingerprint+password',
  14: 'face+fingerprint+card',
  15: 'face+fingerprint+card+password',
};

function verifyCodeToMethod(code) {
  const c = Number(code);

  return CODE_TO_METHOD[c] || 'unknown';
}

function fmtYmdHms(date) {
  if (!date) return date;

  if (typeof date === 'string') {
    const parsed = parseISO(date);
    if (!isValid(parsed)) return d;
    date = parsed;
  } else if (!(date instanceof Date)) {
    date = new Date(date);
    if (!isValid(date)) return d;
  }

  return format(date, 'yyyy-MM-dd HH:mm:ss');
}

function toISO(ts) {
  if (!ts) return ts;
  if (!isValid(parseISO(ts))) return ts;

  return formatISO(ts);
}

function maxTimestampYmdHms(items) {
  let max = null;
  for (const it of items) {
    if (it.type !== 'ATTLOG') continue;
    const d = toISO(it.timestamp);
    if (d && (!max || d > max)) max = d;
  }
  if (!max) return null;
  return fmtYmdHms(max);
}

module.exports = {
  verifyCodeToMethod,
  fmtYmdHms,
  toISO,
  maxTimestampYmdHms,
};
