const express = require('express');
const { parseLine } = require('./iclock-parser');
const { PORT, PULL_MODE, DEFAULT_LOOKBACK_HOURS, ICLOCK_COMMAND, USE_CRLF } = require('./config');
const { verifyCodeToMethod, fmtYmdHms } = require('./utils');

const app = express();
app.use(express.json());

app.use('/iclock', express.text({ type: '*/*', limit: '10mb' }));

// In-memory stores (replace with DB in prod)
const pushedLogs = []; // raw + enriched entries -- attendance real time logs
const informationLogs = []; // raw INFO lines -- user info, user details
const deviceState = new Map(); // sn -> { lastStamp, lastSeenAt, lastUserSyncAt }
const commandQueue = new Map(); // sn -> [ '...' ]
const usersByDevice = new Map(); // sn -> Map(pin -> user)
const devicePinKey = new Map(); // sn -> preferred PIN field key (PIN, Badgenumber, EnrollNumber, etc.)
const sseClients = new Set(); // SSE clients for real-time
const sentCommands = new Map(); // sn -> [{ id, cmd, queuedAt, sentAt(deprecated), deliveredAt, bytesSent, respondedAt, staleAt, postSeenAfterDelivery, remote }]
const cdataEvents = new Map(); // sn -> [{ at, lineCount, firstLine, hasUserInfo, hasAttlog, hasOptionLike }]
const rawCDataStore = new Map(); // sn -> [{ at, raw, bytes }]
const pollHistory = new Map(); // sn -> [{ at, queueBefore, deliveredCount, remote }]
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

// Ensure users are fetched from device if usersByDevice is empty
async function ensureUsersFetched(sn) {
  const umap = ensureUserMap(sn);

  // If we have users, return immediately
  if (umap.size > 0) {
    return umap;
  }

  // If no users cached, queue a fetch command
  console.log(`[ensure-users] SN=${sn} no cached users, queuing fetch command`);
  const q = ensureQueue(sn);

  // Only queue if not already queued
  const hasUserQuery = q.some((cmd) => cmd.includes('C:1:DATA QUERY USERINFO'));

  if (!hasUserQuery) {
    q.push('C:1:DATA QUERY USERINFO');
    console.log(`[ensure-users] SN=${sn} queued user fetch command`);
  } else {
    console.log(`[ensure-users] SN=${sn} user fetch already queued`);
  }

  return umap;
}

function ensureSentList(sn) {
  if (!sentCommands.has(sn)) sentCommands.set(sn, []);
  return sentCommands.get(sn);
}

let globalCommandId = 1;
function recordSentCommand(sn, cmd, remote) {
  const list = ensureSentList(sn);
  list.push({
    id: globalCommandId++,
    cmd,
    queuedAt: new Date().toISOString(), // new canonical field
    sentAt: new Date().toISOString(), // legacy name retained for compatibility
    deliveredAt: null,
    bytesSent: null,
    respondedAt: null,
    staleAt: null,
    remote: remote || null,
  });
  // Cap list length to avoid unbounded growth
  if (list.length > 500) list.splice(0, list.length - 500);
}
function markDelivered(sn, ids, bytes) {
  const list = sentCommands.get(sn);
  if (!list) return;
  const ts = new Date().toISOString();
  for (const rec of list) {
    if (ids.includes(rec.id)) {
      rec.deliveredAt = ts;
      rec.bytesSent = bytes;
    }
  }
}

function recordCDataEvent(sn, summary) {
  if (!cdataEvents.has(sn)) cdataEvents.set(sn, []);
  const arr = cdataEvents.get(sn);
  arr.push(summary);
  if (arr.length > 300) arr.splice(0, arr.length - 300);
  // Update linkage: any command delivered before this event but not yet responded gets postSeenAfterDelivery
  const cmds = sentCommands.get(sn);
  if (cmds) {
    for (const c of cmds) {
      if (c.deliveredAt && !c.respondedAt) {
        if (!c.postSeenAfterDelivery && c.deliveredAt <= summary.at) {
          c.postSeenAfterDelivery = true;
        }
      }
    }
  }
}

