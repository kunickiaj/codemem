import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import type { IngestPayload } from "./ingest-types.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { refreshScopeMembershipCache } from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import { ScopeWriteAuthorityError } from "./scope-write-authority-error.js";
import { MemoryStore } from "./store.js";

vi.mock("./project.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./project.js")>()),
	resolveProject: () => "fixture-project",
	resolveGitRepositoryIdentity: () => null,
}));
vi.mock("./vectors.js", () => ({ storeVectors: vi.fn() }));

const input: IngestPayload = {
	cwd: "/fixture/project",
	project: "fixture-project",
	events: [
		{ type: "user_prompt", prompt_text: "Fix the parser validation behavior", prompt_number: 1 },
	],
	sessionContext: {
		source: "opencode",
		streamId: "scope-stream",
		opencodeSessionId: "scope-stream",
		flusher: "raw_events",
	},
};
const options = {
	storeSummary: false,
	observer: {
		observe: vi.fn(async () => ({
			raw: ["Parser validation fixed", "Parser regression covered"]
				.map(
					(title) =>
						`<observation><type>bugfix</type><title>${title}</title><narrative>The parser now rejects invalid input before persistence.</narrative><facts><fact>Invalid input is rejected</fact></facts><concepts><concept>validation</concept></concepts><files_read><file>parser.ts</file></files_read><files_modified><file>parser.ts</file></files_modified></observation>`,
				)
				.join(""),
			parsed: null,
			provider: "test",
			model: "test-model",
			usage: { inputTokens: 5, outputTokens: 7 },
		})),
		getStatus: () => ({
			provider: "test",
			model: "test-model",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	},
} as unknown as IngestOptions;

async function mapScope(store: MemoryStore, { membershipEpoch = 3 } = {}) {
	const scope = cacheScope({ kind: "managed_project", membership_epoch: membershipEpoch });
	const snapshot = cacheWireSnapshot(scope, [cacheMember(scope, store.deviceId)]);
	await refreshScopeMembershipCache(store.db, {
		coordinatorId: "server-a",
		groupIds: ["group-a"],
		now: new Date(cacheTime),
		fetchers: {
			listScopes: async () => ({ version: 1, items: [scope] }),
			getScopeSnapshot: async () => snapshot,
		},
	});
	store.db
		.prepare(
			"INSERT INTO project_scope_mappings(project_pattern, scope_id, priority, source, created_at, updated_at) VALUES ('/fixture/*', 'scope-a', 100, 'user', ?, ?)",
		)
		.run(cacheTime, cacheTime);
}

describe("automatic ingest current scope authority", () => {
	let directory: string;
	let store: MemoryStore;
	beforeEach(() => {
		vi.clearAllMocks();
		directory = mkdtempSync(join(tmpdir(), "codemem-ingest-authority-"));
		const dbPath = join(directory, "test.sqlite");
		store = new MemoryStore(dbPath);
		const deviceId = store.deviceId;
		store.close();
		store = new MemoryStore(dbPath, {
			runtimeSigningKey: { deviceId, publicKey: CANONICAL_PUBLIC_KEY },
		});
	});
	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it.each(["missing proof", "revoked", "wrong key"])(
		"denies %s without persisting or completing the session on retries",
		async (failure) => {
			// Arrange: mapped authority is historical unless the actual key still has a current proof.
			await mapScope(store);
			if (failure === "missing proof")
				store.db.prepare("DELETE FROM scope_membership_authorization_evidence").run();
			if (failure === "revoked")
				store.db.prepare("UPDATE scope_memberships SET status = 'revoked'").run();
			if (failure === "wrong key")
				vi.spyOn(store, "scopeResolutionDeviceContext").mockReturnValue({
					expectedPublicKey: "ssh-ed25519 invalid",
				});
			const sessionId = store.getOrCreateSessionForOpencodeSession({
				opencodeSessionId: "scope-stream",
				cwd: input.cwd,
				project: input.project,
			});
			const before = store.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
			const replicationBefore = store.db.prepare("SELECT * FROM replication_ops").all();
			// Act: retries must keep failing, rather than deduping an unauthorized first write.
			for (let attempt = 0; attempt < 2; attempt++)
				await expect(ingest(input, store, options)).rejects.toThrow("unauthorized_scope");
			// Assert: denial before inference leaves no paid usage or partial capture.
			expect(store.db.prepare("SELECT * FROM memory_items").all()).toEqual([]);
			expect(store.db.prepare("SELECT * FROM replication_ops").all()).toEqual(replicationBefore);
			expect(store.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId)).toEqual(
				before,
			);
			expect(store.db.prepare("SELECT * FROM usage_events").all()).toHaveLength(0);
		},
	);

	it.each(["managed", "local", "manual"])(
		"persists %s captures with source metadata",
		async (mode) => {
			// Arrange
			if (mode !== "local") await mapScope(store);
			if (mode === "manual") {
				store.db.prepare("UPDATE replication_scopes SET authority_type = 'manual'").run();
				store.db.prepare("DELETE FROM scope_membership_authorization_evidence").run();
				vi.spyOn(store, "scopeResolutionDeviceContext").mockReturnValue({
					loadExpectedPublicKey: () => {
						throw new Error("Signing key unavailable");
					},
				});
			}
			// Act
			await ingest(input, store, options);
			// Assert
			const rows = store.db
				.prepare("SELECT scope_id, files_read, metadata_json FROM memory_items")
				.all() as Array<{ scope_id: string; files_read: string; metadata_json: string }>;
			expect(rows).toHaveLength(2);
			for (const row of rows) {
				expect(row.scope_id).toBe(mode === "local" ? "local-default" : "scope-a");
				expect(JSON.parse(row.files_read)).toEqual(["parser.ts"]);
				expect(JSON.parse(row.metadata_json)).toMatchObject({
					observer_provider: "test",
					source: "observer",
					prompt_number: 1,
				});
			}
			expect(store.db.prepare("SELECT ended_at FROM sessions").get()).toMatchObject({
				ended_at: expect.any(String),
			});
		},
	);

	it("rolls back earlier planned writes and replication when authority disappears mid-plan", async () => {
		// Arrange: the second write must check authority even after the first succeeded.
		await mapScope(store);
		const remember = store.remember.bind(store);
		let calls = 0;
		vi.spyOn(store, "remember").mockImplementation((...args) => {
			const id = remember(...args);
			if (++calls === 1) store.db.prepare("UPDATE scope_memberships SET status = 'revoked'").run();
			return id;
		});
		const before = store.db.prepare("SELECT * FROM replication_ops").all();
		// Act
		await expect(ingest(input, store, options)).rejects.toThrow("unauthorized_scope");
		// Assert: the outer ingest transaction rolls back both writes and supersession effects.
		expect(calls).toBe(1);
		expect(store.db.prepare("SELECT * FROM memory_items").all()).toEqual([]);
		expect(store.db.prepare("SELECT * FROM replication_ops").all()).toEqual(before);
		expect(store.db.prepare("SELECT ended_at FROM sessions").get()).toEqual({ ended_at: null });
	});

	it("denies dedup retries after revocation without touching the completed capture", async () => {
		// Arrange
		await mapScope(store);
		await ingest(input, store, options);
		store.db.prepare("UPDATE scope_memberships SET status = 'revoked'").run();
		const memories = store.db.prepare("SELECT * FROM memory_items").all();
		const replication = store.db.prepare("SELECT * FROM replication_ops").all();
		const sessions = store.db.prepare("SELECT * FROM sessions").all();
		// Act
		await expect(ingest(input, store, options)).rejects.toThrow("unauthorized_scope");
		// Assert
		expect(store.db.prepare("SELECT * FROM memory_items").all()).toEqual(memories);
		expect(store.db.prepare("SELECT * FROM replication_ops").all()).toEqual(replication);
		expect(store.db.prepare("SELECT * FROM sessions").all()).toEqual(sessions);
	});
});

describe("raw flush scope authority retry admission", () => {
	let directory: string;
	let store: MemoryStore;
	beforeEach(() => {
		vi.clearAllMocks();
		directory = mkdtempSync(join(tmpdir(), "codemem-flush-authority-"));
		const path = join(directory, "test.sqlite");
		store = new MemoryStore(path);
		const deviceId = store.deviceId;
		store.close();
		store = new MemoryStore(path, {
			runtimeSigningKey: { deviceId, publicKey: CANONICAL_PUBLIC_KEY },
		});
		store.recordRawEvent({
			opencodeSessionId: "scope-stream",
			eventId: "prompt",
			eventType: "user_prompt",
			payload: {
				type: "user_prompt",
				prompt_text: "Fix the parser validation behavior",
				prompt_number: 1,
			},
			tsWallMs: 100,
		});
		store.recordRawEvent({
			opencodeSessionId: "scope-stream",
			eventId: "tool",
			eventType: "tool.execute.after",
			payload: {
				type: "tool.execute.after",
				tool: "edit",
				args: { filePath: "parser.ts" },
				result: "Updated parser validation",
			},
			tsWallMs: 200,
		});
	});
	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});
	const flushOptions = {
		opencodeSessionId: "scope-stream",
		source: "opencode",
		cwd: input.cwd,
		project: input.project,
	};
	function batch() {
		return store.db
			.prepare(
				"SELECT status, attempt_count, error_type, observer_provider, observer_error_code, observer_error_message FROM raw_event_flush_batches",
			)
			.get();
	}

	it("retains more than five denied flushes without calling the provider, then resumes after membership refresh", async () => {
		// Arrange: retain mapping but revoke the current membership.
		await mapScope(store);
		store.db.prepare("UPDATE scope_memberships SET status = 'revoked'").run();
		// Act: every denial is admission failure, not an observer attempt.
		for (let attempt = 0; attempt < 7; attempt++) {
			await expect(flushRawEvents(store, options, flushOptions)).rejects.toBeInstanceOf(
				ScopeWriteAuthorityError,
			);
			expect(batch()).toEqual({
				status: "failed",
				attempt_count: 0,
				error_type: "ScopeWriteAuthorityError",
				observer_provider: null,
				observer_error_code: null,
				observer_error_message: null,
			});
			expect(store.rawEventFlushState("scope-stream")).toBe(-1);
		}
		// Assert: neither abandonment nor billing occurred.
		expect(options.observer.observe).not.toHaveBeenCalled();
		expect(store.db.prepare("SELECT * FROM memory_items").all()).toEqual([]);
		expect(store.db.prepare("SELECT * FROM usage_events").all()).toEqual([]);
		// Arrange/Act: a newer epoch restores revoked membership, then retries the same batch.
		await mapScope(store, { membershipEpoch: 4 });
		const result = await flushRawEvents(store, options, flushOptions);
		// Assert
		expect(result.updatedState).toBe(1);
		expect(store.rawEventFlushState("scope-stream")).toBe(1);
		expect(batch()).toMatchObject({ status: "completed", attempt_count: 1, error_type: null });
		expect(options.observer.observe).toHaveBeenCalledTimes(1);
		expect(store.db.prepare("SELECT * FROM memory_items").all()).toHaveLength(2);
	});

	it("retains more than five denied flushes without calling the provider, then resumes after proof refresh", async () => {
		// Arrange: retain mapping and historical membership but remove the current proof.
		await mapScope(store);
		store.db.prepare("DELETE FROM scope_membership_authorization_evidence").run();
		// Act: every denial is admission failure, not an observer attempt.
		for (let attempt = 0; attempt < 7; attempt++) {
			await expect(flushRawEvents(store, options, flushOptions)).rejects.toBeInstanceOf(
				ScopeWriteAuthorityError,
			);
			expect(batch()).toEqual({
				status: "failed",
				attempt_count: 0,
				error_type: "ScopeWriteAuthorityError",
				observer_provider: null,
				observer_error_code: null,
				observer_error_message: null,
			});
			expect(store.rawEventFlushState("scope-stream")).toBe(-1);
		}
		// Assert: neither abandonment nor billing occurred.
		expect(options.observer.observe).not.toHaveBeenCalled();
		expect(store.db.prepare("SELECT * FROM memory_items").all()).toEqual([]);
		expect(store.db.prepare("SELECT * FROM usage_events").all()).toEqual([]);
		// Arrange/Act: restore a current enrollment snapshot and retry the same batch.
		await mapScope(store);
		const result = await flushRawEvents(store, options, flushOptions);
		// Assert
		expect(result.updatedState).toBe(1);
		expect(store.rawEventFlushState("scope-stream")).toBe(1);
		expect(batch()).toMatchObject({ status: "completed", attempt_count: 1, error_type: null });
		expect(options.observer.observe).toHaveBeenCalledTimes(1);
		expect(store.db.prepare("SELECT * FROM memory_items").all()).toHaveLength(2);
	});

	it("flushes ordinary local captures without managed authority", async () => {
		// Arrange: no managed mapping or proof.
		// Act
		const result = await flushRawEvents(store, options, flushOptions);
		// Assert
		expect(result.updatedState).toBe(1);
		expect(batch()).toMatchObject({ status: "completed", attempt_count: 1 });
		expect(options.observer.observe).toHaveBeenCalledTimes(1);
	});
});
