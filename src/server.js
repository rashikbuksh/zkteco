const express = require('express');
const { parseCData } = require('./iclock-parser');
const { PORT, PULL_MODE, DEFAULT_LOOKBACK_HOURS, ICLOCK_COMMAND, USE_CRLF } = require('./config');
const { toISO, verifyCodeToMethod, fmtYmdHms, maxTimestampYmdHms } = require('./utils');

const app = express();
app.use(express.json());

// app.use("/", (req, res, next) => {
// 	console.log(`${req.method} -  ${req.url}`);
// 	next();
// });

app.use('/iclock', express.text({ type: '*/*', limit: '10mb' }));

// In-memory stores (replace with DB in prod)
const pushedLogs = []; // raw + enriched entries
const deviceState = new Map(); // sn -> { lastStamp, lastSeenAt, lastUserSyncAt }
const commandQueue = new Map(); // sn -> [ 'C: ...' ]
const usersByDevice = new Map(); // sn -> Map(pin -> user)
const devicePinKey = new Map(); // sn -> preferred PIN field key (PIN, Badgenumber, EnrollNumber, etc.)
const sseClients = new Set(); // SSE clients for real-time
// NOTE: Optimistic creation: we tag locally created (not yet confirmed) users with optimistic=true
// When a real USERINFO for that PIN arrives, we remove the optimistic flag and stamp confirmedAt

// Config
const port = PORT;
const pullMode = PULL_MODE;
const defaultLookbackHours = DEFAULT_LOOKBACK_HOURS;

//! here is a problem
const commandSyntax = String(ICLOCK_COMMAND || 'DATA_QUERY').toUpperCase();
let dripMode = false; // when true, send only one command per /iclock/getrequest poll

// Utilities
function ensureQueue(sn) {
  if (!commandQueue.has(sn)) commandQueue.set(sn, []);
  return commandQueue.get(sn);
}
function ensureUserMap(sn) {
  if (!usersByDevice.has(sn)) usersByDevice.set(sn, new Map());
  return usersByDevice.get(sn);
}

function buildFetchCommand(sn) {
  const st = deviceState.get(sn);
  const now = new Date();
  const end = fmtYmdHms(now);
  let start;

  if (st?.lastStamp) {
    // st.lastStamp is stored as a Y-m-d H:M:S string (not a Date). toISO() returns a string,
    // so calling getTime() on it caused: TypeError: last?.getTime is not a function.
    // Parse safely into a Date and fall back to now if invalid.
    const raw = String(st.lastStamp).trim();
    let parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
    if (isNaN(parsed.getTime())) {
      // Attempt secondary parse via Date components (YYYY-MM-DD HH:mm:ss)
      const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
      if (m) {
        const [_, Y, M, D, h, i, s] = m;
        parsed = new Date(Number(Y), Number(M) - 1, Number(D), Number(h), Number(i), Number(s));
      }
    }
    if (isNaN(parsed.getTime())) parsed = now;
    // Subtract 1s to avoid missing the next edge record (device returns > start)
    const s = new Date(parsed.getTime() - 1000);
    start = fmtYmdHms(s);
  } else {
    const s = new Date(now.getTime() - defaultLookbackHours * 3600 * 1000);
    start = fmtYmdHms(s);
  }

  switch (commandSyntax) {
    case 'DATA_QUERY':
      return `C: DATA QUERY ATTLOG StartTime=${start} EndTime=${end}`;
    case 'GET_ATTLOG':
      return `C: GET ATTLOG StartTime=${start} EndTime=${end}`;
    case 'ATTLOG':
      return `C: ATTLOG`;
    default:
      return `C: DATA QUERY ATTLOG StartTime=${start} EndTime=${end}`;
  }
}

// Auto-queue a user fetch occasionally
function maybeQueueUserSync(sn) {
  const st = deviceState.get(sn) || {};
  const last = st.lastUserSyncAt ? new Date(st.lastUserSyncAt) : null;
  const now = new Date();
  const stale = !last || now.getTime() - last.getTime() > 6 * 3600 * 1000; // 6h
  if (stale) {
    ensureQueue(sn).push('C: DATA QUERY USERINFO');
    st.lastUserSyncAt = now.toISOString();
    deviceState.set(sn, st);
  }
}

