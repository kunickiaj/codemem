import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDirectPeerAuthHeaders,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	getSyncResetState,
	loadPublicKey,
	MemoryStore,
	recordAccessCleanupOp,
	recordScopeReassignment,
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
		directory,
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
		request(
			path: string,
			signingKeys = peer.keysDir,
			options: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
		) {
			const url = `http://localhost${path}`;
			const method = options.method ?? "GET";
			const body = options.body === undefined ? undefined : JSON.stringify(options.body);
			const headers = buildDirectPeerAuthHeaders({
				deviceId: peer.deviceId,
				recipientId: localId,
				method,
				url,
				bodyBytes: body === undefined ? Buffer.alloc(0) : Buffer.from(body),
				keysDir: signingKeys,
			});
			headers[SYNC_CAPABILITY_HEADER] = "scoped";
			headers["Content-Type"] = "application/json";
			return app.request(url, { method, headers, body });
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

function memoryOp(scopeId: string, opId: string) {
	const now = new Date().toISOString();
	return {
		op_id: opId,
		entity_type: "memory_item",
		entity_id: `${opId}-memory`,
		op_type: "upsert",
		payload_json: JSON.stringify({
			body_text: "Signed push content",
			created_at: now,
			kind: "discovery",
			scope_id: scopeId,
			title: opId,
			updated_at: now,
			visibility: "shared",
			origin_device_id: root.peer.deviceId,
		}),
		clock_rev: 1,
		clock_updated_at: now,
		clock_device_id: root.peer.deviceId,
		device_id: root.peer.deviceId,
		created_at: now,
		scope_id: scopeId,
	};
}

function contentState() {
	return {
		memories: root.store.db.prepare("SELECT * FROM memory_items ORDER BY id").all(),
		operations: root.store.db.prepare("SELECT * FROM replication_ops ORDER BY op_id").all(),
	};
}

function pinOtherKey() {
	root.store.db
		.prepare(
			"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = ?",
		)
		.run(root.other.publicKey, fingerprintPublicKey(root.other.publicKey), root.peer.deviceId);
}

function seedManualScope() {
	const now = new Date().toISOString();
	root.store.db
		.prepare(
			"INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at) VALUES ('manual-work', 'Manual', 'user', 'manual', 1, 'active', ?, ?)",
		)
		.run(now, now);
	for (const deviceId of [root.localId, root.peer.deviceId]) {
		root.store.db
			.prepare(
				"INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at) VALUES ('manual-work', ?, 'member', 'active', 1, ?)",
			)
			.run(deviceId, now);
	}
}

async function seedProtectedMemory(opId: string) {
	await root.refresh();
	const op = memoryOp("managed-work", opId);
	const response = await root.request("/v1/ops", root.peer.keysDir, {
		method: "POST",
		body: { sync_capability: "scoped", ops: [op] },
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ applied: 1 });
	return op.entity_id;
}

function existingMemoryMutation(
	opType: "upsert" | "delete",
	scopeId: string,
	entityId: string,
	opId: string,
) {
	return {
		...memoryOp(scopeId, opId),
		entity_id: entityId,
		op_type: opType,
		clock_rev: 2,
		payload_json:
			opType === "delete"
				? null
				: JSON.stringify({
						scope_id: scopeId,
						title: null,
						body_text: null,
						kind: "discovery",
						visibility: "shared",
						updated_at: new Date().toISOString(),
						origin_device_id: root.peer.deviceId,
					}),
	};
}

async function accessCleanup(entityId: string) {
	const path = join(root.directory, "access-cleanup.sqlite");
	await root.store.db.backup(path);
	const sender = new Database(path);
	initTestSchema(sender);
	try {
		const opId = recordAccessCleanupOp(sender, {
			importKey: entityId,
			deviceId: root.peer.deviceId,
			cleanupScopeId: "managed-work",
			clockRev: 3,
			clockUpdatedAt: new Date().toISOString(),
			opId: "origin-access-cleanup",
		});
		return sender.prepare("SELECT * FROM replication_ops WHERE op_id = ?").get(opId);
	} finally {
		sender.close();
	}
}

describe("managed authorization for the existing row behind a manual operation", () => {
	const cases = (["upsert", "delete"] as const).flatMap((opType) => [
		{ opType, entityType: "memory_item", omitScope: false },
		{ opType, entityType: "memory_itemx", omitScope: false },
		{ opType, entityType: "memory_itemx", omitScope: true },
	]);
	it.each(cases)(
		"rejects $entityType $opType of managed content atomically (omitted operation scope: $omitScope), but admits the same label with correct keys",
		async ({ opType, entityType, omitScope }) => {
			// Arrange: C contains protected content; B is pinned but only A is enrolled in C.
			const entityId = await seedProtectedMemory(`protected-${opType}-seed`);
			seedManualScope();
			pinOtherKey();
			const before = contentState();
			const { scope_id: declaredScope, ...mutationFields } = existingMemoryMutation(
				opType,
				"manual-work",
				entityId,
				`manual-labeled-${opType}`,
			);
			const labeledMutation = { ...mutationFields, entity_type: entityType };
			const mutation = omitScope
				? labeledMutation
				: { ...labeledMutation, scope_id: declaredScope };
			// Act: the first manual operation is allowed, but the second targets the stored C row.
			const status = await root.request("/v1/status", root.other.keysDir);
			const denied = await root.request("/v1/ops", root.other.keysDir, {
				method: "POST",
				body: {
					sync_capability: "unsupported",
					ops: [memoryOp("manual-work", `allowed-before-${opType}`), mutation],
				},
			});
			// Assert: neither content preservation via COALESCE nor deletion can bypass C's grant.
			expect(status.status).toBe(200);
			expect(denied.status).toBe(409);
			expect(await denied.json()).toMatchObject({
				error: "reset_required",
				reason: "missing_scope",
				scope_id: "managed-work",
			});
			expect(contentState()).toEqual(before);
			// Arrange: restore A and keep the control mutation inside C, not across scopes.
			root.store.db
				.prepare("UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ?")
				.run(root.peer.publicKey, fingerprintPublicKey(root.peer.publicKey));
			const { scope_id: controlScope, ...controlFields } = existingMemoryMutation(
				opType,
				"managed-work",
				entityId,
				`within-managed-${opType}`,
			);
			const labeledControl = { ...controlFields, entity_type: entityType };
			const control = omitScope ? labeledControl : { ...labeledControl, scope_id: controlScope };
			// Act.
			const permitted = await root.request("/v1/ops", root.peer.keysDir, {
				method: "POST",
				body: { sync_capability: "unsupported", ops: [control] },
			});
			// Assert: even the unknown label reaches apply with valid C keys, not invalid-op rejection.
			expect(permitted.status).toBe(200);
			expect(await permitted.json()).toMatchObject({ applied: 1, rejected: 0 });
			expect(
				root.store.db
					.prepare(
						"SELECT scope_id, title, body_text, active FROM memory_items WHERE import_key = ?",
					)
					.get(entityId),
			).toEqual({
				scope_id: "managed-work",
				title: `protected-${opType}-seed`,
				body_text: "Signed push content",
				active: opType === "delete" ? 0 : 1,
			});
		},
	);
});

describe("origin cleanup after managed membership revocation", () => {
	it("permits historic origin cleanup through a retained direct pin without permitting new managed content access", async () => {
		// Arrange: a direct pin remains trusted after its managed membership is revoked.
		const entityId = await seedProtectedMemory("revoked-cleanup-seed");
		root.store.db
			.prepare(
				"UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = 'managed-work' AND device_id = ?",
			)
			.run(root.peer.deviceId);
		const cleanup = await accessCleanup(entityId);
		const before = contentState();
		// Act: ordinary mutation still requires current access to the stored managed row.
		const denied = await root.request("/v1/ops", root.peer.keysDir, {
			method: "POST",
			body: {
				sync_capability: "unsupported",
				ops: [existingMemoryMutation("upsert", "managed-work", entityId, "revoked-content-update")],
			},
		});
		// Assert: the cleanup exception cannot grant content access.
		expect(denied.status).toBe(409);
		expect(await denied.json()).toMatchObject({ reason: "scope_inactive" });
		expect(contentState()).toEqual(before);
		// Act: use the SDK's access_cleanup control, signed by the original content source.
		const permitted = await root.request("/v1/ops", root.peer.keysDir, {
			method: "POST",
			body: { sync_capability: "unsupported", ops: [cleanup] },
		});
		// Assert: current membership is unnecessary for origin-owned removal.
		expect(permitted.status).toBe(200);
		expect(await permitted.json()).toMatchObject({ applied: 1, rejected: 0 });
		expect(
			root.store.db.prepare("SELECT 1 FROM memory_items WHERE import_key = ?").get(entityId),
		).toBeUndefined();
	});
});

describe("unknown scope rejection does not allocate caller-selected reset boundaries", () => {
	it.each(["legacy", "unsupported"])(
		"rejects repeated authenticated %s pushes using only the fixed global reset boundary",
		async (mode) => {
			// Arrange: preserve every existing per-scope boundary and any initialized global row.
			const existingScopes = root.store.db
				.prepare(
					"SELECT * FROM sync_reset_state_v2 WHERE scope_id <> 'local-default' ORDER BY scope_id",
				)
				.all();
			const globalBefore = root.store.db
				.prepare("SELECT * FROM sync_reset_state_v2 WHERE scope_id = 'local-default'")
				.get();
			const contentBefore = contentState();
			let globalBoundary: ReturnType<typeof getSyncResetState> | undefined;
			for (const index of [1, 2, 3, 4]) {
				const scopeId = `${mode}-unknown-scope-${index}`;
				// The unknown entity label reaches the managed reset-rejection path, not the
				// older memory_item scope_rejected path; its valid mutation shape is covered above.
				const op = {
					...memoryOp(scopeId, `${mode}-unknown-op-${index}`),
					entity_type: "memory_itemx",
				};
				const body: Record<string, unknown> = { ops: [op] };
				if (mode === "unsupported") body.sync_capability = "unsupported";
				// Act: no envelope scope_id is supplied and each operation claims a new unknown ID.
				const response = await root.request("/v1/ops", root.peer.keysDir, { method: "POST", body });
				const payload = await response.json();
				const currentBoundary = getSyncResetState(root.store.db);
				globalBoundary ??= currentBoundary;
				// Assert: echo the offending ID, but return the same fixed global boundary each time.
				expect(response.status).toBe(409);
				expect(payload).toMatchObject({
					error: "reset_required",
					reset_required: true,
					reason: "missing_scope",
					scope_id: scopeId,
					...globalBoundary,
				});
				expect(currentBoundary).toEqual(globalBoundary);
				expect(
					root.store.db
						.prepare(
							"SELECT * FROM sync_reset_state_v2 WHERE scope_id <> 'local-default' ORDER BY scope_id",
						)
						.all(),
				).toEqual(existingScopes);
				expect(
					root.store.db.prepare("SELECT COUNT(*) FROM sync_reset_state_v2").pluck().get(),
				).toBe(existingScopes.length + 1);
				expect(contentState()).toEqual(contentBefore);
			}
			// A missing global boundary may initialize once; an existing one remains unchanged.
			const globalAfter = root.store.db
				.prepare("SELECT * FROM sync_reset_state_v2 WHERE scope_id = 'local-default'")
				.get();
			expect(globalAfter).toBeDefined();
			if (globalBefore) expect(globalAfter).toEqual(globalBefore);
		},
	);
});

async function seedManualMemory(opId: string) {
	seedManualScope();
	const response = await root.request("/v1/ops", root.peer.keysDir, {
		method: "POST",
		body: { sync_capability: "scoped", ops: [memoryOp("manual-work", opId)] },
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ applied: 1 });
	const memoryId = root.store.db
		.prepare("SELECT id FROM memory_items WHERE import_key = ?")
		.pluck()
		.get(`${opId}-memory`) as number | undefined;
	if (!memoryId) throw new Error("fixture_memory_missing");
	return memoryId;
}

async function oldSideReassignment(operationId: string, memoryId: number) {
	// Build both mirrors on a sender copy so the receiver cannot deduplicate the POST.
	const path = join(root.directory, `${operationId}.sqlite`);
	await root.store.db.backup(path);
	const sender = new Database(path);
	initTestSchema(sender);
	try {
		const { oldOpId } = recordScopeReassignment(sender, {
			operationId,
			memoryId,
			oldScopeId: "manual-work",
			newScopeId: "managed-work",
			deviceId: root.peer.deviceId,
			createdAt: new Date().toISOString(),
		});
		expect(
			sender
				.prepare("SELECT COUNT(*) FROM replication_ops WHERE op_type = 'reassign_scope'")
				.pluck()
				.get(),
		).toBe(2);
		expect(
			root.store.db.prepare("SELECT 1 FROM replication_ops WHERE op_id = ?").get(oldOpId),
		).toBeUndefined();
		const op = sender.prepare("SELECT * FROM replication_ops WHERE op_id = ?").get(oldOpId);
		if (!op) throw new Error("fixture_reassignment_missing");
		return op;
	} finally {
		sender.close();
	}
}

describe("managed destinations of unmanaged old-side reassignment", () => {
	it("denies destination changes when either actual peer or local signing key differs from retained enrollment", async () => {
		// Arrange: the old scope is manual and contains a real peer-origin memory.
		await root.refresh();
		const memoryId = await seedManualMemory("destination-denial-seed");
		const before = contentState();
		for (const mismatch of ["peer", "local"]) {
			await root.refresh();
			let signingKeys = root.peer.keysDir;
			root.store.db
				.prepare("UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ?")
				.run(root.peer.publicKey, fingerprintPublicKey(root.peer.publicKey));
			if (mismatch === "peer") {
				pinOtherKey();
				signingKeys = root.other.keysDir;
			} else {
				await root.refresh({ [root.localId]: root.other.publicKey });
			}
			const op = await oldSideReassignment(`destination-${mismatch}-denied`, memoryId);
			// Act: submit only the valid old/manual mirror, not the managed/new mirror.
			const status = await root.request("/v1/status", signingKeys);
			const response = await root.request("/v1/ops", signingKeys, {
				method: "POST",
				body: { sync_capability: "scoped", sync_features: ["reassign_scope"], ops: [op] },
			});
			// Assert: authentication succeeds, but destination admission precedes metadata writes.
			expect(status.status).toBe(200);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				error: "reset_required",
				reason: "missing_scope",
				scope_id: "managed-work",
			});
			expect(contentState()).toEqual(before);
		}
	});

	it("applies the same old-side reassignment when both actual keys match managed destination evidence", async () => {
		// Arrange: the SDK creates a valid mirrored operation and only its old side is sent.
		await root.refresh();
		const memoryId = await seedManualMemory("destination-permitted-seed");
		const op = await oldSideReassignment("destination-permitted", memoryId);
		// Act.
		const response = await root.request("/v1/ops", root.peer.keysDir, {
			method: "POST",
			body: { sync_capability: "scoped", sync_features: ["reassign_scope"], ops: [op] },
		});
		// Assert: this payload passes validation and reaches the old-side metadata update.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ applied: 1, rejected: 0 });
		const row = root.store.db
			.prepare("SELECT active, metadata_json FROM memory_items WHERE id = ?")
			.get(memoryId) as { active: number; metadata_json: string };
		expect(row.active).toBe(0);
		expect(JSON.parse(row.metadata_json)).toMatchObject({
			last_scope_reassignment: { new_scope_id: "managed-work", side: "old" },
		});
	});
});

