import { expect, vi } from "vitest";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import type {
	contractHarness,
	GrantFixture,
} from "./coordinator-identity-group-grant-test-harness.js";
import { D1CoordinatorStore, type D1DatabaseLike } from "./d1-coordinator-store.js";

type Test = ReturnType<typeof contractHarness>;
export const peerDiscoveryTables = [
	"groups",
	"enrolled_devices",
	"presence_records",
	"coordinator_device_revocations",
	"coordinator_bootstrap_grants",
	"coordinator_scope_memberships",
	"coordinator_scope_membership_audit_log",
];
export const peerId = (f: GrantFixture, name: string) => `${f.review.deviceId}-${name}`;
export async function seedPeers(f: GrantFixture) {
	await f.store.createGroup(f.review.groupId);
	for (const name of ["requester", "target", "healthy"]) {
		await f.store.enrollDevice(f.review.groupId, {
			deviceId: peerId(f, name),
			publicKey: name === "target" ? CANONICAL_PUBLIC_KEY : UNRELATED_PUBLIC_KEY,
			fingerprint: f.review.fingerprint,
		});
	}
}
async function discover(f: GrantFixture, store = f.store) {
	return store.listGroupPeers(f.review.groupId, peerId(f, "requester"));
}
async function snapshot(f: GrantFixture) {
	return Promise.all(peerDiscoveryTables.map((table) => f.rows(table)));
}
async function revoke(f: GrantFixture, options: { idOnly?: boolean; alias?: boolean } = {}) {
	const deviceId = peerId(f, options.alias ? "alias" : "target");
	const publicKey = options.idOnly ? "opaque-revocation-evidence" : CANONICAL_PUBLIC_KEY;
	if (options.alias)
		await f.store.enrollDevice(f.review.groupId, {
			deviceId,
			publicKey,
			fingerprint: f.review.fingerprint,
		});
	if (options.idOnly)
		await f.exec(
			"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
			publicKey,
			f.review.groupId,
			deviceId,
		);
	expect(
		await f.store.createDeviceRevocation({
			groupId: f.review.groupId,
			deviceId,
			publicKey,
			fingerprint: f.review.fingerprint,
		}),
	).toMatchObject({ kind: "revoked" });
	if (options.idOnly) {
		await f.exec(
			"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
			CANONICAL_PUBLIC_KEY,
			f.review.groupId,
			deviceId,
		);
		expect(await f.rows("coordinator_device_revocations")).not.toContainEqual(
			expect.objectContaining({ subject_kind: "ed25519_key", subject_value: EXPECTED_KEY_ID }),
		);
	}
}