// Health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    devices: Array.from(deviceState.entries()).map(([sn, s]) => ({
      sn,
      lastStamp: s.lastStamp,
      lastSeenAt: s.lastSeenAt,
      lastUserSyncAt: s.lastUserSyncAt,
    })),
    users: Array.from(usersByDevice.entries()).map(([sn, m]) => ({
      sn,
      count: m.size,
    })),
    pullMode,
    commandSyntax,
  });
});

// SSE real-time events
app.get('/api/events/stream', (req, res) => {
  res.set({
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('event: ready\ndata: {"ok":true}\n\n');
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
    try {
      res.end();
    } catch (_) {}
  });
});

function broadcastAttendance(event) {
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    try {
      client.write(`event: attendance\ndata: ${data}\n\n`);
    } catch (_) {}
  }
}

// iClock/ADMS endpoints
app.get('/iclock/ping', (req, res) => {
  const sn = req.query.SN || req.query.sn || '';
  const state = deviceState.get(sn) || {};
  state.lastSeenAt = new Date().toISOString();

  deviceState.set(sn, state);

  res.status(200).send('OK');
});

app.get('/iclock/getrequest', (req, res) => {
  const sn = req.query.SN || req.query.sn || '';
  const state = deviceState.get(sn) || {};
  state.lastSeenAt = new Date().toISOString();

  deviceState.set(sn, state);

  // Debug: log each poll (can be noisy; comment out if too verbose)
  if (ensureQueue(sn).length > 0)
    console.warn(
      `[getrequest] poll SN=${sn} pullMode=${pullMode} queued=${ensureQueue(sn).length}`
    );

  const queue = ensureQueue(sn);
  maybeQueueUserSync(sn);

  if (queue.length) {
    const sep = USE_CRLF ? '\r\n' : '\n';
    let cmds;
    if (dripMode) {
      cmds = [queue.shift()];
    } else {
      cmds = [...queue];
      queue.length = 0;
    }
    const body = cmds.join(sep) + sep;
    console.log(cmds);
    console.log(`*[getrequest] SN=${sn} sending ${cmds.length} cmd(s) dripMode=${dripMode}`); // concise log
    console.log(body);
    return res.status(200).send(body);
  }
  if (pullMode) {
    const cmd = buildFetchCommand(sn);
    const sep = USE_CRLF ? '\r\n' : '\n';
    // console.log(`[getrequest] SN=${sn} auto cmd: ${cmd}`);
    return res.status(200).send(cmd + sep);
  }
  console.log(`[getrequest] SN=${sn} idle (no commands, pullMode=false)`);
  return res.status(200).send('');
});

// Some firmware probe with GET /iclock/cdata — acknowledge OK
app.get('/iclock/cdata', (req, res) => res.status(200).send('OK: Nothing handled in here'));

