// Parses iClock/ADMS push bodies from ZKTeco devices (SenseFace 3A compatible).
// ATTLOG formats vary by firmware. We try to be flexible with separators.

function splitLines(raw) {
	if (!raw) return [];

	return String(raw)
		.replace(/\r/g, "\n")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

function splitFields(line) {
	// Try comma, tab, or space separation while preserving empty fields
	// Return array of fields
	if (line.includes(",")) return line.split(",").map((x) => x.trim());
	if (line.includes("\t")) return line.split("\t").map((x) => x.trim());
	// Collapse multiple spaces to one, then split
	return line
		.replace(/\s+/g, " ")
		.split(" ")
		.map((x) => x.trim());
}

/*
Common ATTLOG line patterns seen in the wild:
- "ATTLOG  123   2024-09-28 09:12:33  0   7   0   0   0"
  columns: [tag, pin, timestamp, status, verify, workcode, r1, r2, ...]
- "ATTLOG,123,2024-09-28 09:12:33,0,7,0"
- "ATTLOG\t123\t2024-09-28 09:12:33\t0\t7\t0"
We normalize to:
{
  type: 'ATTLOG',
  pin: '123',
  timestamp: '2024-09-28T09:12:33Z' (no TZ fix here; you can adjust later),
  status: 0,           // 0: check-in, 1: check-out (varies by policy)
  verify: 7,           // verify mode (e.g., face/fp/card/pwd)
  workcode: '0',       // optional
  raw: originalLine
}
*/

function parseATTLOG(fields) {
	// first field is "ATTLOG"
	const tag = fields[0].toUpperCase();
	if (tag !== "ATTLOG") return null;

	const pin = fields[1] ?? "";
	const ts = fields[2] ?? ""; // "YYYY-MM-DD HH:mm:ss"
	// Reconstruct ISO if possible
	const timestamp = ts.includes(" ")
		? new Date(ts.replace(" ", "T")).toISOString()
		: ts;

	const status = Number(fields[3] ?? "0");
	const verify = Number(fields[4] ?? "0");
	const workcode = fields[5] ?? "";

	return {
		type: "ATTLOG",
		pin: String(pin),
		timestamp,
		status,
		verify,
		workcode: String(workcode),
		raw: fields.join("\t"),
	};
}

function parseOPLOG(fields) {
	// Some devices send OPLOG lines with operation records
	// Format varies; keep raw
	return {
		type: "OPLOG",
		raw: fields.join("\t"),
	};
}

function parseCData(raw) {
	// Console Output: raw body: Hello\nWorld\nJavaScript
	// Returned Array: ["Hello", "World", "JavaScript"]

	// Console Output: raw body: Line1\r\nLine2\r\nLine3
	// Returned Array: ["Line1", "Line2", "Line3"]

	const lines = splitLines(raw);

	const entries = [];

	for (const line of lines) {
		// Ignore non-data headers like "STAMP=..." unless you want to track them
		if (/^STAMP=/i.test(line)) continue;

		const fields = splitFields(line);
		if (!fields.length) continue;

		const tag = fields[0].toUpperCase();

		if (tag === "ATTLOG") {
			const e = parseATTLOG(fields);
			if (e) entries.push(e);
			continue;
		}

		if (tag === "OPLOG") {
			entries.push(parseOPLOG(fields));
			continue;
		}

		// Unrecognized line, capture as raw
		entries.push({ type: "UNKNOWN", raw: line });
	}

	return entries;
}

module.exports = { parseCData };
