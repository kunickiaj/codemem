import { generateKeyPairSync } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as syncAuth from "./sync-auth.js";
import { fetchAllSnapshotPages } from "./sync-bootstrap.js";
import { SYNC_CAPABILITY_HEADER } from "./sync-capability.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";
import * as http from "./sync-http-client.js";
import * as identity from "./sync-identity.js";
import { syncOnce } from "./sync-pass.js";
import { getReplicationCursor, setReplicationCursor } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { SyncResetRequired } from "./types.js";

const localId = "executor-local";
const peerId = "executor-peer";
const scopeId = "executor-scope";
const baseUrl = "http://executor.example.test:47337";
const timestamp = "2026-01-01T00:00:00Z";
const cursor = `${timestamp}|baseline`;
const boundary = {
	generation: 1,
	snapshot_id: "executor-snapshot",
	baseline_cursor: cursor,
	retained_floor_cursor: null,
};
const reset: SyncResetRequired = {
	...boundary,
	scope_id: scopeId,
	reset_required: true,
	reason: "generation_mismatch",
};

function statusPayload(scoped = false) {
	return {
		fingerprint: "executor-fingerprint",
		protocol_version: "2",
		sync_capability: scoped ? "scoped" : "enforcing",
		sync_reset: { ...boundary, scope_id: scopeId },
		authorized_scopes: scoped
			? [
					{
						scope_id: scopeId,
						label: "Executor scope",
						membership_epoch: 1,
						authority_type: "coordinator",
						sync_reset: { ...boundary, scope_id: scopeId },
					},
				]
			: [],
	};
}

function emptyOps() {
	return { ...boundary, reset_required: false, ops: [], next_cursor: null, skipped: 0 };
}

function snapshotPage(more: boolean) {
	return {
		...boundary,
		scope_id: scopeId,
		items: [],
		has_more: more,
		next_page_token: more ? "page two/+" : null,
	};
}

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	// Disposable in-memory keys keep real v2/v3 signing without consulting a key store.
	const keys = generateKeyPairSync("ed25519");
	vi.spyOn(identity, "ensureDeviceIdentity").mockReturnValue([localId, "ed25519 fixture"]);
	vi.spyOn(identity, "loadPrivateKey").mockReturnValue(
		Buffer.from(keys.privateKey.export({ format: "pem", type: "pkcs8" })),
	);
	vi.spyOn(http, "requestJson").mockImplementation(async () => {
		throw new Error("injected request escaped to default HTTP");
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("unexpected network request");
		}),
	);
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
	).run(peerId, "executor-fingerprint", timestamp);
	db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
			membership_epoch, status, created_at, updated_at)
			VALUES (?, 'Executor scope', 'team', 'coordinator', 1, 'active', ?, ?)`).run(
		scopeId,
		timestamp,
		timestamp,
	);
	for (const deviceId of [localId, peerId]) {
		db.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status,
				membership_epoch, updated_at) VALUES (?, ?, 'member', 'active', 1, ?)`).run(
			scopeId,
			deviceId,
			timestamp,
		);
	}
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	db.close();
});

function seedOps() {
	for (const index of [1, 2]) {
		const time = `2026-01-01T00:00:0${index}Z`;
		db.prepare(`INSERT INTO replication_ops(op_id, entity_type, entity_id, op_type,
				payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at, scope_id)
				VALUES (?, 'memory_item', ?, 'upsert', ?, 1, ?, ?, ?, ?, ?)`).run(
			`executor-op-${index}`,
			`executor-memory-${index}`,
			JSON.stringify({ visibility: "shared", scope_id: scopeId }),
			time,
			localId,
			localId,
			time,
			scopeId,
		);
	}
}

