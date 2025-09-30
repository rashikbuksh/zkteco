// const express = require("express");
// const { port } = require("./config");
// const { parseCData } = require("./iclock-parser");

// const app = express();

// app.use("/", (req, res, next) => {
// 	console.log(`${req.method} -  ${req.url}`);
// 	next();
// });

// // JSON for normal API routes
// app.use(express.json());

// // Text parser for iClock push (SenseFace 3A posts text/plain)
// app.use("/iclock", express.text({ type: "*/*", limit: "10mb" }));

// // In-memory store for demo; replace with your DB
// // user id, device sn, timestamp, punch type, etc.
// const pushedLogs = [];

// // Health
// app.get("/health", (req, res) => {
// 	res.json({
// 		ok: true,
// 		timestamp: new Date().toISOString(),
// 	});
// });

// // --- iClock/ADMS Push endpoints ---
// // Device should be configured to: http://<your-ip>:3000/iclock/

// // Heartbeat/command pull
// app.get("/iclock/getrequest", (req, res) => {
// 	// Query often includes SN=<serial>, OPTION, etc.
// 	// You can return pending "C:..." lines for commands. For now, return empty.
// 	res.status(200).send("");
// });

// // Attendance data push
// app.post("/iclock/cdata", (req, res) => {
// 	console.log("body", req.body);
// 	const sn = req.query.SN || req.query.sn || ""; // device serial number

// 	const raw = req.body || "";
// 	const table = req.query.table || ""; // sometimes included

// 	const items = parseCData(raw).map((e) => ({
// 		...e,
// 		sn,
// 		table,
// 		receivedAt: new Date().toISOString(),
// 	}));

// 	// Persist
// 	pushedLogs.push(...items);

// 	// Log a small preview
// 	const preview = items
// 		.slice(0, 3)
// 		.map((i) => i.raw || `${i.type}:${i.pin || ""}`)
// 		.join("\n");

// 	// Important: device expects "OK" to acknowledge receipt
// 	res.status(200).send("OK");
// });

// app.get("/iclock/ping", (req, res) => {
// 	// get ip from req
// 	const ip = req.ip;
// 	const sn = req.query.SN || req.query.sn || ""; // device serial number

// 	console.log("Ping from", sn, "at", ip);

// 	res.status(200).send({
// 		ip,
// 		sn,
// 		Timestamp: new Date().toISOString(),
// 	});
// });

// // Optional: Some firmwares send device info to /iclock/devicecmd or /iclock/fdata
// app.post("/iclock/devicecmd", (req, res) => {
// 	console.log("devicecmd:", req.body);
// 	res.status(200).send("OK");
// });
// app.post("/iclock/fdata", (req, res) => {
// 	// For photo/template payloads if enabled (not always used)
// 	console.log("fdata len:", (req.body || "").length);
// 	res.status(200).send("OK");
// });

// // Query pushed logs
// app.get("/api/push/logs", (req, res) => {
// 	const { sn, type } = req.query;
// 	let data = pushedLogs;
// 	if (sn) data = data.filter((x) => x.sn === sn);
// 	if (type) data = data.filter((x) => x.type === String(type).toUpperCase());
// 	res.json({ count: data.length, logs: data });
// });

// app.listen(port, () => {
// 	console.log(`SenseFace 3A server listening on http://localhost:${port}`);
// });

const express = require("express");
const { parseCData } = require("./iclock-parser");

const {
	PORT,
	PULL_MODE,
	DEFAULT_LOOKBACK_HOURS,
	ICLOCK_COMMAND,
} = require("./config");

const app = express();

app.use(express.json());

// app.use("/", (req, res, next) => {
// 	console.log(`${req.method} -  ${req.url}`);
// 	next();
// });

app.use("/iclock", express.text({ type: "*/*", limit: "10mb" }));

// In-memory stores (replace with DB in prod)
const pushedLogs = []; // raw items (ATTLOG, USERINFO, OPLOG, UNKNOWN)
const deviceState = new Map(); // sn -> { lastStamp, lastSeenAt }
const commandQueue = new Map(); // sn -> [ 'C: ...' ]
const usersByDevice = new Map(); // sn -> Map(pin -> user)

// Config
const port = Number(PORT || 5099);
const pullMode = ["1", "true", "yes"].includes(
	String(PULL_MODE || "").toLowerCase()
);
const defaultLookbackHours = Number(DEFAULT_LOOKBACK_HOURS || 48);
const commandSyntax = String(ICLOCK_COMMAND || "DATA_QUERY").toUpperCase();

