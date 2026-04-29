import { connect } from "../../packages/core/src/db.ts";
import { ensureDeviceIdentity, loadPublicKey } from "../../packages/core/src/index.ts";

function parseArgs(argv: string[]) {
	let dbPath = "";
	let keysDir = "";
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db-path") {
			dbPath = String(argv[index + 1] ?? "").trim();
			index += 1;
		} else if (arg === "--keys-dir") {
			keysDir = String(argv[index + 1] ?? "").trim();
			index += 1;
		}
	}
	if (!dbPath || !keysDir) {
		throw new Error("--db-path and --keys-dir are required");
	}
	return { dbPath, keysDir };
}

const { dbPath, keysDir } = parseArgs(process.argv);
const db = connect(dbPath);

try {
	const [deviceId, fingerprint] = ensureDeviceIdentity(db, { keysDir });
	const publicKey = loadPublicKey(keysDir);
	console.log(
		JSON.stringify(
			{
				device_id: deviceId,
				fingerprint,
				public_key: publicKey,
			},
			null,
			2,
		),
	);
} finally {
	db.close();
}