it.each([false, true])(
	"routes %s scoped exchanges and recursive 413 pushes through one executor",
	async (scoped) => {
		// Arrange: every split must sign its own serialized body, with no new timeout policy.
		setReplicationCursor(db, peerId, { lastApplied: cursor });
		if (scoped) setReplicationCursor(db, peerId, { lastApplied: cursor }, scopeId);
		seedOps();
		const signing = vi.spyOn(syncAuth, "buildDirectPeerAuthHeaders");
		let pushes = 0;
		const executor = vi.fn<RequestJsonExecutor>(async (method, url) => {
			if (url.endsWith("/v1/status")) return [200, statusPayload(scoped)];
			if (method === "GET") return [200, emptyOps()];
			pushes++;
			if (pushes === 1) return [413, { error: "too_many_ops" }];
			return [200, { errors: [] }];
		});

		// Act
		const result = await syncOnce(db, peerId, [baseUrl], { requestExecutor: executor });

		// Assert
		expect(result.ok).toBe(true);
		const calls = executor.mock.calls;
		expect(calls[0]?.slice(0, 2)).toEqual(["GET", `${baseUrl}/v1/status`]);
		const pushCalls = calls.filter(([method]) => method === "POST");
		expect(
			pushCalls.map(([, , options]) => (options?.body?.ops as unknown[] | undefined)?.length),
		).toEqual([2, 1, 1]);
		if (scoped) {
			expect(
				calls.some(
					([method, url]) =>
						method === "GET" && new URL(url).searchParams.get("scope_id") === scopeId,
				),
			).toBe(true);
		}
		// Scoped outbound operations currently use the same default ops endpoint.
		expect(pushCalls.every(([, url]) => url === `${baseUrl}/v1/ops`)).toBe(true);
		for (const [method, url, options] of calls) {
			expect(options?.headers).toMatchObject({
				"X-Codemem-Recipient": peerId,
				"X-Codemem-Signature": expect.stringMatching(/^v3:/),
				[SYNC_CAPABILITY_HEADER]: "scoped",
			});
			expect(options).not.toHaveProperty("timeoutS");
			expect(options).not.toHaveProperty("maxResponseBytes");
			expect(options).not.toHaveProperty("redirect");
			const signed = signing.mock.calls.find(
				([input]) =>
					input.url === url &&
					input.method === method &&
					input.bodyBytes.equals(Buffer.from(options?.bodyBytes ?? [])),
			);
			expect(signed).toBeDefined();
			if (method === "POST") {
				expect(Buffer.from(options?.bodyBytes ?? []).toString()).toBe(
					JSON.stringify(options?.body),
				);
			}
		}
		expect(
			new Set(pushCalls.map(([, , options]) => options?.headers?.["X-Codemem-Signature"])).size,
		).toBe(3);
		expect(http.requestJson).not.toHaveBeenCalled();
	},
);

it.each([false, true])(
	"reports %s scoped injected pull failures without default HTTP fallback",
	async (scoped) => {
		// Arrange
		setReplicationCursor(db, peerId, { lastApplied: cursor });
		if (scoped) setReplicationCursor(db, peerId, { lastApplied: cursor }, scopeId);
		const executor = vi.fn<RequestJsonExecutor>(async (_method, url) => {
			if (url.endsWith("/v1/status")) return [200, statusPayload(scoped)];
			if (scoped && !new URL(url).searchParams.has("scope_id")) return [200, emptyOps()];
			return [503, { error: "executor_unavailable" }];
		});

		// Act
		const result = await syncOnce(db, peerId, [baseUrl], { requestExecutor: executor });

		// Assert
		expect(result.ok).toBe(false);
		expect(result.error).toContain("executor_unavailable");
		expect(getReplicationCursor(db, peerId)[0]).toBe(cursor);
		expect(http.requestJson).not.toHaveBeenCalled();
	},
);

it.each([
	{ name: "null HTTP 200 payload", status: 200, payload: null },
	{ name: "an unrelated 413 error", status: 413, payload: { error: "fixture_denied" } },
	{ name: "a single-op 413 after splitting", status: 413, payload: { error: "too_many_ops" } },
])("does not acknowledge a push with $name", async ({ status, payload }) => {
	// Arrange
	setReplicationCursor(db, peerId, { lastApplied: cursor });
	seedOps();
	const executor = vi.fn<RequestJsonExecutor>(async (method, url) => {
		if (url.endsWith("/v1/status")) return [200, statusPayload()];
		if (method === "GET") return [200, emptyOps()];
		return [status, payload];
	});

	// Act
	const result = await syncOnce(db, peerId, [baseUrl], { requestExecutor: executor });

	// Assert
	expect(result.ok).toBe(false);
	expect(getReplicationCursor(db, peerId)[1]).toBeNull();
	expect(executor.mock.calls.filter(([method]) => method === "POST")).toHaveLength(
		payload?.error === "too_many_ops" ? 2 : 1,
	);
	expect(http.requestJson).not.toHaveBeenCalled();
});

