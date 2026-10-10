import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { ingestMain } from "./index.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import type { IngestPayload, SessionContext } from "./ingest-types.js";
import { refreshScopeMembershipCache } from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import { ScopeWriteAuthorityError } from "./scope-write-authority-error.js";
import { MemoryStore } from "./store.js";
import { storeVectors } from "./vectors.js";

vi.mock("./project.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./project.js")>()),
	resolveProject: () => "fixture-project",
	resolveGitRepositoryIdentity: () => null,
}));
vi.mock("./vectors.js", () => ({ storeVectors: vi.fn() }));

let directory: string;
let store: MemoryStore;
const observe = vi.fn(async () => ({
	raw: "<observation><type>bugfix</type><title>Parser validation fixed</title><narrative>The parser rejects invalid input before persistence.</narrative><facts><fact>Invalid input is rejected</fact></facts></observation>",
	parsed: null,
	provider: "test",
	model: "test-model",
}));
const options = {
	observer: {
		observe,
		getStatus: () => ({
			provider: "test",
			model: "test-model",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	},
} as unknown as IngestOptions;

function payload(sessionContext: SessionContext = {}): IngestPayload {
	return {
		cwd: directory,
		project: "fixture-project",
		events: [{ type: "user_prompt", prompt_text: "Fix the parser validation behavior" }],
		sessionContext,
	};
}

async function refreshAuthority({ membershipEpoch = 3 } = {}) {
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
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(cacheTime));
	directory = mkdtempSync(join(tmpdir(), "codemem-ingest-lifecycle-"));
	const path = join(directory, "test.sqlite");
	store = new MemoryStore(path);
	const deviceId = store.deviceId;
	store.close();
	store = new MemoryStore(path, {
		runtimeSigningKey: { deviceId, publicKey: CANONICAL_PUBLIC_KEY },
	});
	await refreshAuthority();
	store.db
		.prepare(
			"INSERT INTO project_scope_mappings(project_pattern, scope_id, priority, source, created_at, updated_at) VALUES (?, 'scope-a', 100, 'user', ?, ?)",
		)
		.run(directory, cacheTime, cacheTime);
	store.db.prepare("UPDATE scope_memberships SET status='revoked'").run();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

function expectNoCapture() {
	expect(observe).not.toHaveBeenCalled();
	expect(storeVectors).not.toHaveBeenCalled();
	for (const table of ["memory_items", "usage_events", "replication_ops"])
		expect(store.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
}

const freshContexts: Array<[string, SessionContext]> = [
	["direct", {}],
	["plugin", { source: "opencode" }],
	["raw label without identity", { flusher: "raw_events", streamId: "stream" }],
	["nonraw with identity", { flusher: "plugin", opencodeSessionId: "stream" }],
];

it.each(freshContexts)(
	"ends each denied fresh %s session and rethrows the same error",
	async (_name, context) => {
		// Arrange: record the real authority error without replacing its admission check.
		const input = payload(context);
		const assertWritable = store.assertSessionScopeWritable.bind(store);
		const errors: unknown[] = [];
		vi.spyOn(store, "assertSessionScopeWritable").mockImplementation((id) => {
			try {
				return assertWritable(id);
			} catch (error) {
				errors.push(error);
				throw error;
			}
		});
		// Act: each invocation creates a fresh session, not a retryable stream session.
		for (let attempt = 0; attempt < 2; attempt++) {
			const error = await ingest(input, store, options).catch((cause: unknown) => cause);
			expect(error).toBeInstanceOf(ScopeWriteAuthorityError);
			expect(error).toBe(errors[attempt]);
		}
		// Assert: normal cleanup retains rows and metadata, but leaves no open sessions or capture.
		const sessions = store.db
			.prepare("SELECT ended_at, metadata_json FROM sessions")
			.all() as Array<{ ended_at: string; metadata_json: string }>;
		expect(sessions).toHaveLength(2);
		for (const session of sessions) {
			expect(session.ended_at).toBe(new Date(cacheTime).toISOString());
			expect(JSON.parse(session.metadata_json)).toMatchObject({
				source: "plugin",
				event_count: 1,
				post: {},
			});
		}
		expect(store.db.prepare("SELECT * FROM opencode_sessions").all()).toEqual([]);
		expectNoCapture();
	},
);

it("ends fresh sessions denied through exported ingestMain on repeated invocations", async () => {
	// Arrange: mock stdin only; use the exported public API and actual managed authority.
	const input = JSON.stringify(payload());
	vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
		yield input;
	});
	// Act
	for (let attempt = 0; attempt < 2; attempt++)
		await expect(ingestMain(store, options.observer)).rejects.toBeInstanceOf(
			ScopeWriteAuthorityError,
		);
	// Assert
	expect(store.db.prepare("SELECT ended_at FROM sessions").all()).toEqual([
		{ ended_at: new Date(cacheTime).toISOString() },
		{ ended_at: new Date(cacheTime).toISOString() },
	]);
	expectNoCapture();
});

it("completes an authorized capture through exported ingestMain", async () => {
	// Arrange
	await refreshAuthority({ membershipEpoch: 4 });
	const input = JSON.stringify(payload());
	vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
		yield input;
	});
	// Act
	await ingestMain(store, options.observer);
	// Assert
	expect(observe).toHaveBeenCalledTimes(1);
	expect(store.db.prepare("SELECT ended_at FROM sessions").get()).toEqual({
		ended_at: new Date(cacheTime).toISOString(),
	});
	expect(store.db.prepare("SELECT scope_id FROM memory_items").all()).toEqual([
		{ scope_id: "scope-a" },
	]);
});