// Poll history record
function recordPoll(sn, remote, queueBefore, deliveredCount) {
  if (!pollHistory.has(sn)) pollHistory.set(sn, []);
  const arr = pollHistory.get(sn);
  arr.push({ at: new Date().toISOString(), remote, queueBefore, deliveredCount });
  if (arr.length > 200) arr.splice(0, arr.length - 200);
}

// Stale detection (commands delivered but no response after threshold)
const STALE_SECONDS = Number(process.env.STALE_SECONDS || 90);
function markStaleCommands(sn) {
  const list = sentCommands.get(sn);
  if (!list) return;
  const now = Date.now();
  for (const c of list) {
    if (c.deliveredAt && !c.respondedAt && !c.staleAt) {
      const age = now - new Date(c.deliveredAt).getTime();
      if (age > STALE_SECONDS * 1000) {
        c.staleAt = new Date().toISOString();
      }
    }
  }
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
      return `C:1:DATA QUERY ATTLOG StartTime=${start} EndTime=${end}`;
    case 'GET_ATTLOG':
      return `C:1:GET ATTLOG StartTime=${start} EndTime=${end}`;
    case 'ATTLOG':
      return `C:1:ATTLOG`;
    default:
      return `C:1:DATA QUERY ATTLOG StartTime=${start} EndTime=${end}`;
  }
}