it("preserves source binding on every injected snapshot page and rejects a changed boundary", async () => {
	// Arrange
	const executor = vi
		.fn<RequestJsonExecutor>()
		.mockResolvedValueOnce([200, { ...snapshotPage(true), source_device_id: peerId }])
		.mockResolvedValueOnce([200, { ...snapshotPage(false), source_device_id: peerId }]);
	const options = { recipientId: peerId, sourceDeviceId: peerId, requestExecutor: executor };

	// Act
	const result = await fetchAllSnapshotPages(baseUrl, reset, localId, options);
	executor.mockResolvedValueOnce([
		200,
		{
			...snapshotPage(false),
			source_device_id: peerId,
			generation: 2,
		},
	]);
	const changed = fetchAllSnapshotPages(baseUrl, reset, localId, options);

	// Assert
	expect(result.items).toEqual([]);
	await expect(changed).rejects.toThrow("snapshot_boundary_mismatch");
	expect(
		executor.mock.calls.map(([, url]) => new URL(url).searchParams.get("source_device_id")),
	).toEqual([peerId, peerId, peerId]);
	expect(http.requestJson).not.toHaveBeenCalled();
});

it.each(["initial", "reset", "scoped bootstrap", "scoped merge"] as const)(
	"propagates the executor through %s and every snapshot page",
	async (flow) => {
		// Arrange: exercise real snapshot fetching/application rather than mocking the seam.
		if (flow !== "initial") setReplicationCursor(db, peerId, { lastApplied: cursor });
		if (flow === "scoped merge") {
			const session = insertTestSession(db);
			db.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, import_key,
					visibility, scope_id, created_at, updated_at, origin_device_id, rev)
					VALUES (?, 'discovery', 'Preserved', 'Local row', 'executor-existing',
					'shared', ?, ?, ?, ?, 1)`).run(session, scopeId, timestamp, timestamp, peerId);
		}
		let pages = 0;
		const executor = vi.fn<RequestJsonExecutor>(async (_method, url) => {
			if (url.endsWith("/v1/status")) return [200, statusPayload(flow.startsWith("scoped"))];
			if (new URL(url).pathname === "/v1/ops") {
				if (flow === "reset") return [409, reset as unknown as Record<string, unknown>];
				return [200, emptyOps()];
			}
			pages++;
			return [200, snapshotPage(pages === 1)];
		});

		// Act
		const result = await syncOnce(db, peerId, [baseUrl], { requestExecutor: executor });

		// Assert
		expect(result.ok).toBe(true);
		const snapshots = executor.mock.calls.filter(
			([, url]) => new URL(url).pathname === "/v1/snapshot",
		);
		expect(snapshots).toHaveLength(2);
		expect(snapshots.map(([, url]) => new URL(url).searchParams.get("page_token"))).toEqual([
			null,
			"page two/+",
		]);
		for (const [method, url, options] of snapshots) {
			expect(method).toBe("GET");
			expect(Object.fromEntries(new URL(url).searchParams)).toMatchObject({
				scope_id: scopeId,
				limit: flow === "reset" ? "200" : "2000",
				generation: "1",
				snapshot_id: boundary.snapshot_id,
				baseline_cursor: cursor,
			});
			expect(options).toEqual({
				headers: expect.objectContaining({
					"X-Codemem-Recipient": peerId,
					"X-Codemem-Signature": expect.stringMatching(/^v3:/),
					[SYNC_CAPABILITY_HEADER]: "scoped",
				}),
				timeoutS: 60,
			});
		}
		if (flow === "scoped merge") {
			expect(
				db.prepare("SELECT title FROM memory_items WHERE import_key = 'executor-existing'").get(),
			).toEqual({ title: "Preserved" });
		}
		expect(http.requestJson).not.toHaveBeenCalled();
	},
);

it.each(["initial", "reset", "scoped bootstrap", "scoped merge"] as const)(
	"reports %s snapshot executor failures without retrying via default HTTP",
	async (flow) => {
		// Arrange
		if (flow !== "initial") setReplicationCursor(db, peerId, { lastApplied: cursor });
		if (flow === "scoped merge") {
			const session = insertTestSession(db);
			db.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, import_key,
					visibility, scope_id, created_at, updated_at)
					VALUES (?, 'discovery', 'Preserved', 'Local row', 'executor-existing', 'shared', ?, ?, ?)`).run(
				session,
				scopeId,
				timestamp,
				timestamp,
			);
		}
		const executor = vi.fn<RequestJsonExecutor>(async (_method, url) => {
			if (url.endsWith("/v1/status")) return [200, statusPayload(flow.startsWith("scoped"))];
			if (new URL(url).pathname === "/v1/ops") {
				if (flow === "reset") return [409, reset as unknown as Record<string, unknown>];
				return [200, emptyOps()];
			}
			throw new Error("fixture snapshot transport failed");
		});

		// Act
		const result = await syncOnce(db, peerId, [baseUrl], { requestExecutor: executor });

		// Assert
		expect(result.ok).toBe(false);
		expect(result.error).toContain("fixture snapshot transport failed");
		expect(http.requestJson).not.toHaveBeenCalled();
	},
);