export function registerPeerDiscoveryContract(test: Test) {
	registerCompatibility(test);
	registerRevocations(test);
	registerAliases(test);
	registerGroupIsolation(test);
	registerLargeGroup(test);
}
function registerCompatibility(test: Test) {
	test.for(["ordinary", "unseen", "expired", "opaque", "disabled"])(
		"preserves discovery compatibility: %s",
		async (mode, { fixture: f }) => {
			// Arrange: absence and expiry are stale, not revocation.
			await seedPeers(f);
			await compatibilityState(f, mode);
			const before = await snapshot(f);
			// Act
			const peers = await discover(f);
			// Assert
			expect(peers.map((p) => p.device_id)).toEqual([
				peerId(f, "healthy"),
				...(mode === "disabled" ? [] : [peerId(f, "target")]),
			]);
			const target = peers.find((p) => p.device_id === peerId(f, "target"));
			if (target) {
				expect(target.stale).toBe(mode !== "ordinary");
				expect(target.addresses).toEqual(mode === "ordinary" ? ["http://localhost:9001"] : []);
				expect(target.capabilities).toEqual(
					["ordinary", "expired"].includes(mode) ? { transports: ["http"] } : {},
				);
			}
			expect(await snapshot(f)).toEqual(before);
		},
	);
}
async function compatibilityState(f: GrantFixture, mode: string) {
	if (mode === "opaque")
		await f.exec(
			"UPDATE enrolled_devices SET public_key = 'opaque-legacy-key' WHERE group_id = ?",
			f.review.groupId,
		);
	if (mode === "disabled")
		await f.store.setDeviceEnabled(f.review.groupId, peerId(f, "target"), false);
	if (["ordinary", "expired"].includes(mode))
		await f.store.upsertPresence({
			groupId: f.review.groupId,
			deviceId: peerId(f, "target"),
			addresses: ["http://localhost:9001"],
			ttlS: 300,
			capabilities: { transports: ["http"] },
		});
	if (mode === "expired")
		await f.exec(
			"UPDATE presence_records SET expires_at = '2000-01-01T00:00:00Z' WHERE group_id = ?",
			f.review.groupId,
		);
}
function registerRevocations(test: Test) {
	test.for(["id", "key"])(
		"omits globally revoked %s but preserves raw enrollment, presence and history",
		async (kind, { fixture: f }) => {
			// Arrange: ID-only evidence must not accidentally exercise a key tombstone.
			await seedPeers(f);
			await f.store.upsertPresence({
				groupId: f.review.groupId,
				deviceId: peerId(f, "target"),
				addresses: ["http://localhost:9001"],
				ttlS: 300,
			});
			await f.store.createBootstrapGrant({
				groupId: f.review.groupId,
				seedDeviceId: peerId(f, "healthy"),
				workerDeviceId: peerId(f, "target"),
				expiresAt: "2099-01-01",
			});
			await revoke(f, { idOnly: kind === "id", alias: kind === "key" });
			const before = await snapshot(f);
			// Act
			const peers = await discover(f);
			// Assert
			expect(peers.map((p) => p.device_id)).toEqual([peerId(f, "healthy")]);
			expect(await f.store.getEnrollment(f.review.groupId, peerId(f, "target"))).toMatchObject({
				public_key: CANONICAL_PUBLIC_KEY,
				enabled: 1,
			});
			expect(await f.store.listEnrolledDevices(f.review.groupId)).toContainEqual(
				expect.objectContaining({ device_id: peerId(f, "target") }),
			);
			expect(await snapshot(f)).toEqual(before);
		},
	);
}
function registerAliases(test: Test) {
	test.for(ACCEPTED_ALIASES)(
		"canonical revocation recognizes candidate alias $name",
		async (alias, { fixture: f }) => {
			// Arrange: fingerprint and textual metadata are not key identity.
			await seedPeers(f);
			await revoke(f, { alias: true });
			await f.exec(
				"UPDATE enrolled_devices SET public_key = ?, fingerprint = 'different-metadata' WHERE group_id = ? AND device_id = ?",
				alias.publicKey,
				f.review.groupId,
				peerId(f, "target"),
			);
			// Act
			const peers = await discover(f);
			// Assert
			expect(peers.map((p) => p.device_id)).toEqual([peerId(f, "healthy")]);
		},
	);
}
function registerGroupIsolation(test: Test) {
	test.for(["clean", "revoked ID"])(
		"presence joins actual group and global ID revocation: %s",
		async (mode, { fixture: f }) => {
			// Arrange: same device IDs in different groups, but clean distinct public keys.
			await seedPeers(f);
			const other = `${f.review.groupId}-other`;
			await f.store.createGroup(other);
			await f.store.enrollDevice(other, {
				deviceId: peerId(f, "target"),
				publicKey: UNRELATED_PUBLIC_KEY,
				fingerprint: f.review.fingerprint,
			});
			await f.store.upsertPresence({
				groupId: other,
				deviceId: peerId(f, "target"),
				addresses: ["http://localhost:9010"],
				ttlS: 300,
			});
			if (mode === "revoked ID") await revoke(f, { idOnly: true });
			// Act
			const primary = await discover(f);
			const secondary = await f.store.listGroupPeers(other, peerId(f, "requester"));
			// Assert
			expect(primary.map((p) => p.device_id)).toEqual([
				peerId(f, "healthy"),
				...(mode === "clean" ? [peerId(f, "target")] : []),
			]);
			if (mode === "clean") {
				expect(primary[1]).toMatchObject({
					addresses: [],
					stale: true,
					public_key: CANONICAL_PUBLIC_KEY,
				});
				expect(secondary[0]).toMatchObject({
					addresses: ["http://localhost:9010"],
					public_key: UNRELATED_PUBLIC_KEY,
				});
			} else expect(secondary).toEqual([]);
		},
	);
}
function registerLargeGroup(test: Test) {
	test("more than 100 candidates retain sorted results without truncation or bind overflow", async ({
		fixture: f,
	}) => {
		// Arrange
		await seedPeers(f);
		const ids = Array.from({ length: 121 }, (_, n) =>
			peerId(f, `bulk-${String(n).padStart(3, "0")}`),
		);
		for (const deviceId of ids)
			await f.store.enrollDevice(f.review.groupId, {
				deviceId,
				publicKey: "opaque-bulk-key",
				fingerprint: f.review.fingerprint,
			});
		// Act
		const peers = await discover(f);
		// Assert: native D1 enforces its SQL variable limit.
		expect(peers.map((p) => p.device_id)).toEqual(
			[...ids, peerId(f, "healthy"), peerId(f, "target")].sort(),
		);
	});
}

export function guardedPeerD1(
	db: D1DatabaseLike,
	hook: () => Promise<void>,
	options: { malformed?: boolean } = {},
): D1DatabaseLike {
	let fired = false;
	return {
		prepare(sql) {
			const wrap = (
				statement: ReturnType<D1DatabaseLike["prepare"]>,
			): ReturnType<D1DatabaseLike["prepare"]> => ({
				bind: (...values) => wrap(statement.bind(...values)),
				first: <T>() => statement.first<T>(),
				run: () => statement.run(),
				raw: <T>() => {
					if (!statement.raw) throw new Error("Raw fixture reads unavailable");
					return statement.raw<T>();
				},
				async all<T>() {
					if (!fired && /json_each/i.test(sql) && /enrolled_devices/i.test(sql)) {
						fired = true;
						await hook();
						if (options.malformed) return { results: [null] as T[] };
					}
					return statement.all<T>();
				},
			});
			return wrap(db.prepare(sql));
		},
		batch: (statements) => {
			if (!db.batch) throw new Error("Fixture batches unavailable");
			return db.batch(statements);
		},
	};
}