// Device posts logs here in plain text
app.post('/iclock/cdata', (req, res) => {
  const sn = req.query.SN || req.query.sn || '';
  const table = req.query.table || req.query.options || '';
  const raw = req.body || '';

  // Debug summary of payload
  const rawLines = String(raw).replace(/\r/g, '\n').split('\n').filter(Boolean);
  console.log(
    `[cdata] SN=${sn} table=${table} lines=${rawLines.length} bytes=${Buffer.byteLength(
      String(raw)
    )} firstLine=${rawLines[0] ? JSON.stringify(rawLines[0]) : '<empty>'}`
  );

  const items = parseCData(raw).map((e) => ({
    ...e,
    sn,
    table,
    receivedAt: toISO(new Date()),
  }));

  // Persist users
  for (const it of items) {
    if (it.type === 'USERINFO') {
      const umap = ensureUserMap(sn);
      const pin = String(it.pin || '').trim();
      if (pin) {
        const existing = umap.get(pin) || {};
        const nowIso = new Date().toISOString();
        // Merge device authoritative fields, clear optimistic flag if present
        const merged = { ...existing, ...it };
        if (existing.optimistic) {
          delete merged.optimistic;
          merged.confirmedAt = nowIso;
          if (!merged.createdAt) merged.createdAt = existing.createdAt || nowIso;
        }
        umap.set(pin, merged); // keep uid/name/card/etc.
      }

      // Auto-detect which key label the device uses for PIN / badge on first sight
      if (!devicePinKey.get(sn) && it.kv) {
        const kv = it.kv;
        if (kv.Badgenumber) devicePinKey.set(sn, 'Badgenumber');
        else if (kv.EnrollNumber) devicePinKey.set(sn, 'EnrollNumber');
        else if (kv.PIN || kv.Pin || kv.pin) devicePinKey.set(sn, 'PIN');
      }
    }
  }

  const umap = ensureUserMap(sn);

  // Enrich ATTLOG with method + user info
  const enriched = items.map((it) => {
    if (it.type !== 'ATTLOG') return it;
    const user = umap.get(String(it.pin)) || {};
    return {
      ...it,
      method: verifyCodeToMethod(it.verify),
      user: {
        pin: user.pin || String(it.pin),
        uid: user.uid || '',
        name: user.name || '',
        card: user.card || '',
        privilege: user.privilege || '',
        department: user.department || '',
      },
    };
  });

  pushedLogs.push(...enriched);

  console.log('pushedLogs', pushedLogs);

  // Update device lastStamp
  const newest = maxTimestampYmdHms(enriched);
  const st = deviceState.get(sn) || {};
  if (newest) st.lastStamp = newest;
  st.lastSeenAt = new Date().toISOString();
  deviceState.set(sn, st);

  // Broadcast real-time enriched ATTLOGs
  for (const it of enriched) {
    if (it.type === 'ATTLOG') {
      broadcastAttendance({
        sn,
        pin: it.pin,
        uid: it.user?.uid || '',
        name: it.user?.name || '',
        card: it.user?.card || '',
        timestamp: it.timestamp,
        status: it.status,
        verify: it.verify,
        method: it.method,
        table,
      });
    }
  }

  console.log(`cdata SN=${sn} items=${items.length} newest=${newest || 'n/a'}`);
  res.status(200).send('OK');
});

// Admin/dev helpers

// Pull attendance window (one shot)
// Example: POST /api/device/pull?sn=VGU6244900359&hours=24
app.post('/api/device/pull', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });

  const lookback = Number(req.query.hours || defaultLookbackHours);
  const now = new Date();
  const start = new Date(now.getTime() - lookback * 3600 * 1000);
  const end = now;

  const cmd =
    commandSyntax === 'DATA_QUERY'
      ? `C: DATA QUERY ATTLOG StartTime=${fmtYmdHms(start)} EndTime=${fmtYmdHms(end)}`
      : buildFetchCommand(sn);

  ensureQueue(sn).push(cmd);
  res.json({ ok: true, enqueued: cmd });
});

// Pull full user list now (device will return USERINFO lines to /iclock/cdata)
app.post('/api/device/pull-users', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });

  const cmd = 'C: DATA QUERY USERINFO';
  ensureQueue(sn).push(cmd);

  const st = deviceState.get(sn) || {};
  st.lastUserSyncAt = new Date().toISOString();
  deviceState.set(sn, st);

  res.json({
    ok: true,
    // enqueued: cmd
  });
});

// Simplified view: attendance rows with user fields
app.get('/api/attendances', (req, res) => {
  const { sn } = req.query;
  let data = pushedLogs.filter((x) => x.type === 'ATTLOG');
  if (sn) data = data.filter((x) => x.sn === sn);

  const simplified = data.map((x) => ({
    sn: x.sn,
    pin: x.pin,
    uid: x.user?.uid || '',
    name: x.user?.name || '',
    card: x.user?.card || '',
    timestamp: x.timestamp,
    status: x.status,
    verify: x.verify,
    method: x.method || verifyCodeToMethod(x.verify),
  }));

  res.json({ count: simplified.length, logs: simplified });
});

// Users collected from USERINFO
app.get('/api/users', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) {
    const summary = Array.from(usersByDevice.entries()).map(([dsn, m]) => ({
      sn: dsn,
      count: m.size,
    }));
    return res.json({ devices: summary });
  }
  const m = usersByDevice.get(sn) || new Map();
  const users = Array.from(m.values()).map((u) => ({
    sn,
    pin: u.pin,
    uid: u.uid || '',
    name: u.name,
    card: u.card,
    privilege: u.privilege,
    department: u.department,
  }));
  res.json({ sn, count: users.length, users });
});

