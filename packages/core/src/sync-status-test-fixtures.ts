import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "./db.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import {
	ensureDeviceIdentity,
	generateKeypair,
	loadPublicKey,
	resolveKeyPaths,
} from "./sync-identity.js";

export const signingContexts = [
	"valid",
	"missing-private-key",
	"wrong-directory",
	"replaced-private-key",
	"device-mismatch",
	"fingerprint-mismatch",
	"missing-public-key",
] as const;
export type SigningContext = (typeof signingContexts)[number];

/** Real v1 retained proof, generated signer pairs, and untouched direct/manual controls. */
export async function seedSigningStatusFixture(db: Database, root: string) {
	const keysDir = join(root, "keys");
	const [deviceId] = ensureDeviceIdentity(db, { keysDir, deviceId: "local-device" });
	const publicKey = loadPublicKey(keysDir);
	const otherKeysDir = join(root, "other-keys");
	mkdirSync(otherKeysDir);
	generateKeypair(...resolveKeyPaths(otherKeysDir));
	const peerPublicKey = loadPublicKey(otherKeysDir);
	if (!publicKey || !peerPublicKey) throw new Error("Missing generated test keys");
	const now = "2026-01-01T00:00:00.000Z";
	for (const peerId of ["peer-device", "direct-peer"]) {
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, name, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)",
		).run(peerId, peerId, peerPublicKey, fingerprintPublicKey(peerPublicKey), now);
	}
	for (const [scopeId, authority] of [
		["managed", "coordinator"],
		["manual", "manual"],
		["manual-denied", "manual"],
	] as const) {
		db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
			VALUES (?, ?, 'user', ?, ?, ?, 1, 'active', ?, ?)`).run(
			scopeId,
			scopeId,
			authority,
			authority === "coordinator" ? "coordinator-1" : null,
			authority === "coordinator" ? "group-1" : null,
			now,
			now,
		);
		const members = scopeId === "manual-denied" ? [deviceId] : [deviceId, "peer-device"];
		for (const member of members) {
			db.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
				VALUES (?, ?, 'member', 'active', 1, ?)`).run(scopeId, member, now);
		}
		db.prepare(`INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, last_acked_cursor, updated_at)
			VALUES ('peer-device', ?, '2026-01-01T00:00:01Z|received', NULL, ?)`).run(scopeId, now);
	}
	await refreshTestScopeRows(db, { [deviceId]: publicKey, "peer-device": peerPublicKey });
	return { keysDir, otherKeysDir, deviceId };
}

export function selectSigningContext(
	db: Database,
	fixture: Awaited<ReturnType<typeof seedSigningStatusFixture>>,
	context: SigningContext,
) {
	const [privatePath, publicPath] = resolveKeyPaths(fixture.keysDir);
	if (context === "missing-private-key") rmSync(privatePath);
	if (context === "missing-public-key") rmSync(publicPath);
	if (context === "replaced-private-key") {
		writeFileSync(privatePath, readFileSync(resolveKeyPaths(fixture.otherKeysDir)[0]));
	}
	if (context === "device-mismatch") {
		db.prepare("UPDATE sync_device SET device_id = 'other-device'").run();
	}
	if (context === "fingerprint-mismatch") {
		db.prepare("UPDATE sync_device SET fingerprint = 'wrong-fingerprint'").run();
	}
	return context === "wrong-directory" ? fixture.otherKeysDir : fixture.keysDir;
}

/** Snapshot every table, including cursors and reset boundaries, to catch read-side writes. */
export function diagnosticDatabaseSnapshot(db: Database) {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all() as Array<{ name: string }>;
	return tables.map(({ name }) => ({
		name,
		rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
	}));
}

export function diagnosticKeySnapshot(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const directory of ["keys", "other-keys"]) {
		for (const file of readdirSync(join(root, directory))) {
			files[`${directory}/${file}`] = readFileSync(join(root, directory, file)).toString("base64");
		}
	}
	return files;
}

export function expectedDiagnosticScopes(context: SigningContext) {
	if (context === "device-mismatch") return [];
	const scopes = [{ scope_id: "manual", bootstrapped: true }];
	if (context === "valid" || context === "missing-public-key") {
		scopes.unshift({ scope_id: "managed", bootstrapped: true });
	}
	return scopes;
}