// Health
app.get('/health', async (req, res) => {
  // Process users with proper async handling
  const deviceEntries = Array.from(deviceState.entries());

  // Debug: Log current usersByDevice state
  console.log('[health] Current usersByDevice map:');
  for (const [sn, umap] of usersByDevice.entries()) {
    console.log(`  SN=${sn} users=${umap.size} pins=[${Array.from(umap.keys()).join(', ')}]`);
  }

  const usersSummary = await Promise.all(
    deviceEntries.map(async ([sn, s]) => {
      console.log(`[health] Processing device SN=${sn}`);
      await ensureUsersFetched(sn);
      const umap = usersByDevice.get(sn);
      const count = umap ? umap.size : 0;
      console.log(`[health] SN=${sn} final count=${count}`);
      return {
        sn,
        count,
      };
    })
  );

  res.json({
    ok: true,
    devices: Array.from(deviceState.entries()).map(([sn, s]) => ({
      sn,
      lastStamp: s.lastStamp,
      lastSeenAt: s.lastSeenAt,
      lastUserSyncAt: s.lastUserSyncAt,
    })),
    users: usersSummary,
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

// iClock/ADMS endpoints
app.get('/iclock/ping', (req, res) => {
  const sn = req.query.SN || req.query.sn || '';
  const state = deviceState.get(sn) || {};
  state.lastSeenAt = new Date().toISOString();

  deviceState.set(sn, state);

  console.log(`[ping] SN=${sn}`);
  console.log(state, 'deviceState');

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
    // Record commands (pre-write) for diagnostics
    const remote = (req.socket && req.socket.remoteAddress) || null;

    const justIds = [];
    cmds.forEach((c) => {
      recordSentCommand(sn, c, remote);
      const list = sentCommands.get(sn);
      // console.log(`list`, list);
      if (list) justIds.push(list[list.length - 1].id);
    });
    // console.log(`body`, body);
    // Attempt send
    res.status(200).send(body);
    // Approximate bytes (body length in UTF-8)
    const bytes = Buffer.byteLength(body, 'utf8');
    markDelivered(sn, justIds, bytes);
    recordPoll(sn, remote, queue.length + cmds.length, cmds.length);
    markStaleCommands(sn);
    return; // response already sent
  }
  if (pullMode) {
    const cmd = buildFetchCommand(sn);
    const sep = USE_CRLF ? '\r\n' : '\n';
    // console.log(`[getrequest] SN=${sn} auto cmd: ${cmd}`);
    recordPoll(sn, (req.socket && req.socket.remoteAddress) || null, queue.length, 0);
    return res.status(200).send(cmd + sep);
  }
  console.log(`[getrequest] SN=${sn} idle (no commands, pullMode=false)`);
  recordPoll(sn, (req.socket && req.socket.remoteAddress) || null, queue.length, 0);
  return res.status(200).send('');
});

// Device posts logs here in plain text
app.post('/iclock/cdata', (req, res) => {
  const sn = req.query.SN || req.query.sn || '';
  const table = req.query.table || req.query.options || '';
  const raw = req.body || '';

  // Debug summary of payload
  const rawLines = String(raw).replace(/\r/g, '\n').split('\n').filter(Boolean);
  // console.log(
  //   `[cdata] SN=${sn} table=${table} lines=${rawLines.length} bytes=${Buffer.byteLength(
  //     String(raw)
  //   )} firstLine=${rawLines[0] ? JSON.stringify(rawLines[0]) : '<empty>'}`
  // );

  recordCDataEvent(sn, {
    at: new Date().toISOString(),
    lineCount: rawLines.length,
    firstLine: rawLines[0] || '',
  });

  const truncated = rawLines.slice(0, 200).join('\n');
  if (!rawCDataStore.has(sn)) rawCDataStore.set(sn, []);
  const rawArr = rawCDataStore.get(sn);
  rawArr.push({ at: new Date().toISOString(), raw: truncated, bytes: Buffer.byteLength(raw) });
  if (rawArr.length > 100) rawArr.splice(0, rawArr.length - 100);
  markStaleCommands(sn);

  // Process each line individually to handle multiple USER entries
  const allParsedItems = [];
  for (const line of rawLines) {
    if (line.trim()) {
      const items = parseLine(line);
      if (items) {
        allParsedItems.push(items);
      }
    }
  }

  // Process all parsed items
  let userCount = 0;
  let duplicateCount = 0;

  for (const items of allParsedItems) {
    if (items.type === 'REAL_TIME_LOG') {
      pushedLogs.push(items);
    } else {
      informationLogs.push(items);
      if (items.type === 'USER') {
        // Auto-detect PIN key from the first USER with PIN-like fields
        const pinKeys = ['PIN', 'Badgenumber', 'EnrollNumber', 'CardNo', 'Card'];
        let userPin = null;
        let detectedKey = null;

        // Find which PIN field is present
        for (const key of pinKeys) {
          if (items[key]) {
            userPin = String(items[key]);
            detectedKey = key;
            break;
          }
        }

        if (userPin && detectedKey) {
          // Auto-detect and cache the PIN key for this device
          if (!devicePinKey.has(sn)) {
            devicePinKey.set(sn, detectedKey);
            // console.log(`[auto-detect] SN=${sn} detected PIN key: ${detectedKey}`);
          }

          const umap = ensureUserMap(sn);

          // Avoid overwriting existing users with same PIN
          if (!umap.has(userPin)) {
            umap.set(userPin, { ...items, pin: userPin });
            userCount++;
            // console.log(`[user-added] SN=${sn} PIN=${userPin} Name=${items.Name || 'N/A'}`);
          } else {
            duplicateCount++;
            // console.log(
            //   `[user-exists] SN=${sn} PIN=${userPin} Name=${
            //     items.Name || 'N/A'
            //   } - skipping duplicate`
            // );
          }
        }
      }
    }
  }

  // Summary logging for user operations
  if (userCount > 0 || duplicateCount > 0) {
    const totalUsers = ensureUserMap(sn).size;
    console.log(
      `[user-summary] SN=${sn} added=${userCount} duplicates_skipped=${duplicateCount} total_users=${totalUsers}`
    );
  }

  // console.log(usersByDevice, 'usersByDevice');

  // console.log('pushedLogs', pushedLogs);

  // console.log('informationLogs', informationLogs);

  const st = deviceState.get(sn) || {};
  st.lastSeenAt = new Date().toISOString();
  deviceState.set(sn, st);

  console.log(`cdata SN=${sn} parsed_items=${allParsedItems.length} raw_lines=${rawLines.length}`);
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
      ? `DATA QUERY ATTLOG StartTime=${fmtYmdHms(start)} EndTime=${fmtYmdHms(end)}`
      : buildFetchCommand(sn);

  ensureQueue(sn).push(cmd);
  res.json({ ok: true, enqueued: cmd });
});

// Pull full user list now (device will return USERINFO lines to /iclock/cdata)
app.post('/api/device/pull-users', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });

  const cmd = 'C:1:DATA QUERY USERINFO';
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

// Debug endpoint to check usersByDevice map
app.get('/api/debug/users-map', (req, res) => {
  const result = {};
  for (const [sn, umap] of usersByDevice.entries()) {
    result[sn] = {
      count: umap.size,
      users: Array.from(umap.entries()).map(([pin, user]) => ({
        pin,
        name: user.name || user.Name || 'N/A',
        type: user.type,
      })),
    };
  }
  res.json({
    usersByDeviceMap: result,
    totalDevices: usersByDevice.size,
  });
});

app.get('/api/device/debug/queue', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const q = ensureQueue(sn);
  res.json({ sn, queued: q });
});

app.post('/api/device/add-user', async (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });

  // Ensure users are fetched before processing
  await ensureUsersFetched(sn);

  const {
    pin,
    name,
    card,
    privilege,
    department,
    password,
    pin2,
    group,
    fullQuery, // optional: force full user list query
    pinKey, // override PIN field label (e.g. Badgenumber, EnrollNumber)
    style, // 'spaces' to use spaces instead of tabs
    optimistic,
  } = req.body || {};

  if (!name) return res.status(400).json({ error: 'name is required' });

  const clean = (v) =>
    String(v ?? '')
      .replace(/[\r\n]/g, ' ')
      .trim();

  // Auto-generate PIN if not provided
  const pinVal = pin ? clean(pin) : String(getNextAvailablePin(sn));
  const nameVal = clean(name || '');
  const cardVal = clean(card || '');
  const priVal = Number(privilege ?? 0);
  const deptVal = clean(department || '');
  const pwdVal = clean(password || '');
  const pin2Val = clean(pin2 || '');
  const grpVal = clean(group || '');

  // Check if PIN already exists
  const umap = ensureUserMap(sn);
  if (umap.has(pinVal)) {
    return res.status(400).json({
      error: `PIN ${pinVal} already exists`,
      suggestedPin: getNextAvailablePin(sn),
    });
  }

  // Build parts with TAB separators (some firmware require tabs explicitly)
  function join(parts) {
    return style === 'spaces' ? parts.join(' ') : parts.join('\t');
  }
  const autoKey = devicePinKey.get(sn);
  const pinLabel = (pinKey || autoKey || 'PIN').trim();
  const baseParts = [`${pinLabel}=${pinVal}`];
  if (nameVal) baseParts.push(`Name=${nameVal}`);
  baseParts.push(`Privilege=${priVal}`);
  if (cardVal) baseParts.push(`Card=${cardVal}`);
  if (deptVal) baseParts.push(`Dept=${deptVal}`);
  if (pwdVal) baseParts.push(`Passwd=${pwdVal}`);
  if (pin2Val) baseParts.push(`PIN2=${pin2Val}`);
  if (grpVal) baseParts.push(`Grp=${grpVal}`);

  const base = `C:1:DATA UPDATE USERINFO ${join(baseParts)}`;
  const commands = [base];

  // Query that PIN (may be ignored, harmless if unsupported)
  commands.push(`C:2:DATA QUERY USER ${pinLabel}=${pinVal}`);

  // Full list query to force refresh
  if (fullQuery) {
    commands.push('C:3:DATA QUERY USER');
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

  console.log(
    `[add-user] SN=${sn} PIN=${pinVal} Name=${nameVal} queued ${deduped.length} line(s):`,
    deduped
  );

  // Optimistic cache
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
    assignedPin: pinVal,
    wasAutoGenerated: !pin,
    nextAvailablePin: getNextAvailablePin(sn),
    note: 'If user still absent: ensure USE_CRLF=1, try minimal=true&compat=true, review /iclock/cdata for USER reply, and verify device allows remote user creation.',
    pinLabelUsed: pinLabel,
    autoDetectedPinKey: autoKey || null,
    optimisticApplied,
  });
});

