// Optional legacy SDK connectivity (TCP 4370).
// This may not work on all SenseFace 3A firmwares; prefer HTTP push if unsure.

const ZKLib = require("node-zklib");
const { deviceIp, devicePort, deviceTimeout } = require("./config");

class ZKDevice {
	constructor() {
		this.zk = null;
		this.connected = false;
		this.listeners = new Set();
	}

	async connect() {
		if (this.connected) return true;
		this.zk = new ZKLib(deviceIp, devicePort, deviceTimeout, 5099);

		try {
			console.log(
				"Connecting to ZK device at",
				deviceIp,
				":",
				devicePort
			);
			await this.zk.createSocket();
			this.connected = true;

			// Real-time logs (if supported by firmware)
			this.zk.getRealTimeLogs((data) => {
				for (const cb of this.listeners) {
					try {
						cb(data);
					} catch (e) {
						console.error("listener error:", e);
					}
				}
			});

			return true;
		} catch (e) {
			console.error("ZK SDK connect failed:", e.message || e);
			this.connected = false;
			this.zk = null;
			return false;
		}
	}

	async disconnect() {
		if (!this.zk) return;
		try {
			await this.zk.disconnect();
		} catch (_) {}
		this.zk = null;
		this.connected = false;
	}

	onRealTime(cb) {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	async getUsers() {
		if (!this.connected) throw new Error("Not connected");
		const res = await this.zk.getUsers();
		return res?.data || [];
	}

	async getAttendances({ clear = false } = {}) {
		if (!this.connected) throw new Error("Not connected");
		const res = await this.zk.getAttendances();
		const logs = res?.data || [];
		if (clear && logs.length) {
			await this.zk.clearAttendanceLog();
		}
		return logs;
	}
}

module.exports = new ZKDevice();
