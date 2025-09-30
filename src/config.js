require("dotenv").config();

module.exports = {
	port: Number(process.env.PORT || 3000),
	deviceIp: process.env.DEVICE_IP || "192.168.10.2",
	devicePort: Number(process.env.DEVICE_PORT || 4370),
	deviceTimeout: Number(process.env.DEVICE_TIMEOUT || 10000),
};