app.get('/api/push/logs', (req, res) => {
  const { sn, type } = req.query;
  let data = pushedLogs;
  if (sn) data = data.filter((x) => x.sn === sn);
  if (type) data = data.filter((x) => x.type === String(type).toUpperCase());
  res.json({ count: data.length, logs: data });
});

app.get('/api/device/debug/queue', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const q = ensureQueue(sn);
  res.json({ sn, queued: q });
});

app.post('/api/device/add-user', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });

  // Example usage:
  //   POST /api/device/add-user?sn=DEVICE_SN
  //   Body: { "pin":"2", "name":"Jane", "privilege":0, "minimal":true, "sendVariants":true }
  // For stubborn firmware also set in .env: USE_CRLF=1

  const {
    pin,
    name,
    card,
    privilege,
    department,
    password,
    pin2,
    group,
    minimal, // optional: send only required fields
    sendVariants, // optional: also send alternate verbs
    fullQuery, // optional: force full user list query
    compat, // optional: shortcut enabling variants
    pinKey, // override PIN field label (e.g. Badgenumber, EnrollNumber)
    single, // if true send only the base command
    style, // 'spaces' to use spaces instead of tabs
    uid, // optional internal user id
    optimistic,
  } = req.body || {};
  if (!pin) return res.status(400).json({ error: 'pin is required' });

  const clean = (v) =>
    String(v ?? '')
      .replace(/[\r\n]/g, ' ')
      .trim();

  const pinVal = clean(pin);
  const nameVal = clean(name || '');
  const cardVal = clean(card || '');
  const priVal = Number(privilege ?? 0);
  const deptVal = clean(department || '');
  const pwdVal = clean(password || '');
  const pin2Val = clean(pin2 || '');
  const grpVal = clean(group || '');
  const uId = clean(uid || ''); // optional internal user id

  // Build parts with TAB separators (some firmware require tabs explicitly)
  function join(parts) {
    return style === 'spaces' ? parts.join(' ') : parts.join('\t');
  }
  const autoKey = devicePinKey.get(sn);
  const pinLabel = (pinKey || autoKey || 'PIN').trim();
  const uIdLabel = 'UID'; // Fixed: removed uid variable conflict
  const baseParts = [`${pinLabel}=${pinVal}`];
  if (nameVal) baseParts.push(`Name=${nameVal}`);
  baseParts.push(`Pri=${priVal}`);
  if (!minimal && cardVal) baseParts.push(`Card=${cardVal}`);
  if (!minimal && deptVal) baseParts.push(`Dept=${deptVal}`);
  if (!minimal && pwdVal) baseParts.push(`Passwd=${pwdVal}`);
  if (!minimal && pin2Val) baseParts.push(`PIN2=${pin2Val}`);
  if (!minimal && grpVal) baseParts.push(`Grp=${grpVal}`);
  if (!minimal && uId) baseParts.push(`UID=${uId}`); // internal id, not standard

  const base = `C: SET USERINFO ${join(baseParts)}`;
  const commands = [base];

  let wantVariants = !!(sendVariants || compat);
  if (single) wantVariants = false;
  if (wantVariants) {
    // DATA UPDATE variant (with tabs)
    const updateParts = baseParts.filter(Boolean);
    commands.push(`C: DATA UPDATE USERINFO ${join(updateParts)}`);
    // Minimal SET (only PIN + Pri)
    commands.push(
      `C: SET USERINFO ${join([
        `User Id=${pinVal}`,
        `Name=${nameVal}`,
        `UserRole=${priVal}`,
        `UID=${uId}`,
      ])}`
    );
    commands.push(
      `C: SET USERINFO ${join([`${pinLabel}=${pinVal}`, `Pri=${priVal}`, `UID=${uId}`])}`
    );
    // Privilege= variant
    const privParts = [
      `${pinLabel}=${pinVal}`,
      nameVal ? `Name=${nameVal}` : null,
      `Privilege=${priVal}`,
      cardVal ? `Card=${cardVal}` : null,
      deptVal ? `Dept=${deptVal}` : null,
      uId ? `UID=${uId}` : null,
    ].filter(Boolean);
    commands.push(`C: SET USERINFO ${join(privParts)}`);
    // CardNo variant
    if (cardVal) {
      const cardNoParts = [
        `${pinLabel}=${pinVal}`,
        nameVal ? `Name=${nameVal}` : null,
        `Pri=${priVal}`,
        `CardNo=${cardVal}`,
        uId ? `UID=${uId}` : null,
      ].filter(Boolean);
      commands.push(`C: SET USERINFO ${join(cardNoParts)}`);
    }
    // Reordered variant (Card then Name) - some devices care about order
    if (cardVal) {
      const reorder = [
        `${pinLabel}=${pinVal}`,
        `Card=${cardVal}`,
        nameVal ? `Name=${nameVal}` : null,
        `Pri=${priVal}`,
        uId ? `UID=${uId}` : null,
      ].filter(Boolean);
      commands.push(`C: SET USER ${join(reorder)}`);
    }
    // GET single user
    commands.push(`C: GET USER ${pinLabel}=${pinVal}`);
    commands.push(`C: GET USER ${uIdLabel}=${uId}`);
    // Possible commit (rarely needed, harmless if ignored)
    commands.push(`C: COMMIT USER`);
    // Plain USER line without verb (some odd firmware treat it as implicit SET)
    const plainParts = baseParts.filter(Boolean);
    commands.push(`C: USER ${join(plainParts)}`);
    // Space separated variant
    if (style !== 'spaces') commands.push(`C: SET USER ${plainParts.join(' ')}`);
    // Variant with PIN first then Privilege explicitly then Name (different order)
    const ordered = [`${pinLabel}=${pinVal}`, `Privilege=${priVal}`];
    if (nameVal) ordered.push(`Name=${nameVal}`);
    commands.push(`C: SET USER ${join(ordered)}`);
  }

  // Query that PIN (may be ignored, harmless if unsupported)
  commands.push(`C: DATA QUERY USER ${pinLabel}=${pinVal}`);

  // Full list query to force refresh
  if (fullQuery || wantVariants) {
    commands.push('C: DATA QUERY USER');
  }

  const q = ensureQueue(sn);
  commands.forEach((c) => q.push(c));

  // Deduplicate while preserving order (some duplicates otherwise)
  const seen = new Set();
  const deduped = [];
  for (const c of commands) {
    if (seen.has(c)) continue;
    seen.add(c);
    deduped.push(c);
  }

  // Replace queue contents with deduped list
  while (commands.length) commands.pop();
  deduped.forEach((c) => commands.push(c));

  console.log(`[add-user] SN=${sn} queued ${deduped.length} line(s):`, deduped);

  // Optimistic cache
  const umap = ensureUserMap(sn);
  const existing = umap.get(pinVal) || {};
  const nowIso = new Date().toISOString();
  let optimisticApplied = false;
  // If client explicitly sets optimistic=false, skip local insertion until device confirms
  if (optimistic === false) {
    // Still record a placeholder state so UI can show pending without exposing details
    umap.set(pinVal, {
      ...existing,
      pin: pinVal,
      name: existing.name, // preserve existing if any
      pending: true,
      queuedAt: nowIso,
    });
  } else {
    optimisticApplied = true;
    umap.set(pinVal, {
      ...existing,
      pin: pinVal,
      name: nameVal,
      card: cardVal,
      privilege: String(priVal),
      department: deptVal,
      password: pwdVal ? '****' : undefined,
      pin2: pin2Val || undefined,
      group: grpVal || undefined,
      updatedLocallyAt: nowIso,
      createdAt: existing.createdAt || nowIso,
      optimistic: true,
    });
  }

  return res.json({
    ok: true,
    enqueued: deduped,
    queueSize: q.length,
    note: 'If user still absent: ensure USE_CRLF=1, try minimal=true&compat=true, review /iclock/cdata for USER reply, and verify device allows remote user creation.',
    pinLabelUsed: pinLabel,
    autoDetectedPinKey: autoKey || null,
    optimisticApplied,
  });
});

