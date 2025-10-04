require("dotenv").config();

// module.exports = {
// 	port: Number(process.env.PORT || 3000),
// 	deviceIp: process.env.DEVICE_IP || "192.168.10.2",
// 	devicePort: Number(process.env.DEVICE_PORT || 4370),
// 	deviceTimeout: Number(process.env.DEVICE_TIMEOUT || 10000),
// };

module.exports = {
	PORT: Number(process.env.PORT || 5099),
	PULL_MODE: ["1", "true", "yes"].includes(
		String(process.env.PULL_MODE || "").toLowerCase()
	),
	DEFAULT_LOOKBACK_HOURS: Number(process.env.DEFAULT_LOOKBACK_HOURS || 48),
	ICLOCK_COMMAND: process.env.ICLOCK_COMMAND || "ATTLOG",
	USE_CRLF: ["1", "true", "yes"].includes(
		String(process.env.USE_CRLF || "").toLowerCase()
	),
};