// Utilities
function ensureQueue(sn) {
	if (!commandQueue.has(sn)) commandQueue.set(sn, []);
	return commandQueue.get(sn);
}
function ensureUserMap(sn) {
	if (!usersByDevice.has(sn)) usersByDevice.set(sn, new Map());
	return usersByDevice.get(sn);
}

function fmtYmdHms(d) {
	const pad = (n) => String(n).padStart(2, "0");
	const yyyy = d.getFullYear();
	const mm = pad(d.getMonth() + 1);
	const dd = pad(d.getDate());
	const hh = pad(d.getHours());
	const mi = pad(d.getMinutes());
	const ss = pad(d.getSeconds());
	return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}
function parseISOOrReturn(s) {
	const t = Date.parse(s);
	if (!isNaN(t)) return new Date(t);
	const d = new Date(String(s).replace(" ", "T"));
	return isNaN(d.getTime()) ? null : d;
}
function maxTimestampYmdHms(items) {
	let max = null;
	for (const it of items) {
		if (it.type !== "ATTLOG") continue;
		const d = parseISOOrReturn(it.timestamp);
		if (d && (!max || d > max)) max = d;
	}
	if (!max) return null;
	return fmtYmdHms(max);
}

function buildFetchCommand(sn) {
	const st = deviceState.get(sn);
	const now = new Date();
	const end = fmtYmdHms(now);
	let start;

	if (st?.lastStamp) {
		const last = parseISOOrReturn(st.lastStamp.replace(" ", "T"));
		const s = new Date((last?.getTime() || now.getTime()) - 1000);
		start = fmtYmdHms(s);
	} else {
		const s = new Date(now.getTime() - defaultLookbackHours * 3600 * 1000);
		start = fmtYmdHms(s);
	}

	switch (commandSyntax) {
		case "DATA_QUERY":
			return `C: DATA QUERY ATTLOG StartTime=${start} EndTime=${end}`;
		case "GET_ATTLOG":
			return `C: GET ATTLOG StartTime=${start} EndTime=${end}`;
		case "ATTLOG":
			return `C: ATTLOG`;
		default:
			return `C: DATA QUERY ATTLOG StartTime=${start} EndTime=${end}`;
	}
}

// Map verify codes to a human-friendly method.
// NOTE: codes vary by firmware. Adjust as needed for your device.
function verifyCodeToMethod(code) {
	const c = Number(code);
	const map = {
		0: "password",
		1: "fingerprint",
		2: "password",
		3: "card",
		4: "fingerprint+password",
		5: "card+password",
		6: "fingerprint+card",
		7: "fingerprint+card+password",
		8: "face",
		9: "face+password",
		10: "face+card",
		11: "face+card+password",
		12: "face+fingerprint",
		13: "face+fingerprint+password",
		14: "face+fingerprint+card",
		15: "face+fingerprint+card+password",
	};
	return map[c] || "unknown";
}

// Health
app.get("/health", (req, res) => {
	res.json({
		ok: true,
		devices: Array.from(deviceState.entries()).map(([sn, s]) => ({
			sn,
			lastStamp: s.lastStamp,
			lastSeenAt: s.lastSeenAt,
		})),
		users: Array.from(usersByDevice.entries()).map(([sn, m]) => ({
			sn,
			count: m.size,
		})),
		pullMode,
		commandSyntax,
	});
});

// iClock/ADMS endpoints
app.get("/iclock/ping", (req, res) => {
	const sn = req.query.SN || req.query.sn || "";
	const state = deviceState.get(sn) || {};
	state.lastSeenAt = new Date().toISOString();
	deviceState.set(sn, state);
	res.status(200).send("OK");
});

app.get("/iclock/getrequest", (req, res) => {
	const sn = req.query.SN || req.query.sn || "";
	const state = deviceState.get(sn) || {};
	state.lastSeenAt = new Date().toISOString();
	deviceState.set(sn, state);

	const queue = ensureQueue(sn);
	if (queue.length) {
		const body = queue.join("\n") + "\n";
		queue.length = 0;
		return res.status(200).send(body);
	}

	if (pullMode) {
		const cmd = buildFetchCommand(sn);
		return res.status(200).send(cmd);
	}

	return res.status(200).send("");
});