// Diagnostics: list sent commands & their response status
app.get('/api/device/commands', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const list = ensureSentList(sn).slice(-200); // last 200
  // Derive quick stats
  const pending = list.filter((c) => c.deliveredAt && !c.respondedAt);
  const pendingNoPostAfter = pending.filter((c) => !c.postSeenAfterDelivery).length;
  const pendingWithPost = pending.filter((c) => c.postSeenAfterDelivery).length;
  const stale = list.filter((c) => c.staleAt && !c.respondedAt).length;
  res.json({
    sn,
    count: list.length,
    commands: list,
    stats: {
      pending: pending.length,
      pendingNoPostAfter,
      pendingWithPostButNoMatch: pendingWithPost,
      stale,
      staleSecondsThreshold: STALE_SECONDS,
    },
  });
});

// Clear diagnostics history for a device
app.post('/api/device/commands/clear', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  sentCommands.set(sn, []);
  cdataEvents.set(sn, []);
  rawCDataStore.set(sn, []);
  pollHistory.set(sn, []);
  res.json({ ok: true, sn });
});

// Force re-sync of users: clears lastUserSyncAt & queues a fresh query (optionally clears optimistic flags)
app.post('/api/device/force-user-sync', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const { clearOptimistic } = req.body || {};
  const st = deviceState.get(sn) || {};
  delete st.lastUserSyncAt;
  deviceState.set(sn, st);
  ensureQueue(sn).push(`C:1:DATA QUERY USERINFO`);
  if (clearOptimistic) {
    const umap = usersByDevice.get(sn);
    if (umap) {
      for (const [pin, u] of umap.entries()) {
        if (u.optimistic) umap.delete(pin);
      }
    }
  }
  res.json({ ok: true, queued: 'C:1:DATA QUERY USERINFO', clearOptimistic: !!clearOptimistic });
});

