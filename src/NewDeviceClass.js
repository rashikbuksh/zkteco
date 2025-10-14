'use strict';

const { DEFAULT_LOOKBACK_HOURS, ICLOCK_COMMAND } = require('./config');
const { fmtYmdHms } = require('./utils');

/**
 * @constant {number} STALE_SECONDS - Number of seconds after which a command is considered stale
 */
var STALE_SECONDS = Number(process.env.STALE_SECONDS || 90);

/**
 * @constant {number} defaultLookbackHours - Default number of hours to look back for logs
 */
var defaultLookbackHours = DEFAULT_LOOKBACK_HOURS;

/**
 * @constant {string} commandSyntax - Command syntax to use for queries
 */
var commandSyntax = String(ICLOCK_COMMAND || 'DATA_QUERY').toUpperCase();

/**
 * Device class for managing ZKTeco device interactions
 * @constructor
 */
function Device(sn) {
  if (!(this instanceof Device)) {
    return new Device(sn);
  }

  if (!sn) {
    throw new Error('Serial number is required');
  }

  this._sn = sn;
  this._commandQueue = new Map([[sn, []]]);
  this._usersByDevice = new Map([[sn, new Map()]]);
  this._sentCommands = new Map([[sn, []]]);
  this._cdataEvents = new Map([[sn, []]]);
  this._pollHistory = new Map([[sn, []]]);
  this._deviceState = new Map([
    [
      sn,
      {
        lastSeenAt: null,
        lastStamp: null,
        lastUserSyncAt: null,
      },
    ],
  ]);
  this._globalCommandId = 1;
}

Device.prototype.getSN = function () {
  return this._sn;
};

Device.prototype.getCommandQueue = function () {
  return this._commandQueue.get(this._sn) || [];
};

Device.prototype.getUsers = function () {
  return this._usersByDevice.get(this._sn) || new Map();
};

Device.prototype.getSentCommands = function () {
  return this._sentCommands.get(this._sn) || [];
};

Device.prototype.getCDataEvents = function () {
  return this._cdataEvents.get(this._sn) || [];
};

Device.prototype.getPollHistory = function () {
  return this._pollHistory.get(this._sn) || [];
};

Device.prototype.setDeviceState = function (options) {
  options = options || {};
  var state = this._deviceState.get(this._sn);
  if (!state) return;

  var ts = new Date().toISOString();
  var newState = Object.assign({}, state);

  if (options.updateLastSeen) newState.lastSeenAt = ts;
  if (options.updateLastUserSync) newState.lastUserSyncAt = ts;
  if (options.updateLastStamp) newState.lastStamp = options.updateLastStamp;

  this._deviceState.set(this._sn, newState);
  return newState;
};

Device.prototype.ensureUsersFetched = function () {
  var users = this.getUsers();
  if (users.size > 0) return users;

  var CMD_USER_QUERY = 'C:1:DATA QUERY USERINFO';
  var queue = this.getCommandQueue();

  if (
    !queue.some(function (cmd) {
      return cmd.includes(CMD_USER_QUERY);
    })
  ) {
    queue.push(CMD_USER_QUERY);
    console.log('[Device:' + this._sn + '] Queued user fetch command');
  }

  return users;
};

Device.prototype.recordSentCommand = function (cmd, remote) {
  var list = this.getSentCommands();
  var ts = new Date().toISOString();

  list.push({
    id: this._globalCommandId++,
    cmd: cmd,
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
};

Device.prototype.markDelivered = function (ids, bytes) {
  var list = this.getSentCommands();
  if (!list || !list.length) return;

  var ts = new Date().toISOString();
  var self = this;

  list.forEach(function (rec) {
    if (ids.includes(rec.id)) {
      rec.deliveredAt = ts;
      rec.bytesSent = bytes;
    }
  });
};

Device.prototype.recordCDataEvent = function (summary) {
  if (!summary) return;

  var events = this.getCDataEvents();
  events.push(Object.assign({ timestamp: new Date().toISOString() }, summary));

  if (events.length > 300) {
    events.splice(0, events.length - 300);
  }

  var cmds = this.getSentCommands();
  if (cmds && cmds.length) {
    cmds.forEach(function (cmd) {
      if (
        cmd.deliveredAt &&
        !cmd.respondedAt &&
        !cmd.postSeenAfterDelivery &&
        cmd.deliveredAt <= summary.at
      ) {
        cmd.postSeenAfterDelivery = true;
      }
    });
  }
};

Device.prototype.recordPoll = function (remote, queueBefore, deliveredCount) {
  var history = this.getPollHistory();

  history.push({
    at: new Date().toISOString(),
    remote: remote,
    queueBefore: queueBefore,
    deliveredCount: deliveredCount,
  });

  if (history.length > 200) {
    history.splice(0, history.length - 200);
  }
};

Device.prototype.markStaleCommands = function () {
  var list = this.getSentCommands();
  if (!list || !list.length) return;

  var now = Date.now();
  var staleThreshold = STALE_SECONDS * 1000;

  list.forEach(function (cmd) {
    if (cmd.deliveredAt && !cmd.respondedAt && !cmd.staleAt) {
      var age = now - new Date(cmd.deliveredAt).getTime();
      if (age > staleThreshold) {
        cmd.staleAt = new Date().toISOString();
      }
    }
  });
};

Device.prototype._parseDateTime = function (dateStr) {
  var parsed = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T'));

  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  var m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6])
    );
  }

  return null;
};

Device.prototype._buildCommandString = function (start, end) {
  switch (commandSyntax) {
    case 'DATA_QUERY':
      return 'C:1:DATA QUERY ATTLOG StartTime=' + start + ' EndTime=' + end;
    case 'GET_ATTLOG':
      return 'C:1:GET ATTLOG StartTime=' + start + ' EndTime=' + end;
    case 'ATTLOG':
      return 'C:1:ATTLOG';
    default:
      return 'C:1:DATA QUERY ATTLOG StartTime=' + start + ' EndTime=' + end;
  }
};

Device.prototype.buildFetchCommand = function () {
  var state = this._deviceState.get(this._sn);
  var now = new Date();
  var end = fmtYmdHms(now);
  var start;

  if (state && state.lastStamp) {
    var raw = String(state.lastStamp).trim();
    var parsed = this._parseDateTime(raw);

    if (!parsed || isNaN(parsed.getTime())) {
      parsed = now;
    }

    start = fmtYmdHms(new Date(parsed.getTime() - 1000));
  } else {
    start = fmtYmdHms(new Date(now.getTime() - defaultLookbackHours * 3600 * 1000));
  }

  return this._buildCommandString(start, end);
};

module.exports = Device;
