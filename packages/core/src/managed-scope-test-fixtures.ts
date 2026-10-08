import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import type { CoordinatorScope } from "./coordinator-store-contract.js";
import type { Database } from "./db.js";
import { refreshScopeMembershipCache } from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import type { ScopeMembershipSnapshot } from "./scope-membership-snapshot.js";
import { ensureDeviceIdentity, fingerprintPublicKey, loadPublicKey } from "./sync-identity.js";
import { seedMixedScopeFixture } from "./test-utils.js";

export function enrollFixtureSigningKey(db: Database, keysDir: string, deviceId: string): string {
	const previous = process.env.CODEMEM_SYNC_KEY_STORE;
	process.env.CODEMEM_SYNC_KEY_STORE = "file";
	try {
		ensureDeviceIdentity(db, { keysDir, deviceId });
	} finally {
		if (previous === undefined) delete process.env.CODEMEM_SYNC_KEY_STORE;
		else process.env.CODEMEM_SYNC_KEY_STORE = previous;
	}
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Missing fixture signing key");
	return publicKey;
}

/** Explicit fixture grants are promoted only by real V1 refresh validation. */
export async function refreshManagedScopeFixture(
	db: Database,
	options: {
		keysDir: string;
		deviceId: string;
		scopeIds: string[];
		now?: Date;
	},
): Promise<string> {
	const publicKey = enrollFixtureSigningKey(db, options.keysDir, options.deviceId);
	const keyId = await ed25519KeyId(publicKey);
	if (!keyId) throw new Error("Invalid fixture signing key");
	const groups = new Map<string, ScopeMembershipSnapshot[]>();
	for (const scopeId of options.scopeIds) {
		const row = db.prepare("SELECT * FROM replication_scopes WHERE scope_id = ?").get(scopeId) as
			| CoordinatorScope
			| undefined;
		if (!row) throw new Error(`Missing fixture scope: ${scopeId}`);
		const scope = cacheScope({
			...row,
			coordinator_id: row.coordinator_id ?? "fixture-coordinator",
			group_id: row.group_id ?? "fixture-group",
		});
		const snapshot = cacheWireSnapshot(scope, [cacheMember(scope, options.deviceId)]);
		const item = snapshot.items[0];
		if (!item) throw new Error("Missing fixture enrollment");
		item.enrollment.public_key = publicKey;
		item.enrollment.fingerprint = fingerprintPublicKey(publicKey);
		item.key_id = keyId;
		const key = JSON.stringify([scope.coordinator_id, scope.group_id]);
		const snapshots = groups.get(key) ?? [];
		snapshots.push(snapshot);
		groups.set(key, snapshots);
	}
	for (const [key, snapshots] of groups) {
		const [coordinatorId, groupId] = JSON.parse(key) as [string, string];
		const result = await refreshScopeMembershipCache(db, {
			coordinatorId,
			groupIds: [groupId],
			now: options.now,
			fetchers: {
				listScopes: async () => ({ version: 1, items: snapshots.map(({ scope }) => scope) }),
				getScopeSnapshot: async (_group, scopeId) => {
					const snapshot = snapshots.find(({ scope }) => scope.scope_id === scopeId);
					if (!snapshot) throw new Error("Missing fixture snapshot");
					return snapshot;
				},
			},
		});
		if (result.status !== "refreshed")
			throw new Error(`Fixture refresh failed: ${JSON.stringify(result)}`);
	}
	return publicKey;
}

export async function seedProvenMixedScopeFixture(
	db: Database,
	keysDir: string,
	deviceId = "local",
) {
	enrollFixtureSigningKey(db, keysDir, deviceId);
	const fixture = seedMixedScopeFixture(db, deviceId);
	const expectedPublicKey = await refreshManagedScopeFixture(db, {
		keysDir,
		deviceId,
		scopeIds: [fixture.authorizedScopeId],
	});
	return { ...fixture, expectedPublicKey };
}
