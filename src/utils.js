const { parseISO, isValid, format } = require('date-fns');

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
  15: 'face',
};

function verifyCodeToMethod(code) {
  const c = Number(code);

  return CODE_TO_METHOD[c] || 'unknown';
}

function fmtYmdHms(date) {
  if (!date) return date;
  let d = date;
  if (typeof d === 'string') {
    try {
      // Accept timestamps already in ISO or 'YYYY-MM-DD HH:mm:ss'
      const normalized = d.includes(' ') ? d.replace(' ', 'T') : d;
      const parsed = parseISO(normalized);
      if (isValid(parsed)) d = parsed;
      else return date; // return original string if invalid
    } catch {
      return date;
    }
  } else if (!(d instanceof Date)) {
    d = new Date(d);
    if (!isValid(d)) return date;
  }
  return format(d, 'yyyy-MM-dd HH:mm:ss');
}

function toISO(ts) {
  if (!ts) return ts;
  // If already a Date
  if (ts instanceof Date) {
    if (!isValid(ts)) return ts;
    return ts.toISOString();
  }
  // If numeric (ms since epoch)
  if (typeof ts === 'number') {
    const d = new Date(ts);
    return isValid(d) ? d.toISOString() : ts;
  }
  if (typeof ts === 'string') {
    const s = ts.includes(' ') ? ts.replace(' ', 'T') : ts;
    try {
      const d = parseISO(s);
      if (isValid(d)) return d.toISOString();
    } catch {
      return ts;
    }
  }
  return ts;
}

function maxTimestampYmdHms(items) {
  let maxDate = null;
  for (const it of items) {
    if (it.type !== 'ATTLOG') continue;
    const iso = toISO(it.timestamp);
    if (typeof iso !== 'string') continue;
    const d = new Date(iso);
    if (!isValid(d)) continue;
    if (!maxDate || d > maxDate) maxDate = d;
  }
  return maxDate ? fmtYmdHms(maxDate) : null;
}

function kvPairs(s) {
  // split on tabs, then key=value
  const obj = {};
  s.split('\t').forEach((seg) => {
    if (!seg) return;
    const eq = seg.indexOf('=');
    if (eq === -1) return;
    const key = seg.substring(0, eq).trim();
    const val = seg.substring(eq + 1).trim();
    obj[key] = val;
  });
  return obj;
}

module.exports = {
  verifyCodeToMethod,
  fmtYmdHms,
  toISO,
  maxTimestampYmdHms,
  kvPairs,
};
