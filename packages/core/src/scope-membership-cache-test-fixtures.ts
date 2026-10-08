import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import type { CoordinatorScope, CoordinatorScopeMembership } from "./coordinator-store-contract.js";
import type { Database } from "./db.js";
import {
	type RefreshScopeMembershipCacheOptions,
	refreshScopeMembershipCache,
} from "./scope-membership-cache.js";
import type { ScopeMembershipSnapshot } from "./scope-membership-snapshot.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export const cacheTime = "2026-10-07T00:00:00.000Z";
export function cacheScope(overrides: Partial<CoordinatorScope> = {}): CoordinatorScope {
	return {
		scope_id: "scope-a",
		label: "Scope",
		kind: "team",
		authority_type: "coordinator",
		coordinator_id: "server-a",
		group_id: "group-a",
		manifest_issuer_device_id: null,
		membership_epoch: 3,
		manifest_hash: null,
		status: "active",
		created_at: cacheTime,
		updated_at: cacheTime,
		...overrides,
	};
}
export function cacheMember(
	scope = cacheScope(),
	deviceId = "device-a",
): CoordinatorScopeMembership {
	return {
		scope_id: scope.scope_id,
		device_id: deviceId,
		role: "member",
		status: "active",
		membership_epoch: scope.membership_epoch,
		coordinator_id: scope.coordinator_id,
		group_id: scope.group_id,
		manifest_issuer_device_id: scope.manifest_issuer_device_id,
		manifest_hash: scope.manifest_hash,
		signed_manifest_json: null,
		updated_at: cacheTime,
	};
}
export function cacheWireSnapshot(
	scope = cacheScope(),
	members = [cacheMember(scope)],
): ScopeMembershipSnapshot {
	const groupId = scope.group_id;
	if (!groupId) throw new Error("Trusted fixture requires an explicit group");
	return {
		authorization_version: 1,
		scope,
		items: members.map((membership) => ({
			membership,
			enrollment: {
				group_id: groupId,
				device_id: membership.device_id,
				public_key: CANONICAL_PUBLIC_KEY,
				fingerprint: fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
				identity_id: null,
				display_name: null,
				enabled: 1,
				created_at: cacheTime,
			},
			key_id: EXPECTED_KEY_ID,
		})),
	};
}

// Only trusted legacy test fixtures are promoted. Production rejects raw arrays.
export function refreshFixtureScopeMembershipCache(
	db: Database,
	opts: Omit<RefreshScopeMembershipCacheOptions, "fetchers"> & {
		fetchers?: {
			listScopes(groupId: string): Promise<CoordinatorScope[]>;
			listMemberships(groupId: string, scopeId: string): Promise<CoordinatorScopeMembership[]>;
		};
	},
) {
	const raw = opts.fetchers;
	if (!raw) return refreshScopeMembershipCache(db, { ...opts, fetchers: undefined });
	const scopes = new Map<string, CoordinatorScope>();
	return refreshScopeMembershipCache(db, {
		...opts,
		fetchers: {
			async listScopes(groupId) {
				const items = await raw.listScopes(groupId);
				for (const scope of items) scopes.set(scope.scope_id, scope);
				return { version: 1, items };
			},
			async getScopeSnapshot(groupId, scopeId) {
				const scope = scopes.get(scopeId);
				if (!scope) throw new Error("Missing trusted fixture scope");
				return cacheWireSnapshot(scope, await raw.listMemberships(groupId, scopeId));
			},
		},
	});
}

/** Promote test setup rows through the public refresh DTO, never insert retained proofs. */
export async function refreshTestScopeRows(
	db: Database,
	publicKeys: Record<string, string> = {},
	options: { now?: Date } = {},
) {
	const scopes = db
		.prepare("SELECT * FROM replication_scopes WHERE authority_type = 'coordinator'")
		.all() as CoordinatorScope[];
	const authorities = new Map(
		scopes.map((scope) => [`${scope.coordinator_id}:${scope.group_id}`, scope]),
	);
	for (const authority of authorities.values()) {
		const catalog = scopes.filter(
			(scope) =>
				scope.coordinator_id === authority.coordinator_id && scope.group_id === authority.group_id,
		);
		const result = await refreshScopeMembershipCache(db, {
			coordinatorId: authority.coordinator_id,
			groupIds: [authority.group_id ?? ""],
			now: options.now ?? new Date(cacheTime),
			fetchers: {
				async listScopes() {
					return { version: 1, items: catalog };
				},
				async getScopeSnapshot(_group, scopeId) {
					const scope = catalog.find((item) => item.scope_id === scopeId);
					if (!scope) throw new Error("Missing test scope");
					const rows = db
						.prepare("SELECT * FROM scope_memberships WHERE scope_id = ?")
						.all(scopeId) as CoordinatorScopeMembership[];
					const members = rows.map((row) => ({
						...cacheMember(scope, row.device_id),
						...row,
						coordinator_id: scope.coordinator_id,
						group_id: scope.group_id,
					}));
					const snapshot = cacheWireSnapshot(scope, members);
					for (const item of snapshot.items) {
						const publicKey = publicKeys[item.membership.device_id] ?? CANONICAL_PUBLIC_KEY;
						item.enrollment.public_key = publicKey;
						item.enrollment.fingerprint = fingerprintPublicKey(publicKey);
						item.key_id = (await ed25519KeyId(publicKey)) ?? "";
					}
					return snapshot;
				},
			},
		});
		if (result.status !== "refreshed")
			throw new Error(`Test refresh failed: ${JSON.stringify(result)}`);
	}
}
