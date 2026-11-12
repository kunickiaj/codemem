import { generateKeyPairSync } from "node:crypto";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";

/**
 * A fresh real Ed25519 device key in SSH wire form, with its fingerprint. Account
 * management derives the canonical key ID of every link signer, so fixture signers
 * need a parseable key rather than a placeholder string.
 */
export function fixtureDeviceKey(): { publicKey: string; fingerprint: string } {
	const { publicKey: key } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(key.export({ type: "spki", format: "der" })).subarray(-32);
	const wire = Buffer.alloc(51);
	wire.writeUInt32BE(11, 0);
	wire.write("ssh-ed25519", 4);
	wire.writeUInt32BE(32, 15);
	raw.copy(wire, 19);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return { publicKey, fingerprint: fingerprintPublicKey(publicKey) };
}
