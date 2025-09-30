// // Parses iClock/ADMS push bodies from ZKTeco devices (SenseFace 3A compatible).
// // ATTLOG formats vary by firmware. We try to be flexible with separators.

// function splitLines(raw) {
// 	if (!raw) return [];

// 	return String(raw)
// 		.replace(/\r/g, "\n")
// 		.split("\n")
// 		.map((l) => l.trim())
// 		.filter(Boolean);
// }

// function splitFields(line) {
// 	// Try comma, tab, or space separation while preserving empty fields
// 	// Return array of fields
// 	if (line.includes(",")) return line.split(",").map((x) => x.trim());
// 	if (line.includes("\t")) return line.split("\t").map((x) => x.trim());
// 	// Collapse multiple spaces to one, then split
// 	return line
// 		.replace(/\s+/g, " ")
// 		.split(" ")
// 		.map((x) => x.trim());
// }

// /*
// Common ATTLOG line patterns seen in the wild:
// - "ATTLOG  123   2024-09-28 09:12:33  0   7   0   0   0"
//   columns: [tag, pin, timestamp, status, verify, workcode, r1, r2, ...]
// - "ATTLOG,123,2024-09-28 09:12:33,0,7,0"
// - "ATTLOG\t123\t2024-09-28 09:12:33\t0\t7\t0"
// We normalize to:
// {
//   type: 'ATTLOG',
//   pin: '123',
//   timestamp: '2024-09-28T09:12:33Z' (no TZ fix here; you can adjust later),
//   status: 0,           // 0: check-in, 1: check-out (varies by policy)
//   verify: 7,           // verify mode (e.g., face/fp/card/pwd)
//   workcode: '0',       // optional
//   raw: originalLine
// }
// */

// function parseATTLOG(fields) {
// 	// first field is "ATTLOG"
// 	const tag = fields[0].toUpperCase();
// 	if (tag !== "ATTLOG") return null;

// 	const pin = fields[1] ?? "";
// 	const ts = fields[2] ?? ""; // "YYYY-MM-DD HH:mm:ss"
// 	// Reconstruct ISO if possible
// 	const timestamp = ts.includes(" ")
// 		? new Date(ts.replace(" ", "T")).toISOString()
// 		: ts;

// 	const status = Number(fields[3] ?? "0");
// 	const verify = Number(fields[4] ?? "0");
// 	const workcode = fields[5] ?? "";

// 	return {
// 		type: "ATTLOG",
// 		pin: String(pin),
// 		timestamp,
// 		status,
// 		verify,
// 		workcode: String(workcode),
// 		raw: fields.join("\t"),
// 	};
// }

// function parseOPLOG(fields) {
// 	// Some devices send OPLOG lines with operation records
// 	// Format varies; keep raw
// 	return {
// 		type: "OPLOG",
// 		raw: fields.join("\t"),
// 	};
// }

// function parseCData(raw) {
// 	// Console Output: raw body: Hello\nWorld\nJavaScript
// 	// Returned Array: ["Hello", "World", "JavaScript"]

// 	// Console Output: raw body: Line1\r\nLine2\r\nLine3
// 	// Returned Array: ["Line1", "Line2", "Line3"]

// 	const lines = splitLines(raw);

// 	const entries = [];

// 	for (const line of lines) {
// 		// Ignore non-data headers like "STAMP=..." unless you want to track them
// 		if (/^STAMP=/i.test(line)) continue;

// 		const fields = splitFields(line);
// 		if (!fields.length) continue;

// 		const tag = fields[0].toUpperCase();

// 		if (tag === "ATTLOG") {
// 			const e = parseATTLOG(fields);
// 			if (e) entries.push(e);
// 			continue;
// 		}

// 		if (tag === "OPLOG") {
// 			entries.push(parseOPLOG(fields));
// 			continue;
// 		}

// 		// Unrecognized line, capture as raw
// 		entries.push({ type: "UNKNOWN", raw: line });
// 	}

// 	return entries;
// }

// module.exports = { parseCData };

// Parses iClock/ADMS push bodies from ZKTeco devices (SenseFace 3A compatible).
// Handles both tagged lines (ATTLOG ...), and "plain" lines (PIN TIMESTAMP ...).
// Also parses USERINFO key=value lines.

function splitLines(raw) {
	return String(raw)
		.replace(/\r/g, "\n")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

function splitFields(line) {
	// Try comma, tab, or space separation while preserving empty fields
	if (line.includes(",")) return line.split(",").map((x) => x.trim());
	if (line.includes("\t")) return line.split("\t").map((x) => x.trim());
	return line
		.replace(/\s+/g, " ")
		.split(" ")
		.map((x) => x.trim());
}

// yyyy-mm-dd hh:mm:ss
function looksLikeYmdHms(s) {
	return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(String(s));
}

function toISO(ts) {
	if (!ts) return ts;
	// Accept "YYYY-MM-DD HH:mm:ss" or ISO-like "YYYY-MM-DDTHH:mm:ss"
	const norm = String(ts).includes(" ") ? ts.replace(" ", "T") : String(ts);
	const d = new Date(norm);
	return isNaN(d.getTime()) ? ts : d.toISOString();
}

/*
Normalized ATTLOG shape:
{
  type: 'ATTLOG',
  pin: '123',
  timestamp: '2025-09-30T09:12:33.000Z',
  status: 0,
  verify: 7,
  workcode: '0',
  raw: originalLine
}
*/

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

// Plain format (common on Android): "PIN TIMESTAMP STATUS VERIFY WORKCODE r1 r2 r3 r4 r5 rid"
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
	return {
		type: "OPLOG",
		raw: fields.join("\t"),
	};
}

// USERINFO lines typically look like:
// "USERINFO\tPIN=1\tName=John Doe\tPrivilege=0\tCard=123456\t..."
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

function parseUSERINFO(fields) {
	// fields[0] is "USERINFO" or "USER"
	const kv = parseKeyValuePairs(fields.slice(1));
	const pin = kv.PIN || kv.Pin || kv.pin || "";
	const name = kv.Name || kv.Username || kv.NAME || "";
	const card = kv.Card || kv.CardNo || kv.Badgenumber || "";
	const privilege = kv.Privilege || kv.Pri || kv.Role || "";
	const depart = kv.Dept || kv.Department || "";
	return {
		type: "USERINFO",
		pin: String(pin),
		name,
		card: String(card),
		privilege: String(privilege),
		department: String(depart),
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
