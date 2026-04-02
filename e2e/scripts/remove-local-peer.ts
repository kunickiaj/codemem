import { connect } from "../../packages/core/src/db.ts";

const processRef = globalThis as typeof globalThis & {
	process: { argv: string[] };
};

function parseArgs(argv: string[]) {
	let dbPath = "/data/mem.sqlite";
	let peerDeviceId = "";
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db-path") {
			dbPath = String(argv[index + 1] ?? dbPath);
			index += 1;
		} else if (arg === "--peer-device-id") {
			peerDeviceId = String(argv[index + 1] ?? "").trim();
			index += 1;
		}
	}
	if (!peerDeviceId) throw new Error("--peer-device-id is required");
	return { dbPath, peerDeviceId };
}

const { dbPath, peerDeviceId } = parseArgs(processRef.process.argv);
const db = connect(dbPath);
try {
	const cursorResult = db.prepare("DELETE FROM replication_cursors WHERE peer_device_id = ?").run(peerDeviceId);
	const peerResult = db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(peerDeviceId);
	if (peerResult.changes < 1) throw new Error("peer not found");
	console.log(
		JSON.stringify({ ok: true, peer_device_id: peerDeviceId, removed_peer_rows: peerResult.changes, removed_cursor_rows: cursorResult.changes }, null, 2),
	);
} finally {
	db.close();
}