describe("managed normalized operations in legacy POST envelopes", () => {
	it("rejects a different authenticated peer key before applying a managed operation without envelope scope_id", async () => {
		// Arrange: the pin authenticates B as A's device, but refresh enrolled only A.
		await root.refresh();
		pinOtherKey();
		const before = contentState();
		// Act: the managed scope exists only on the valid signed operation.
		const status = await root.request("/v1/status", root.other.keysDir);
		const response = await root.request("/v1/ops", root.other.keysDir, {
			method: "POST",
			body: { sync_capability: "scoped", ops: [memoryOp("managed-work", "wrong-key-push")] },
		});
		// Assert: reject at scope admission, not authentication or payload validation.
		expect(status.status).toBe(200);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "reset_required",
			reason: "missing_scope",
		});
		expect(contentState()).toEqual(before);
	});

	it("rejects raw managed memberships before applying an operation without envelope scope_id", async () => {
		// Arrange: raw device memberships exist, but no refresh retained enrollment proof.
		const before = contentState();
		// Act: correct signatures alone cannot authorize managed content.
		const status = await root.request("/v1/status");
		const response = await root.request("/v1/ops", root.peer.keysDir, {
			method: "POST",
			body: { sync_capability: "scoped", ops: [memoryOp("managed-work", "raw-proof-push")] },
		});
		// Assert.
		expect(status.status).toBe(200);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "reset_required",
			reason: "missing_scope",
		});
		expect(contentState()).toEqual(before);
	});

	it("applies a valid managed operation without envelope scope_id using unchanged verified offline evidence", async () => {
		// Arrange: the actual local and peer keys match retained refresh evidence.
		await root.refresh();
		root.store.db
			.prepare(
				"UPDATE scope_membership_cache_state SET last_success_at = '2000-01-01T00:00:00.000Z', last_error = 'coordinator_unavailable'",
			)
			.run();
		const before = root.store.db.prepare("SELECT * FROM scope_membership_cache_state").all();
		// Act: use the same operation shape as the wrong-key regression with a new ID.
		const response = await root.request("/v1/ops", root.peer.keysDir, {
			method: "POST",
			body: { sync_capability: "scoped", ops: [memoryOp("managed-work", "verified-push")] },
		});
		// Assert: the operation is valid and stale timestamps do not expire unchanged proof.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ applied: 1, rejected: 0 });
		expect(
			root.store.db
				.prepare("SELECT scope_id FROM memory_items WHERE import_key = 'verified-push-memory'")
				.get(),
		).toEqual({ scope_id: "managed-work" });
		expect(root.store.db.prepare("SELECT * FROM scope_membership_cache_state").all()).toEqual(
			before,
		);
	});
});

