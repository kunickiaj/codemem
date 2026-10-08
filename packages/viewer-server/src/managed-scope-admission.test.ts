import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDirectPeerAuthHeaders,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	loadPublicKey,
	MemoryStore,
	SYNC_CAPABILITY_HEADER,
	setSyncResetState,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import { initTestSchema } from "../../core/src/test-utils.js";
import { syncProtocolRoutes } from "./routes/sync.js";

const scopedOpsPath = "/v1/ops?scope_id=managed-work&generation=1&snapshot_id=admission-fixture";

function createSigningKeyRoot() {
	const directory = mkdtempSync(join(tmpdir(), "codemem-managed-admission-"));
	const keysDir = join(directory, "local-keys");
	// Scoped test override only; never read or write the user's signing keys.
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	const store = new MemoryStore(join(directory, "store.sqlite"));
	const [localId] = ensureDeviceIdentity(store.db, { keysDir });
	function signer(name: string) {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const signerKeys = join(directory, name);
			const [deviceId] = ensureDeviceIdentity(db, { keysDir: signerKeys });
			const publicKey = loadPublicKey(signerKeys);
			if (!publicKey) throw new Error("Missing fixture signing key");
			return { deviceId, keysDir: signerKeys, publicKey };
		} finally {
			db.close();
		}
	}
	const peer = signer("peer");
	const other = signer("other");
	const localKey = loadPublicKey(keysDir);
	if (!localKey) throw new Error("Missing local fixture key");
	const now = new Date().toISOString();
	store.db
		.prepare(
			"INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(peer.deviceId, peer.publicKey, fingerprintPublicKey(peer.publicKey), now);
	store.db
		.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
		VALUES ('managed-work', 'Work', 'managed_project', 'coordinator', 'coordinator-1', 'group-1', 1, 'active', ?, ?)`)
		.run(now, now);
	for (const deviceId of [localId, peer.deviceId]) {
		store.db
			.prepare(
				"INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at) VALUES ('managed-work', ?, 'member', 'active', 1, ?)",
			)
			.run(deviceId, now);
	}
	const app = syncProtocolRoutes(() => store);
	setSyncResetState(
		store.db,
		{ generation: 1, snapshot_id: "admission-fixture", baseline_cursor: null },
		"managed-work",
	);
	return {
		store,
		localId,
		localKey,
		peer,
		other,
		refresh: (keys = {}) =>
			refreshTestScopeRows(store.db, {
				[localId]: localKey,
				[peer.deviceId]: peer.publicKey,
				...keys,
			}),
		request(path: string, signingKeys = peer.keysDir) {
			const url = `http://localhost${path}`;
			const headers = buildDirectPeerAuthHeaders({
				deviceId: peer.deviceId,
				recipientId: localId,
				method: "GET",
				url,
				bodyBytes: Buffer.alloc(0),
				keysDir: signingKeys,
			});
			headers[SYNC_CAPABILITY_HEADER] = "scoped";
			return app.request(url, { headers });
		},
		close() {
			store.close();
			vi.unstubAllEnvs();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

let root: ReturnType<typeof createSigningKeyRoot>;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-07T00:00:00.000Z"));
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network call");
		}),
	);
	root = createSigningKeyRoot();
});
afterEach(() => {
	root.close();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("managed scope admission with actual signed callers", () => {
	it("denies scoped reads from raw managed rows while retaining successful peer authentication", async () => {
		// Arrange: local and peer rows exist, but no refresh retained enrollment evidence.
		// Act.
		const status = await root.request("/v1/status");
		const ops = await root.request(scopedOpsPath);
		// Assert: denial occurs at scope admission, not signature authentication.
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ authorized_scopes: [] });
		expect(ops.status).toBe(409);
		expect(await ops.json()).toMatchObject({
			error: "reset_required",
			reason: "missing_scope",
			scope_id: null,
		});
	});

	it("advertises and admits refreshed keys, including unchanged verified evidence offline", async () => {
		// Arrange: use the public refresh DTO with the real local and peer SSH keys.
		await root.refresh();
		root.store.db
			.prepare(
				"UPDATE scope_membership_cache_state SET last_success_at = '2000-01-01T00:00:00.000Z', last_error = 'coordinator_unavailable'",
			)
			.run();
		const cacheBefore = root.store.db.prepare("SELECT * FROM scope_membership_cache_state").all();
		// Act.
		const status = await root.request("/v1/status");
		const ops = await root.request(scopedOpsPath);
		// Assert: the routes thread both actual signing keys without refreshing on reads.
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({
			authorized_scopes: [{ scope_id: "managed-work" }],
		});
		expect(ops.status).toBe(200);
		expect(root.store.db.prepare("SELECT * FROM scope_membership_cache_state").all()).toEqual(
			cacheBefore,
		);
	});

	it("does not substitute the enrolled device ID for a different authenticated peer key", async () => {
		// Arrange: authentication accepts a pinned signer under the same device ID,
		// while the coordinator retained evidence only for the originally enrolled key.
		await root.refresh();
		root.store.db
			.prepare(
				"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = ?",
			)
			.run(root.other.publicKey, fingerprintPublicKey(root.other.publicKey), root.peer.deviceId);
		// Act: sign real requests with the other private key, keeping the enrolled ID.
		const status = await root.request("/v1/status", root.other.keysDir);
		const ops = await root.request(scopedOpsPath, root.other.keysDir);
		// Assert: authentication succeeds but the actual key cannot read the scope.
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ authorized_scopes: [] });
		expect(ops.status).toBe(409);
		expect(await ops.json()).toMatchObject({ reason: "missing_scope" });
	});

	it("denies a local signer that no longer matches refreshed enrollment", async () => {
		// Arrange: retained local enrollment changes, but local signing files do not.
		await root.refresh({ [root.localId]: root.other.publicKey });
		// Act.
		const status = await root.request("/v1/status");
		const ops = await root.request(scopedOpsPath);
		// Assert: peer membership alone cannot authorize the local endpoint.
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ authorized_scopes: [] });
		expect(ops.status).toBe(409);
		expect(await ops.json()).toMatchObject({ reason: "missing_scope" });
	});
});

describe("unmanaged direct scope admission", () => {
	it.each(["manual", "invite"])(
		"keeps trusted %s direct scopes usable without managed evidence",
		async (authorityType) => {
			// Arrange: a direct peer pin and unmanaged grants do not need coordinator proof.
			root.store.db
				.prepare(
					"UPDATE replication_scopes SET authority_type = ?, coordinator_id = NULL, group_id = NULL",
				)
				.run(authorityType);
			// Act: the pinned signer succeeds, while an unpinned signer still fails auth.
			const status = await root.request("/v1/status");
			const ops = await root.request(scopedOpsPath);
			const untrusted = await root.request("/v1/status", root.other.keysDir);
			// Assert.
			expect(status.status).toBe(200);
			expect(await status.json()).toMatchObject({
				authorized_scopes: [{ scope_id: "managed-work" }],
			});
			expect(ops.status).toBe(200);
			expect(untrusted.status).toBe(401);
		},
	);
});
