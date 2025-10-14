const { verifyCodeToMethod, kvPairs } = require('./utils');

function parseATTLOG(fields, type) {
  // Tagged format: "ATTLOG PIN TIMESTAMP STATUS VERIFY WORKCODE ..."
  if (type === 'tagged')
    return {
      type: 'REAL_TIME_LOG',
      pin: String(fields[1] ?? ''),
      timestamp: fields[2] ?? '',
      status: Number(fields[3] ?? '0'),
      verify: verifyCodeToMethod(Number(fields[4] ?? '0')),
      workcode: String(fields[5] ?? ''),
      raw: fields.join('\t'),
    };

  // Plain format (Android): "PIN TIMESTAMP STATUS VERIFY WORKCODE r1 r2 r3 r4 r5 rid"
  if (type === 'plain')
    return {
      type: 'REAL_TIME_LOG',
      pin: String(fields[0] ?? ''),
      timestamp: fields[1] ?? '',
      status: Number(fields[2] ?? '0'),
      verify: verifyCodeToMethod(Number(fields[3] ?? '0')),
      workcode: String(fields[4] ?? ''),
      raw: fields.join('\t'),
    };

  // OPLOG format: "OPLOG PIN TIMESTAMP STATUS VERIFY WORKCODE r1 r2 r3 r4 r5 rid"
  if (type === 'oplog') return { type: 'OPLOG', raw: fields.join('\t') };

  console.warn('Unknown ATTLOG format', fields);
  return {};
}

function parseLine(line) {
  // Trim CR/LF
  const raw = line.trim();
  if (!raw) return null;

  const firstToken = raw.split('\t', 1)[0];
  const firstSpace = raw.split(' ', 1)[0];

  switch (firstSpace) {
    case 'USER': {
      const kv = kvPairs(raw.substring(5));
      return { type: 'USER', ...kv };
    }

    case 'BIODATA': {
      const kv = kvPairs(raw.substring(8));
      return { type: 'BIODATA', ...kv };
    }

    case 'USERPIC': {
      const kv = kvPairs(raw.substring(8));
      return { type: 'USERPIC', ...kv };
    }

    case 'BIOPHOTO': {
      const kv = kvPairs(raw.substring(9));
      return { type: 'BIOPHOTO', ...kv };
    }

    case 'OPLOG': {
      const parts = raw.split('\t');
      const head = parts[0].split(' ');
      const opCode = head[1];
      return {
        type: 'OPLOG',
        opCode,
        operatorPin: parts[1],
        dateTime: parts[2],
        status: parts[3],
        p1: parts[4],
        p2: parts[5],
        p3: parts[6],
        raw,
      };
    }

    // Attendance (plain) if first token is an integer PIN
    case /^[0-9]+$/.test(firstToken): {
      const fields = raw.split('\t');
      return parseATTLOG(fields, 'plain');
    }

    default:
      return { type: 'UNKNOWN', raw };
  }
}

module.exports = { parseLine };