describe("managed POST admission before applying mixed or misleading envelopes", () => {
	it("rejects the entire manual and managed batch signed by a different enrolled device key", async () => {
		// Arrange: the manual operation is allowed, but the later managed operation is not.
		await root.refresh();
		seedManualScope();
		pinOtherKey();
		const before = contentState();
		// Act: omit envelope scope_id and place the manual operation first.
		const response = await root.request("/v1/ops", root.other.keysDir, {
			method: "POST",
			body: {
				sync_capability: "scoped",
				ops: [
					memoryOp("manual-work", "manual-before-rejected"),
					memoryOp("managed-work", "managed-after-rejected"),
				],
			},
		});
		// Assert: no operation can be partially applied before managed admission fails.
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "reset_required",
			reason: "missing_scope",
		});
		expect(contentState()).toEqual(before);
	});

	it("rejects a managed operation under an otherwise authorized manual envelope", async () => {
		// Arrange: a manual envelope must not substitute for the normalized operation's scope.
		await root.refresh();
		seedManualScope();
		pinOtherKey();
		const before = contentState();
		// Act.
		const response = await root.request("/v1/ops", root.other.keysDir, {
			method: "POST",
			body: {
				sync_capability: "scoped",
				scope_id: "manual-work",
				ops: [memoryOp("managed-work", "managed-under-manual")],
			},
		});
		// Assert: the actual managed operation requires its own enrolled signing key.
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "reset_required",
			reason: "missing_scope",
		});
		expect(contentState()).toEqual(before);
	});

	it("keeps unmanaged manual operations applicable in legacy default-lane envelopes without managed proof", async () => {
		// Arrange: these direct grants have no coordinator enrollment proof.
		seedManualScope();
		pinOtherKey();
		// Act: sign a legacy envelope with the actual directly pinned key.
		const response = await root.request("/v1/ops", root.other.keysDir, {
			method: "POST",
			body: {
				sync_capability: "scoped",
				ops: [memoryOp("manual-work", "manual-direct-push")],
			},
		});
		// Assert: the new managed gate does not change direct-scope operation admission.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ applied: 1, rejected: 0 });
		expect(
			root.store.db.prepare("SELECT scope_id FROM memory_items ORDER BY scope_id").all(),
		).toEqual([{ scope_id: "manual-work" }]);
	});
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
