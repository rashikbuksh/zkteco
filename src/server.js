const express = require("express");
const { port } = require("./config");
const { parseCData } = require("./iclock-parser");

const app = express();

app.use("/", (req, res, next) => {
	console.log(`${req.method} -  ${req.url}`);
	next();
});

// JSON for normal API routes
app.use(express.json());

// Text parser for iClock push (SenseFace 3A posts text/plain)
app.use("/iclock", express.text({ type: "*/*", limit: "10mb" }));

// In-memory store for demo; replace with your DB
// user id, device sn, timestamp, punch type, etc.
const pushedLogs = [];

// Health
app.get("/health", (req, res) => {
	res.json({
		ok: true,
		timestamp: new Date().toISOString(),
	});
});

// --- iClock/ADMS Push endpoints ---
// Device should be configured to: http://<your-ip>:3000/iclock/

// Heartbeat/command pull
app.get("/iclock/getrequest", (req, res) => {
	// Query often includes SN=<serial>, OPTION, etc.
	// You can return pending "C:..." lines for commands. For now, return empty.
	res.status(200).send("");
});

// Attendance data push
app.post("/iclock/cdata", (req, res) => {
	const sn = req.query.SN || req.query.sn || ""; // device serial number

	const raw = req.body || "";
	const table = req.query.table || ""; // sometimes included

	const items = parseCData(raw).map((e) => ({
		...e,
		sn,
		table,
		receivedAt: new Date().toISOString(),
	}));

	// Persist
	pushedLogs.push(...items);

	// Log a small preview
	const preview = items
		.slice(0, 3)
		.map((i) => i.raw || `${i.type}:${i.pin || ""}`)
		.join("\n");

	// Important: device expects "OK" to acknowledge receipt
	res.status(200).send("OK");
});

app.get("/iclock/ping", (req, res) => {
	// get ip from req
	const ip = req.ip;
	const sn = req.query.SN || req.query.sn || ""; // device serial number

	console.log("Ping from", sn, "at", ip);

	res.status(200).send({
		ip,
		sn,
		Timestamp: new Date().toISOString(),
	});
});

// Optional: Some firmwares send device info to /iclock/devicecmd or /iclock/fdata
app.post("/iclock/devicecmd", (req, res) => {
	console.log("devicecmd:", req.body);
	res.status(200).send("OK");
});
app.post("/iclock/fdata", (req, res) => {
	// For photo/template payloads if enabled (not always used)
	console.log("fdata len:", (req.body || "").length);
	res.status(200).send("OK");
});

// Query pushed logs
app.get("/api/push/logs", (req, res) => {
	const { sn, type } = req.query;
	let data = pushedLogs;
	if (sn) data = data.filter((x) => x.sn === sn);
	if (type) data = data.filter((x) => x.type === String(type).toUpperCase());
	res.json({ count: data.length, logs: data });
});

app.listen(port, () => {
	console.log(`SenseFace 3A server listening on http://localhost:${port}`);
});
