// Preload in the fixture process so an accidental service call fails locally.
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");

function denyNetwork() {
	throw new Error("sdk compatibility fixture forbids network");
}

globalThis.fetch = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
syncBuiltinESMExports();
