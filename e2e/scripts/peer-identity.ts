import { connect } from "../../packages/core/src/db.ts";
import { ensureDeviceIdentity, loadPublicKey } from "../../packages/core/src/index.ts";

const db = connect("/data/mem.sqlite");
try {
	const [deviceId, fingerprint] = ensureDeviceIdentity(db, { keysDir: "/keys" });
	const publicKey = loadPublicKey("/keys");
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