// Some firmwares probe with GET /iclock/cdata — acknowledge OK
app.get("/iclock/cdata", (req, res) => res.status(200).send("OK"));

// Device posts logs here in plain text
app.post("/iclock/cdata", (req, res) => {
	const sn = req.query.SN || req.query.sn || "";
	const table = req.query.table || req.query.options || "";
	const raw = req.body || "";
	const nowISO = new Date().toISOString();

	const items = parseCData(raw).map((e) => ({
		...e,
		sn,
		table,
		receivedAt: nowISO,
	}));

	// Persist + enrich
	for (const it of items) {
		if (it.type === "USERINFO") {
			// Store/merge user info by PIN
			const umap = ensureUserMap(sn);
			const pin = String(it.pin || "").trim();
			if (pin) {
				const existing = umap.get(pin) || {};
				umap.set(pin, { ...existing, ...it });
			}
		}
	}

	// Enrich ATTLOG with method
	const enriched = items.map((it) => {
		if (it.type === "ATTLOG") {
			return { ...it, method: verifyCodeToMethod(it.verify) };
		}
		return it;
	});

	pushedLogs.push(...enriched);

	console.log("pushedLogs: ", pushedLogs);

	// Update device lastStamp to newest ATTLOG timestamp we received
	const newest = maxTimestampYmdHms(enriched);
	const st = deviceState.get(sn) || {};
	if (newest) st.lastStamp = newest;
	st.lastSeenAt = nowISO;
	deviceState.set(sn, st);

	console.log(
		`cdata SN=${sn} items=${items.length} newest=${newest || "n/a"}`
	);
	res.status(200).send("OK");
});

// Admin/dev helpers

// Manually enqueue a pull for a device (one shot)
// Example: POST /api/device/pull?sn=VGU6244900359&hours=24
app.post("/api/device/pull", (req, res) => {
	const sn = req.query.sn || req.query.SN;
	if (!sn) return res.status(400).json({ error: "sn is required" });

	const lookback = Number(req.query.hours || defaultLookbackHours);
	const now = new Date();
	const start = new Date(now.getTime() - lookback * 3600 * 1000);
	const end = now;

	const cmd =
		commandSyntax === "DATA_QUERY"
			? `C: DATA QUERY ATTLOG StartTime=${fmtYmdHms(
					start
			  )} EndTime=${fmtYmdHms(end)}`
			: buildFetchCommand(sn);

	ensureQueue(sn).push(cmd);
	res.json({ ok: true, enqueued: cmd });
});

// Enqueue a user info pull (device will return USERINFO lines to /iclock/cdata)
app.post("/api/device/pull-users", (req, res) => {
	const sn = req.query.sn || req.query.SN;
	if (!sn) return res.status(400).json({ error: "sn is required" });

	// Common command for Android push protocol:
	const cmd = "C: DATA QUERY USERINFO";
	ensureQueue(sn).push(cmd);
	res.json({ ok: true, enqueued: cmd });
});

// Simplified view: attendance rows with only pin, timestamp, status, verify, method
app.get("/api/attendances", (req, res) => {
	const { sn } = req.query;
	let data = pushedLogs.filter((x) => x.type === "ATTLOG");
	if (sn) data = data.filter((x) => x.sn === sn);

	const simplified = data.map((x) => ({
		sn: x.sn,
		pin: x.pin,
		timestamp: x.timestamp,
		status: x.status,
		verify: x.verify,
		method: x.method || verifyCodeToMethod(x.verify),
	}));

	res.json({ count: simplified.length, logs: simplified });
});

// Users collected from USERINFO
app.get("/api/users", (req, res) => {
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
		name: u.name,
		card: u.card,
		privilege: u.privilege,
		department: u.department,
	}));
	res.json({ sn, count: users.length, users });
});

app.get("/api/push/logs", (req, res) => {
	const { sn, type } = req.query;
	let data = pushedLogs;
	if (sn) data = data.filter((x) => x.sn === sn);
	if (type) data = data.filter((x) => x.type === String(type).toUpperCase());
	res.json({ count: data.length, logs: data });
});

app.listen(port, () => {
	console.log(`Server listening on http://0.0.0.0:${port}`);
	console.log(
		"Device should be configured to http://<server-ip>:%d/iclock/",
		port
	);
	console.log(`pullMode=${pullMode} commandSyntax=${commandSyntax}`);
});