const mutations = [
	"revoke ID",
	"revoke key",
	"key",
	"fingerprint",
	"identity from null",
	"identity to null",
	"remove",
	"disable",
	"group",
	"rotate then revoke old key",
] as const;
async function mutate(f: GrantFixture, mode: (typeof mutations)[number]) {
	if (mode === "revoke ID") return revoke(f, { idOnly: true });
	if (mode === "revoke key") return revoke(f, { alias: true });
	if (mode === "remove") {
		await f.store.removeDevice(f.review.groupId, peerId(f, "target"));
		return;
	}
	if (mode === "disable") {
		await f.store.setDeviceEnabled(f.review.groupId, peerId(f, "target"), false);
		return;
	}
	if (mode === "rotate then revoke old key") {
		await f.exec(
			"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
			UNRELATED_PUBLIC_KEY,
			f.review.groupId,
			peerId(f, "target"),
		);
		return revoke(f, { alias: true });
	}
	const fields = {
		key: ["public_key", UNRELATED_PUBLIC_KEY],
		fingerprint: ["fingerprint", "changed"],
		"identity from null": ["identity_id", "changed"],
		"identity to null": ["identity_id", null],
		group: ["group_id", `${f.review.groupId}-other`],
	};
	if (mode === "group") await f.store.createGroup(`${f.review.groupId}-other`);
	const [field, value] = fields[mode];
	await f.exec(
		`UPDATE enrolled_devices SET ${field} = ? WHERE group_id = ? AND device_id = ?`,
		value,
		f.review.groupId,
		peerId(f, "target"),
	);
}
export function registerPeerDiscoveryRaces(
	test: Test,
	install: (
		f: GrantFixture,
		hook: () => Promise<void>,
	) => { store: GrantFixture["store"]; restore: () => void },
	stage: string,
) {
	test.for(mutations)(
		`${stage}: changed candidate %s is omitted, unaffected peer survives`,
		async (mode, { fixture: f }) => {
			// Arrange: admission is already complete; this tests candidates, not cached requester control.
			await seedPeers(f);
			if (mode === "identity to null")
				await f.exec(
					"UPDATE enrolled_devices SET identity_id = 'original' WHERE group_id = ? AND device_id = ?",
					f.review.groupId,
					peerId(f, "target"),
				);
			let fired = false;
			const guard = install(f, async () => {
				fired = true;
				await mutate(f, mode);
			});
			try {
				// Act
				const peers = await discover(f, guard.store);
				// Assert
				expect(fired).toBe(true);
				expect(peers.map((p) => p.device_id)).toEqual([peerId(f, "healthy")]);
			} finally {
				guard.restore();
			}
		},
	);
	test(`${stage}: current presence and non-authorizing display name are refreshed`, async ({
		fixture: f,
	}) => {
		// Arrange
		await seedPeers(f);
		const guard = install(f, async () => {
			await f.store.renameDevice(f.review.groupId, peerId(f, "target"), "Fresh name");
			await f.store.upsertPresence({
				groupId: f.review.groupId,
				deviceId: peerId(f, "target"),
				addresses: ["http://localhost:9020"],
				ttlS: 300,
				capabilities: { transports: ["http"] },
			});
		});
		try {
			// Act
			const peers = await discover(f, guard.store);
			// Assert
			expect(peers.find((p) => p.device_id === peerId(f, "target"))).toMatchObject({
				display_name: "Fresh name",
				addresses: ["http://localhost:9020"],
				stale: false,
				last_seen_at: expect.any(String),
				expires_at: expect.any(String),
			});
		} finally {
			guard.restore();
		}
	});
}
export function registerPeerDiscoveryFailures(
	test: Test,
	database: (f: GrantFixture) => D1DatabaseLike,
) {
	test.for(["throw", "malformed"])(
		"final D1 read %s fails closed with fixed error, never raw fallback",
		async (mode, { fixture: f }) => {
			// Arrange
			await seedPeers(f);
			let fired = false;
			const store = new D1CoordinatorStore(
				guardedPeerD1(
					database(f),
					async () => {
						fired = true;
						if (mode === "throw") throw new Error("private SQL diagnostic");
					},
					{ malformed: mode === "malformed" },
				),
			);
			// Act
			const result = discover(f, store);
			// Assert
			await expect(result).rejects.toThrow(/^peer_discovery_unavailable$/);
			expect(fired).toBe(true);
		},
	);
}
export function hashGuard(f: GrantFixture, hook: () => Promise<void>) {
	const original = crypto.subtle.digest.bind(crypto.subtle);
	let fired = false;
	const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
		if (!fired) {
			fired = true;
			await hook();
		}
		return original(...args);
	});
	return { store: f.store, restore: () => spy.mockRestore() };
}