// Quick test helper (optional)
app.post('/api/device/add-user/test', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const n = Date.now() % 100000;
  req.body = {
    pin: String(n),
    name: 'Test' + n,
    card: String(n),
    privilege: 0,
    minimal: true,
    sendVariants: true,
  };
  return app._router.handle(req, res, () => {}, 'post', '/api/device/add-user');
});

// Delete a user (queue multiple deletion variants)
app.post('/api/device/delete-user', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const { pin } = req.body || {};
  if (!pin) return res.status(400).json({ error: 'pin is required' });
  const variants = [
    `C: DELETE USER PIN=${pin}`,
    `C: DATA DELETE USER PIN=${pin}`,
    `C: CLEAR USER PIN=${pin}`,
    `C: REMOVE USER PIN=${pin}`,
    `C: GET USER PIN=${pin}`,
    `C: DATA QUERY USER PIN=${pin}`,
  ];
  const q = ensureQueue(sn);
  variants.forEach((v) => q.push(v));
  console.log(`[delete-user] SN=${sn} queued ${variants.length} delete variants for PIN=${pin}`);
  // Optimistic local removal
  const umap = ensureUserMap(sn);
  umap.delete(String(pin));
  res.json({ ok: true, enqueued: variants.length, queueSize: q.length });
});

