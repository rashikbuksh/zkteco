const { parseISO, isValid, formatISO } = require('date-fns');

function splitLines(raw) {
  return String(raw)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function SPLITTING(data, delimiters) {
  return data.split(delimiters).map((x) => x.trim());
}

function splitFields(line) {
  if (line.includes(',')) return SPLITTING(line, ',');

  if (line.includes('\t')) return SPLITTING(line, '\t');

  return SPLITTING(line.replace(/\s+/g, ' '), ' ');
}

function looksLikeYmdHms(s) {
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(String(s));
}

function toISO(ts) {
  if (!ts) return ts;
  if (!isValid(parseISO(ts))) return ts;

  return formatISO(ts);
}

function parseATTLOG(fields, type) {
  // Tagged format: "ATTLOG PIN TIMESTAMP STATUS VERIFY WORKCODE ..."
  if (type === 'tagged')
    return {
      type: 'ATTLOG',
      pin: String(fields[1] ?? ''),
      timestamp: toISO(fields[2] ?? ''),
      status: Number(fields[3] ?? '0'),
      verify: Number(fields[4] ?? '0'),
      workcode: String(fields[5] ?? ''),
      raw: fields.join('\t'),
    };

  // Plain format (Android): "PIN TIMESTAMP STATUS VERIFY WORKCODE r1 r2 r3 r4 r5 rid"
  if (type === 'plain')
    return {
      type: 'ATTLOG',
      pin: String(fields[0] ?? ''),
      timestamp: toISO(fields[1] ?? ''),
      status: Number(fields[2] ?? '0'),
      verify: Number(fields[3] ?? '0'),
      workcode: String(fields[4] ?? ''),
      raw: fields.join('\t'),
    };

  // OPLOG format: "OPLOG PIN TIMESTAMP STATUS VERIFY WORKCODE r1 r2 r3 r4 r5 rid"
  if (type === 'oplog') return { type: 'OPLOG', raw: fields.join('\t') };

  console.warn('Unknown ATTLOG format', fields);
  return {};
}

function parseKeyValuePairs(parts) {
  const obj = {};
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx > 0) {
      const k = p.slice(0, idx).trim();
      const v = p.slice(idx + 1).trim();
      obj[k] = v;
    }
  }
  return obj;
}

// USERINFO\tPIN=1\tName=John Doe\tPrivilege=0\tCard=123456\tUID=1001\t...
function parseUserInfo(fields) {
  const kv = parseKeyValuePairs(fields.slice(1));
  const pin = kv.PIN || kv.Pin || kv.pin || '';
  const name = kv.Name || kv.Username || kv.NAME || '';
  const card = kv.Card || kv.CardNo || kv.Badgenumber || '';
  const privilege = kv.Privilege || kv.Pri || kv.Role || '';
  const department = kv.Dept || kv.Department || kv.DEPT || '';
  const uid = kv.UID || kv.UserID || kv.UserId || kv.userid || kv.uid || ''; // internal device user id if present
  return {
    type: 'USERINFO',
    pin: String(pin),
    name,
    card: String(card),
    privilege: String(privilege),
    department: String(department),
    uid: String(uid),
    raw: fields.join('\t'),
    kv,
  };
}

function parseCData(raw) {
  const lines = splitLines(raw);
  const entries = [];

  for (const line of lines) {
    if (/^STAMP/i.test(line)) continue;

    const fields = splitFields(line);
    if (!fields.length) continue;

    const tag = fields[0].toUpperCase();

    switch (tag) {
      case 'ATTLOG':
        entries.push(parseATTLOG(fields, 'tagged'));
        break;
      case 'OPLOG':
        entries.push(parseATTLOG(fields, 'oplog'));
        break;
      case 'USERINFO':
      case 'USER':
        entries.push(parseUserInfo(fields));
        break;
      default:
        if (fields.length >= 2 && looksLikeYmdHms(fields[1]))
          entries.push(parseATTLOG(fields, 'plain'));
        console.log('[cdata] unknown line:', line);
        entries.push({ type: 'UNKNOWN', raw: line });
        break;
    }
  }

  return entries;
}

module.exports = { parseCData };