// Poll history
app.get('/api/device/polls', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const arr = (pollHistory.get(sn) || []).slice(-100);
  res.json({ sn, count: arr.length, polls: arr });
});

// Delete a user (queue multiple deletion variants)
app.post('/api/device/delete-user', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const { pin } = req.body || {};
  if (!pin) return res.status(400).json({ error: 'pin is required' });
  const variants = [
    `C:1:DELETE USER PIN=${pin}`,
    `C:2:DATA DELETE USER PIN=${pin}`,
    `C:3:CLEAR USER PIN=${pin}`,
    `C:4:REMOVE USER PIN=${pin}`,
    `C:5:GET USER PIN=${pin}`,
    `C:6:DATA QUERY USER PIN=${pin}`,
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
app.post('/api/device/clone-user', async (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });

  const { fromPin, toPin, compat } = req.body || {};
  if (!fromPin || !toPin) return res.status(400).json({ error: 'fromPin and toPin required' });

  // Ensure users are fetched before cloning
  await ensureUsersFetched(sn);

  const umap = ensureUserMap(sn);
  const src = umap.get(String(fromPin));
  if (!src) return res.status(404).json({ error: 'fromPin not found' });

  // Reuse add-user logic by constructing body
  const body = {
    pin: String(toPin),
    name: src.name || src.Name,
    card: src.card || src.Card,
    privilege: Number(src.privilege || src.Pri || 0),
    department: src.department || src.Dept,
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

// Get next available PIN for a device
app.get('/api/device/next-pin', async (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });

  // Ensure users are fetched before calculating next PIN
  await ensureUsersFetched(sn);

  const startPin = Number(req.query.startPin) || 1;
  const nextPin = getNextAvailablePin(sn, startPin);
  const umap = usersByDevice.get(sn) || new Map();
  const existingCount = umap.size;

  res.json({
    sn,
    nextAvailablePin: nextPin,
    existingUserCount: existingCount,
    startPin,
  });
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
    if (!raw.startsWith('C:')) raw = `${raw}`;
    q.push(raw);
  }
  console.log(`[enqueue-command] SN=${sn} added ${lines.length} line(s).`);
  res.json({ ok: true, queued: q.length });
});