it.each(freshContexts)("completes an authorized fresh %s capture", async (_name, context) => {
	// Arrange
	await refreshAuthority({ membershipEpoch: 4 });
	// Act
	await ingest(payload(context), store, options);
	// Assert
	expect(observe).toHaveBeenCalledTimes(1);
	expect(store.db.prepare("SELECT ended_at FROM sessions").get()).toEqual({
		ended_at: new Date(cacheTime).toISOString(),
	});
	expect(store.db.prepare("SELECT scope_id FROM memory_items").all()).toEqual([
		{ scope_id: "scope-a" },
	]);
});

it.each(["raw", "historical"])(
	"retains denied %s session state and recovers after authority refresh",
	async (mode) => {
		// Arrange: raw identity is reusable even without flushBatch; historical needs only its validated stream link.
		const sessionId = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "stream",
			source: "opencode",
			cwd: directory,
			project: "fixture-project",
			metadata: { original: true },
			startedAt: "2026-09-01T00:00:00.000Z",
			toolVersion: "raw_events",
		});
		if (mode === "historical") store.endSession(sessionId, { retained: true });
		const context: SessionContext = {
			flusher: "raw_events",
			source: "opencode",
			streamId: "stream",
		};
		if (mode === "raw") context.opencodeSessionId = "stream";
		const settings: IngestOptions = { ...options };
		if (mode === "historical")
			settings.historicalRecovery = { sessionId, occurredAt: "2026-09-01T01:00:00.000Z" };
		const sessionBefore = store.db.prepare("SELECT * FROM sessions").all();
		const linkBefore = store.db.prepare("SELECT * FROM opencode_sessions").all();
		// Act
		for (let attempt = 0; attempt < 2; attempt++)
			await expect(ingest(payload(context), store, settings)).rejects.toBeInstanceOf(
				ScopeWriteAuthorityError,
			);
		// Assert: neither retries nor cleanup change identity, origin, time, or retained metadata.
		expect(store.db.prepare("SELECT * FROM sessions").all()).toEqual(sessionBefore);
		expect(store.db.prepare("SELECT * FROM opencode_sessions").all()).toEqual(linkBefore);
		expectNoCapture();
		// Act: a new current proof admits the same context without creating another session.
		await refreshAuthority({ membershipEpoch: 4 });
		await ingest(payload(context), store, settings);
		// Assert
		expect(observe).toHaveBeenCalledTimes(1);
		expect(store.db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: sessionId }]);
		expect(store.db.prepare("SELECT scope_id FROM memory_items").all()).toEqual([
			{ scope_id: "scope-a" },
		]);
		if (mode === "historical")
			expect(store.db.prepare("SELECT * FROM sessions").all()).toEqual(sessionBefore);
	},
);
