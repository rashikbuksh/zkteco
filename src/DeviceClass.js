const { DEFAULT_LOOKBACK_HOURS, ICLOCK_COMMAND } = require('./config');
const { fmtYmdHms } = require('./utils');

const defaultLookbackHours = DEFAULT_LOOKBACK_HOURS;
const commandSyntax = String(ICLOCK_COMMAND || 'DATA_QUERY').toUpperCase();
const STALE_SECONDS = Number(process.env.STALE_SECONDS || 90);

class ZKDevice {
  // Static in-memory stores (shared across all devices)
  static pushedLogs = [];
  static informationLogs = [];
  static devicePinKey = new Map();
  static devicePinCounter = new Map();
  static sseClients = new Set();
  static rawCDataStore = new Map();

  static commandQueue = new Map();
  static usersByDevice = new Map();
  static sentCommands = new Map();
  static cdataEvents = new Map();
  static pollHistory = new Map();
  static deviceState = new Map();

  static globalCommandId = 1;

  constructor(sn) {
    this.sn = sn;
    this.commandQueue.set(sn, []);
    this.usersByDevice.set(sn, new Map());
    this.sentCommands.set(sn, []);
    this.cdataEvents.set(sn, []);
    this.pollHistory.set(sn, []);
    this.deviceState.set(sn, { lastSeenAt: null, lastStamp: null, lastUserSyncAt: null });
  }

  // GETTER
  getCommandQueue() {
    return this.commandQueue.get(this.sn);
  }

  getUsers() {
    return this.usersByDevice.get(this.sn);
  }

  getSentCommands() {
    return this.sentCommands.get(this.sn);
  }

  getCDataEvents() {
    return this.cdataEvents.get(this.sn);
  }

  getPollHistory() {
    return this.pollHistory.get(this.sn);
  }

  setDeviceState({ updateLastSeen = false, updateLastUserSync = false, updateLastStamp = false }) {
    // lastSeenAt;
    // lastUserSyncAt; -> /api/device/pull-users

    const state = this.deviceState.get(this.sn);
    const ts = new Date().toISOString();

    if (updateLastSeen) state.lastSeenAt = ts;

    if (updateLastUserSync) state.lastUserSyncAt = ts;

    if (updateLastStamp) state.lastStamp = updateLastStamp;

    this.deviceState.set(this.sn, state);
  }

  ensureUsersFetched() {
    if (this.getUsers().size > 0) {
      return this.getUsers();
    }

    console.log(`[ensure-Users-Fetched] [no cached users] SN=${this.sn}`);

    const CMD_USER_QUERY = 'C:1:DATA QUERY USERINFO';
    const hasUserQuery = this.getCommandQueue().some((cmd) => cmd.includes(CMD_USER_QUERY));
    if (!hasUserQuery) {
      this.getCommandQueue().push(CMD_USER_QUERY);
      console.log(`[ensure-Users-Fetched] [user queued] SN=${this.sn}`);
    } else {
      console.log(`[ensure-Users-Fetched] [user already queued] SN=${this.sn}`);
    }

    return this.getUsers();
  }

  recordSentCommand(cmd, remote) {
    const list = this.getSentCommands();
    const ts = new Date().toISOString();

    list.push({
      id: ZKDevice.globalCommandId++,
      cmd,
      queuedAt: ts,
      sentAt: ts,
      deliveredAt: null,
      bytesSent: null,
      respondedAt: null,
      staleAt: null,
      remote: remote || null,
    });

    if (list.length > 500) {
      list.splice(0, list.length - 500);
    }
  }

  markDelivered(ids, bytes) {
    const list = this.getSentCommands();
    if (!list) return;

    const ts = new Date().toISOString();
    for (const rec of list) {
      if (ids.includes(rec.id)) {
        rec.deliveredAt = ts;
        rec.bytesSent = bytes;
      }
    }
  }

  recordCDataEvent(summary) {
    const arr = this.getCDataEvents();
    arr.push(summary);

    if (arr.length > 300) {
      arr.splice(0, arr.length - 300);
    }

    const cmds = this.getSentCommands();
    if (cmds) {
      for (const c of cmds) {
        if (
          c.deliveredAt &&
          !c.respondedAt &&
          !c.postSeenAfterDelivery &&
          c.deliveredAt <= summary.at
        ) {
          c.postSeenAfterDelivery = true;
        }
      }
    }
  }

  recordPoll(remote, queueBefore, deliveredCount) {
    const arr = this.getPollHistory();

    arr.push({ at: new Date().toISOString(), remote, queueBefore, deliveredCount });

    if (arr.length > 200) {
      arr.splice(0, arr.length - 200);
    }
  }

  markStaleCommands() {
    const list = this.getSentCommands();
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

  buildFetchCommand() {
    const st = ZKDevice.deviceState.get(this.sn);
    const now = new Date();
    const end = fmtYmdHms(now);
    let start;

    if (st?.lastStamp) {
      const raw = String(st.lastStamp).trim();
      let parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
      if (isNaN(parsed.getTime())) {
        const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
        if (m) {
          const [_, Y, M, D, h, i, s] = m;
          parsed = new Date(Number(Y), Number(M) - 1, Number(D), Number(h), Number(i), Number(s));
        }
      }
      if (isNaN(parsed.getTime())) parsed = now;
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
}

module.exports = ZKDevice;