app.post('/api/device/custom-command', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command is required' });
  let cmd = String(command).trim();
  if (!cmd.startsWith('C:')) cmd = `${cmd}`;
  const q = ensureQueue(sn);
  q.push(cmd);
  console.log(`[custom-command] SN=${sn} queued:\n  > ${cmd}`);
  res.json({ ok: true, enqueued: [cmd], queueSize: q.length });
});

// Helper function to find next available PIN for a device
function getNextAvailablePin(sn, startPin = 1) {
  // Use ensureUserMap to get existing map (already fetched by calling function)
  const umap = ensureUserMap(sn);
  let pin = Number(startPin) || 1;

  // Find the highest existing PIN to start from
  const existingPins = Array.from(umap.keys())
    .map((p) => Number(p))
    .filter((p) => !isNaN(p));
  if (existingPins.length > 0) {
    const maxPin = Math.max(...existingPins);
    pin = Math.max(pin, maxPin + 1);
  }

  // Find next available PIN
  while (umap.has(String(pin))) {
    pin++;
  }

  return pin;
}

// Bulk user insertion with auto PIN generation
app.post('/api/device/bulk-add-users', async (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });

  // Ensure users are fetched before bulk operations
  await ensureUsersFetched(sn);

  const {
    users, // array of user objects: [{ name: 'Anik2', card?: '123', privilege?: 0, department?: '', password?: '', pin2?: '', group?: '' }]
    startPin, // optional: starting PIN number (default: auto-detect next available)
    pinKey, // override PIN field label (e.g. Badgenumber, EnrollNumber)
    style, // 'spaces' to use spaces instead of tabs
    optimistic = true, // whether to apply optimistic caching
    fullQuery = true, // whether to query full user list after bulk insert
  } = req.body || {};

  if (!Array.isArray(users) || users.length === 0) {
    return res.status(400).json({ error: 'users array is required and must not be empty' });
  }

  const clean = (v) =>
    String(v ?? '')
      .replace(/[\r\n]/g, ' ')
      .trim();

  function join(parts) {
    return style === 'spaces' ? parts.join(' ') : parts.join('\t');
  }

  const autoKey = devicePinKey.get(sn);
  const pinLabel = (pinKey || autoKey || 'PIN').trim();
  const q = ensureQueue(sn);
  const umap = ensureUserMap(sn);
  const nowIso = new Date().toISOString();

  let currentPin = getNextAvailablePin(sn, startPin);
  const commands = [];
  const processedUsers = [];
  const errors = [];

  console.log(
    `[bulk-add-users] SN=${sn} starting bulk insert of ${users.length} users, starting from PIN ${currentPin}`
  );

  for (let i = 0; i < users.length; i++) {
    const user = users[i];

    try {
      // Validate required fields
      if (!user.name || !clean(user.name)) {
        errors.push({ index: i, error: 'name is required', user });
        continue;
      }

      // Use provided PIN or auto-generate
      const pinVal = user.pin ? clean(user.pin) : String(currentPin);

      // Check if PIN already exists
      if (umap.has(pinVal)) {
        errors.push({ index: i, error: `PIN ${pinVal} already exists`, user });
        continue;
      }

      const nameVal = clean(user.name);
      const cardVal = clean(user.card || '');
      const priVal = Number(user.privilege ?? 0);
      const deptVal = clean(user.department || '');
      const pwdVal = clean(user.password || '');
      const pin2Val = clean(user.pin2 || '');
      const grpVal = clean(user.group || '');

      // Build command parts
      const baseParts = [`${pinLabel}=${pinVal}`];
      if (nameVal) baseParts.push(`Name=${nameVal}`);
      baseParts.push(`Privilege=${priVal}`);
      if (cardVal) baseParts.push(`Card=${cardVal}`);
      if (deptVal) baseParts.push(`Dept=${deptVal}`);
      if (pwdVal) baseParts.push(`Passwd=${pwdVal}`);
      if (pin2Val) baseParts.push(`PIN2=${pin2Val}`);
      if (grpVal) baseParts.push(`Grp=${grpVal}`);

      const command = `C:${i + 1}:DATA UPDATE USERINFO ${join(baseParts)}`;
      commands.push(command);

      // Optimistic cache update
      if (optimistic) {
        umap.set(pinVal, {
          pin: pinVal,
          name: nameVal,
          card: cardVal,
          privilege: String(priVal),
          department: deptVal,
          password: pwdVal ? '****' : undefined,
          pin2: pin2Val || undefined,
          group: grpVal || undefined,
          updatedLocallyAt: nowIso,
          createdAt: nowIso,
          optimistic: true,
        });
      }

      processedUsers.push({
        index: i,
        pin: pinVal,
        name: nameVal,
        command,
      });

      // Increment PIN for next user (if auto-generating)
      if (!user.pin) {
        currentPin++;
      }
    } catch (error) {
      errors.push({ index: i, error: error.message, user });
    }
  }

  // Add query commands for verification
  if (fullQuery) {
    commands.push(`C:${commands.length + 1}:DATA QUERY USERINFO`);
  }

  // Queue all commands
  commands.forEach((cmd) => q.push(cmd));

  // Deduplicate queue
  const seen = new Set();
  const queueArray = [...q];
  q.length = 0; // Clear queue

  for (const cmd of queueArray) {
    if (!seen.has(cmd)) {
      seen.add(cmd);
      q.push(cmd);
    }
  }

  console.log(
    `[bulk-add-users] SN=${sn} queued ${commands.length} commands for ${processedUsers.length} users`
  );

  res.json({
    ok: true,
    sn,
    processed: processedUsers.length,
    errors: errors.length,
    totalRequested: users.length,
    commands: commands.length,
    queueSize: q.length,
    processedUsers,
    errors,
    nextAvailablePin: currentPin,
    pinLabelUsed: pinLabel,
    optimisticApplied: optimistic,
    note: 'Users will be created with auto-generated PINs starting from the next available PIN number. Check /api/users to verify creation.',
  });
});