// Clone an existing user (server-side) to a new PIN using stored map
app.post('/api/device/clone-user', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const { fromPin, toPin, compat } = req.body || {};
  if (!fromPin || !toPin) return res.status(400).json({ error: 'fromPin and toPin required' });
  const umap = ensureUserMap(sn);
  const src = umap.get(String(fromPin));
  if (!src) return res.status(404).json({ error: 'fromPin not found' });
  // Reuse add-user logic by constructing body
  const body = {
    pin: String(toPin),
    name: src.name,
    card: src.card,
    privilege: Number(src.privilege || 0),
    department: src.department,
    compat: !!compat,
  };
  req.body = body; // mutate request to reuse handler (safe here in-process)
  return app._router.handle(req, res, () => {}, 'post', '/api/device/add-user');
});

// Toggle drip mode (one command per poll) for sensitive firmware
app.post('/api/device/drip-mode', (req, res) => {
  const { enable } = req.body || {};
  dripMode = !!enable;
  console.log(`[drip-mode] set to ${dripMode}`);
  res.json({ ok: true, dripMode });
});

// Inspect / override detected PIN key label
app.get('/api/device/pin-key', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  return res.json({ sn, pinKey: devicePinKey.get(sn) || null });
});
app.post('/api/device/pin-key', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const { pinKey } = req.body || {};
  if (!pinKey) return res.status(400).json({ error: 'pinKey is required' });
  devicePinKey.set(sn, String(pinKey));
  return res.json({ ok: true, sn, pinKey: devicePinKey.get(sn) });
});

// Raw command injection for advanced troubleshooting
app.post('/api/device/enqueue-command', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const { lines } = req.body || {};
  if (!Array.isArray(lines) || !lines.length)
    return res.status(400).json({ error: 'lines array required' });
  const q = ensureQueue(sn);
  for (let raw of lines) {
    raw = String(raw).trim();
    if (!raw.startsWith('C:')) raw = `C: ${raw}`;
    q.push(raw);
  }
  console.log(`[enqueue-command] SN=${sn} added ${lines.length} line(s).`);
  res.json({ ok: true, queued: q.length });
});

app.post('/api/device/add-user-minimal', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const { pin, name, privilege = 0, card } = req.body || {};
  if (!pin) return res.status(400).json({ error: 'pin is required' });

  const pinVal = String(pin).trim();
  const nameVal = (name || '').replace(/[\r\n]/g, ' ').trim();
  const cardVal = (card || pinVal).trim();

  const cmd = `C: SET USERINFO PIN=${pinVal}${
    nameVal ? ` Name=${nameVal}` : ''
  } Privilege=${privilege} Card=${cardVal}`;
  const q = ensureQueue(sn);
  q.push(cmd);
  q.push('C: DATA QUERY USERINFO'); // full list to confirm
  console.log(`[add-user-minimal] SN=${sn} queued:\n  > ${cmd}`);
  res.json({ ok: true, enqueued: [cmd], queueSize: q.length });
});

app.post('/api/device/custom-command', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command is required' });
  let cmd = String(command).trim();
  if (!cmd.startsWith('C:')) cmd = `C: ${cmd}`;
  const q = ensureQueue(sn);
  q.push(cmd);
  console.log(`[custom-command] SN=${sn} queued:\n  > ${cmd}`);
  res.json({ ok: true, enqueued: [cmd], queueSize: q.length });
});

app.listen(port, () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
  console.log('Device should be configured to http://<server-ip>:%d/iclock/', port);
  console.log(`pullMode=${pullMode} commandSyntax=${commandSyntax}`);
});