it.each([undefined, peerId])(
	"preserves snapshot auth and the 10-second default with recipient %s",
	async (recipientId) => {
		// Arrange
		const executor = vi.fn<RequestJsonExecutor>().mockResolvedValue([200, snapshotPage(false)]);

		// Act
		const result = await fetchAllSnapshotPages(baseUrl, reset, localId, {
			recipientId,
			requestExecutor: executor,
		});

		// Assert
		expect(result).toEqual({
			items: [],
			generation: boundary.generation,
			snapshot_id: boundary.snapshot_id,
			baseline_cursor: cursor,
		});
		expect(executor).toHaveBeenCalledOnce();
		const options = executor.mock.calls[0]?.[2];
		expect(options).toEqual({ headers: expect.any(Object), timeoutS: 10 });
		if (recipientId) {
			expect(options?.headers).toMatchObject({
				"X-Codemem-Recipient": recipientId,
				"X-Codemem-Signature": expect.stringMatching(/^v3:/),
			});
		} else {
			expect(options?.headers).not.toHaveProperty("X-Codemem-Recipient");
			expect(options?.headers?.["X-Opencode-Signature"]).toMatch(/^v2:/);
		}
		expect(http.requestJson).not.toHaveBeenCalled();
	},
);

it("retains source binding and boundary validation with an injected snapshot executor", async () => {
	// Arrange
	const executor = vi.fn<RequestJsonExecutor>().mockResolvedValue([
		200,
		{
			...snapshotPage(false),
			source_device_id: "different-source",
		},
	]);

	// Act
	const result = fetchAllSnapshotPages(baseUrl, reset, localId, {
		recipientId: peerId,
		sourceDeviceId: peerId,
		requestExecutor: executor,
		timeoutS: 17,
	});

	// Assert
	await expect(result).rejects.toThrow("retirement_snapshot_source_required");
	expect(new URL(executor.mock.calls[0]?.[1] ?? "").searchParams.get("source_device_id")).toBe(
		peerId,
	);
	expect(executor.mock.calls[0]?.[2]?.timeoutS).toBe(17);
	expect(http.requestJson).not.toHaveBeenCalled();
});

it("isolates overlapping sync invocations and restores default behavior when omitted", async () => {
	// Arrange: hold the first request until the second invocation has started.
	setReplicationCursor(db, peerId, { lastApplied: cursor });
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = vi.fn<RequestJsonExecutor>(async (_method, url) => {
		if (url.endsWith("/v1/status")) {
			await held;
			return [200, statusPayload()];
		}
		return [200, emptyOps()];
	});
	const second = vi.fn<RequestJsonExecutor>(async (_method, url) => {
		if (url.endsWith("/v1/status")) {
			release();
			return [503, { error: "second executor" }];
		}
		throw new Error("second executor received first invocation's pull");
	});

	// Act
	const results = await Promise.all([
		syncOnce(db, peerId, [baseUrl], { requestExecutor: first }),
		syncOnce(db, peerId, [baseUrl], { requestExecutor: second }),
	]);
	vi.mocked(http.requestJson).mockResolvedValue([503, { error: "default executor" }]);
	const omitted = await syncOnce(db, peerId, [baseUrl]);

	// Assert
	expect(results[0]?.ok).toBe(true);
	expect(results[1]?.error).toContain("second executor");
	expect(first).toHaveBeenCalledTimes(2);
	expect(second).toHaveBeenCalledOnce();
	expect(omitted.error).toContain("default executor");
	expect(http.requestJson).toHaveBeenCalledOnce();
});

it("uses default HTTP for snapshots when the executor option is omitted", async () => {
	// Arrange
	vi.mocked(http.requestJson).mockResolvedValue([200, snapshotPage(false)]);

	// Act
	const result = await fetchAllSnapshotPages(baseUrl, reset, localId);

	// Assert
	expect(result.items).toEqual([]);
	expect(http.requestJson).toHaveBeenCalledOnce();
	expect(http.requestJson).toHaveBeenCalledWith("GET", expect.stringContaining("/v1/snapshot?"), {
		headers: expect.any(Object),
		timeoutS: 10,
	});
});
