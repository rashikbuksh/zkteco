require('dotenv').config();

function toBoolean(value) {
	return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

module.exports = {
	PORT: Number(process.env.PORT || 5099),
	PULL_MODE: toBoolean(process.env.PULL_MODE),
	USE_CRLF: toBoolean(process.env.USE_CRLF),
	DEFAULT_LOOKBACK_HOURS: Number(process.env.DEFAULT_LOOKBACK_HOURS || 48),
	ICLOCK_COMMAND: process.env.ICLOCK_COMMAND || 'ATTLOG',
};
