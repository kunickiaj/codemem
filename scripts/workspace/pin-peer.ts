import { connect } from "../../packages/core/src/db.ts";

function parseArgs(argv: string[]) {
	let dbPath = "";
	let peerDeviceId = "";
	let fingerprint = "";
	let publicKey = "";
	let address = "";
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db-path") {
			dbPath = String(argv[index + 1] ?? "").trim();
			index += 1;
		} else if (arg === "--peer-device-id") {
			peerDeviceId = String(argv[index + 1] ?? "").trim();
			index += 1;
		} else if (arg === "--fingerprint") {
			fingerprint = String(argv[index + 1] ?? "").trim();
			index += 1;
		} else if (arg === "--public-key") {
			publicKey = String(argv[index + 1] ?? "").trim();
			index += 1;
		} else if (arg === "--address") {
			address = String(argv[index + 1] ?? "").trim();
			index += 1;
		}
	}
	if (!dbPath || !peerDeviceId || !fingerprint || !publicKey) {
		throw new Error(
			"--db-path, --peer-device-id, --fingerprint, and --public-key are required",
		);
	}
	return { dbPath, peerDeviceId, fingerprint, publicKey, address };
}

const { dbPath, peerDeviceId, fingerprint, publicKey, address } = parseArgs(process.argv);
const db = connect(dbPath);

try {
	const now = new Date().toISOString();
	const addressesJson = JSON.stringify(address ? [address] : []);
	db.prepare(
		`INSERT INTO sync_peers(
			peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at, last_seen_at
		 ) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(peer_device_id) DO UPDATE SET
			pinned_fingerprint = excluded.pinned_fingerprint,
			public_key = excluded.public_key,
			addresses_json = excluded.addresses_json,
			last_seen_at = excluded.last_seen_at`,
	).run(peerDeviceId, fingerprint, publicKey, addressesJson, now, now);
	console.log(JSON.stringify({ ok: true, peer_device_id: peerDeviceId }, null, 2));
} finally {
	db.close();
}
