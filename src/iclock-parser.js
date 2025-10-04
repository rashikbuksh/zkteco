

function splitLines(raw) {
	return String(raw)
		.replace(/\r/g, "\n")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

function splitFields(line) {
	if (line.includes(",")) return line.split(",").map((x) => x.trim());
	if (line.includes("\t")) return line.split("\t").map((x) => x.trim());
	return line
		.replace(/\s+/g, " ")
		.split(" ")
		.map((x) => x.trim());
}

function looksLikeYmdHms(s) {
	return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(String(s));
}
function toISO(ts) {
	if (!ts) return ts;
	const norm = String(ts).includes(" ") ? ts.replace(" ", "T") : String(ts);
	const d = new Date(norm);
	return isNaN(d.getTime()) ? ts : d.toISOString();
}

// Tagged format: "ATTLOG PIN TIMESTAMP STATUS VERIFY WORKCODE ..."
function parseTaggedATTLOG(fields) {
	const pin = fields[1] ?? "";
	const ts = fields[2] ?? "";
	const status = Number(fields[3] ?? "0");
	const verify = Number(fields[4] ?? "0");
	const workcode = fields[5] ?? "";
	return {
		type: "ATTLOG",
		pin: String(pin),
		timestamp: toISO(ts),
		status,
		verify,
		workcode: String(workcode),
		raw: fields.join("\t"),
	};
}

// Plain format (Android): "PIN TIMESTAMP STATUS VERIFY WORKCODE r1 r2 r3 r4 r5 rid"
function parsePlainATTLOG(fields) {
	const pin = fields[0] ?? "";
	const ts = fields[1] ?? "";
	const status = Number(fields[2] ?? "0");
	const verify = Number(fields[3] ?? "0");
	const workcode = fields[4] ?? "";
	return {
		type: "ATTLOG",
		pin: String(pin),
		timestamp: toISO(ts),
		status,
		verify,
		workcode: String(workcode),
		raw: fields.join("\t"),
	};
}

function parseOPLOG(fields) {
	return { type: "OPLOG", raw: fields.join("\t") };
}

function parseKeyValuePairs(parts) {
	const obj = {};
	for (const p of parts) {
		const idx = p.indexOf("=");
		if (idx > 0) {
			const k = p.slice(0, idx).trim();
			const v = p.slice(idx + 1).trim();
			obj[k] = v;
		}
	}
	return obj;
}

// USERINFO\tPIN=1\tName=John Doe\tPrivilege=0\tCard=123456\tUID=1001\t...
function parseUSERINFO(fields) {
	const kv = parseKeyValuePairs(fields.slice(1));
	const pin = kv.PIN || kv.Pin || kv.pin || "";
	const name = kv.Name || kv.Username || kv.NAME || "";
	const card = kv.Card || kv.CardNo || kv.Badgenumber || "";
	const privilege = kv.Privilege || kv.Pri || kv.Role || "";
	const department = kv.Dept || kv.Department || kv.DEPT || "";
	const uid = kv.UID || kv.UserID || kv.UserId || kv.userid || kv.uid || ""; // internal device user id if present
	return {
		type: "USERINFO",
		pin: String(pin),
		name,
		card: String(card),
		privilege: String(privilege),
		department: String(department),
		uid: String(uid),
		raw: fields.join("\t"),
		kv,
	};
}

function parseCData(raw) {
	const lines = splitLines(raw);
	const entries = [];

	for (const line of lines) {
		if (/^STAMP=/i.test(line)) continue;

		const fields = splitFields(line);
		if (!fields.length) continue;

		const tag = fields[0].toUpperCase();

		if (tag === "ATTLOG") {
			entries.push(parseTaggedATTLOG(fields));
			continue;
		}

		// Heuristic: plain ATTLOG (PIN + TIMESTAMP as first two fields)
		if (fields.length >= 2 && looksLikeYmdHms(fields[1])) {
			entries.push(parsePlainATTLOG(fields));
			continue;
		}

		if (tag === "OPLOG") {
			entries.push(parseOPLOG(fields));
			continue;
		}

		if (tag === "USERINFO" || tag === "USER") {
			entries.push(parseUSERINFO(fields));
			continue;
		}

		entries.push({ type: "UNKNOWN", raw: line });
	}

	return entries;
}

module.exports = { parseCData };