// Diagnostic probe: enqueue a suite of commands that should, if supported, elicit responses.
// Optional body: { pin: '123', minutes: 10 }
app.post('/api/device/probe', (req, res) => {
  const sn = req.query.sn || req.query.SN;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const { pin, minutes = 10 } = req.body || {};
  const lookback = Math.min(Math.max(Number(minutes) || 1, 1), 1440); // clamp 1..1440
  const now = new Date();
  const start = new Date(now.getTime() - lookback * 60 * 1000);
  const startStr = fmtYmdHms(start);
  const endStr = fmtYmdHms(now);
  const q = ensureQueue(sn);
  const cmds = [
    // Attendance queries
    `C:1:DATA QUERY ATTLOG StartTime=${startStr} EndTime=${endStr}`,
    `C:1:GET ATTLOG StartTime=${startStr} EndTime=${endStr}`,
    `C:1:ATTLOG`,
    // User list queries
    `C:1:DATA QUERY USERINFO`,
    `C:1:GET USERINFO`,
    `C:1:DATA QUERY USER`,
    // Option queries (some firmwares respond with OPTION lines)
    `C:1:GET OPTION DATE`,
    `C:1:GET OPTION INFO`,
    `C:1:GET OPTION PLATFORM`,
  ];
  if (pin) {
    cmds.push(`C:1:GET USER PIN=${pin}`);
    cmds.push(`C:1:DATA QUERY USER PIN=${pin}`);
  }
  // Deduplicate
  const seen = new Set();
  const deduped = [];
  for (const c of cmds) {
    if (seen.has(c)) continue;
    seen.add(c);
    deduped.push(c);
  }
  deduped.forEach((c) => q.push(c));
  console.log(`[probe] SN=${sn} queued ${deduped.length} diagnostic command(s).`);
  res.json({ ok: true, enqueued: deduped, queueSize: q.length, windowMinutes: lookback });
});

app.listen(port, () => {
  console.log(`Server listening on http://0.0.0.0:${port}`);
  console.log('Device should be configured to http://<server-ip>:%d/iclock/', port);
  console.log(`pullMode=${pullMode} commandSyntax=${commandSyntax}`);
});
