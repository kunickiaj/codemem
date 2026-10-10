import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { ObserverAuthError } from "./observer-client.js";
import { recoverOneMissingAuthWindow } from "./raw-event-auth-recovery.js";
import { planRawEventRecoveryWindows } from "./raw-event-recovery-windows.js";
import { RawEventSweeper } from "./raw-event-sweeper.js";
import { refreshScopeMembershipCache } from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import { ScopeWriteAuthorityError } from "./scope-write-authority-error.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

vi.mock("./vectors.js", () => ({ storeVectors: vi.fn() }));

let dir: string;
let store: MemoryStore;
let sessionId: number;
const eventTime = Date.parse("2026-09-21T10:00:00.000Z");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-auth-recovery-"));
	const path = join(dir, "test.sqlite");
	const db = connect(path);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(path);
	sessionId = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "missed-session",
		source: "opencode",
		cwd: dir,
		project: "codemem",
		metadata: { source: "plugin" },
		startedAt: "2026-09-21T09:00:00.000Z",
		toolVersion: "raw_events",
	});
	store.endSession(sessionId, { original: true });
	store.recordRawEvent({
		opencodeSessionId: "missed-session",
		eventId: "prompt",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Investigate validated callback" },
		tsWallMs: eventTime - 1000,
	});
	store.recordRawEvent({
		opencodeSessionId: "missed-session",
		eventId: "tool",
		eventType: "tool.execute.after",
		payload: {
			type: "tool.execute.after",
			tool: "read",
			args: { filePath: "fixture.ts" },
			result: "Use validated callback.",
		},
		tsWallMs: eventTime,
	});
	const batch = store.getOrCreateRawEventFlushBatch(
		"missed-session",
		"opencode",
		0,
		1,
		"raw_events_v1",
	);
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='gave_up', observer_error_code='auth_missing', attempt_count=5 WHERE id=?",
		)
		.run(batch.batchId);
	store.updateRawEventFlushState("missed-session", 1);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function options(): { settings: IngestOptions; observe: ReturnType<typeof vi.fn> } {
	const observe = vi.fn(async () => ({
		raw: "<observation><type>discovery</type><title>Validated callback</title><narrative>Use the validated callback before saving.</narrative></observation>",
		parsed: null,
		provider: "test",
		model: "test",
	}));
	return {
		observe,
		settings: {
			observer: {
				observe,
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "test", hasToken: true },
				}),
			} as unknown as IngestOptions["observer"],
		},
	};
}

async function refreshHistoricalScope(membershipEpoch: number) {
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

function recoveryBatch() {
	return store.db
		.prepare(
			"SELECT id, source, stream_id, start_event_seq, end_event_seq, status, attempt_count, error_type, observer_provider, observer_error_code, observer_error_message FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
		)
		.get();
}

function retainedHistory() {
	return {
		session: store.db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId),
		link: store.db.prepare("SELECT * FROM opencode_sessions").all(),
		events: store.db.prepare("SELECT * FROM raw_events").all(),
		state: store.db.prepare("SELECT * FROM raw_event_sessions").all(),
		replication: store.db.prepare("SELECT * FROM replication_ops").all(),
		sourceBatch: store.db
			.prepare("SELECT * FROM raw_event_flush_batches WHERE extractor_version='raw_events_v1'")
			.get(),
	};
}

async function mapHistoricalScope({ revoked = true } = {}) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(cacheTime));
	const deviceId = store.deviceId;
	store.close();
	store = new MemoryStore(join(dir, "test.sqlite"), {
		runtimeSigningKey: { deviceId, publicKey: CANONICAL_PUBLIC_KEY },
	});
	await refreshHistoricalScope(3);
	store.db
		.prepare(
			"INSERT INTO project_scope_mappings(project_pattern, scope_id, priority, source, created_at, updated_at) VALUES (?, 'scope-a', 100, 'user', ?, ?)",
		)
		.run(dir, cacheTime, cacheTime);
	if (revoked) store.db.prepare("UPDATE scope_memberships SET status='revoked'").run();
	store.db
		.prepare("UPDATE raw_event_flush_batches SET created_at=? WHERE stream_id='missed-session'")
		.run(cacheTime);
}

function addHistoricalStream(streamId: string, { cwd = join(dir, "unmanaged") } = {}) {
	store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: streamId,
		source: "opencode",
		cwd,
		project: "unmanaged",
		metadata: { source: "plugin" },
		startedAt: "2026-09-21T09:00:00.000Z",
		toolVersion: "raw_events",
	});
	store.recordRawEvent({
		opencodeSessionId: streamId,
		eventId: `${streamId}-prompt`,
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Recover historical context" },
		tsWallMs: eventTime,
	});
	const batch = store.getOrCreateRawEventFlushBatch(streamId, "opencode", 0, 0, "raw_events_v1");
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='gave_up', observer_error_code='auth_missing', attempt_count=5, created_at=? WHERE id=?",
		)
		.run(new Date(Date.now() + 1000).toISOString(), batch.batchId);
	store.updateRawEventFlushState(streamId, 0);
}

it("passes 1,001 denied windows in one stream without starving default-cadence recovery", async () => {
	// Arrange: real alternating events and completed gaps prevent the planner from coalescing windows.
	await mapHistoricalScope();
	store.db.transaction(() => {
		store.db.prepare("UPDATE raw_event_flush_batches SET end_event_seq=0").run();
		for (let seq = 2; seq <= 2000; seq++) {
			store.recordRawEvent({
				opencodeSessionId: "missed-session",
				eventId: `historical-${seq}`,
				eventType: "user_prompt",
				payload: { type: "user_prompt", prompt_text: "Retain denied historical context" },
				tsWallMs: eventTime,
			});
		}
		for (let seq = 1; seq <= 2000; seq++) {
			const batch = store.getOrCreateRawEventFlushBatch(
				"missed-session",
				"opencode",
				seq,
				seq,
				"raw_events_v1",
			);
			store.db
				.prepare(`UPDATE raw_event_flush_batches SET status=?,
				observer_error_code=?, created_at=? WHERE id=?`)
				.run(
					seq % 2 ? "completed" : "gave_up",
					seq % 2 ? null : "auth_missing",
					cacheTime,
					batch.batchId,
				);
		}
		store.updateRawEventFlushState("missed-session", 2000);
	})();
	const ranges = (status: string) =>
		(
			store.db
				.prepare(`SELECT start_event_seq, end_event_seq
		FROM raw_event_flush_batches WHERE stream_id='missed-session' AND status=?`)
				.all(status) as Array<{ start_event_seq: number; end_event_seq: number }>
		).map((row) => ({
			source: "opencode",
			streamId: "missed-session",
			startEventSeq: row.start_event_seq,
			endEventSeq: row.end_event_seq,
		}));
	const windows = planRawEventRecoveryWindows(ranges("gave_up"), ranges("completed"), 100);
	expect(windows).toHaveLength(1001);
	expect(
		windows.every(
			(window) => window.startEventSeq === window.endEventSeq && window.startEventSeq % 2 === 0,
		),
	).toBe(true);
	vi.stubEnv("CODEMEM_RAW_EVENTS_RECOVERY_ENABLED", "1");
	vi.spyOn(console, "error").mockImplementation(() => {});
	const assertWritable = store.assertSessionScopeWritable.bind(store);
	let deniedAdmissions = 0;
	vi.spyOn(store, "assertSessionScopeWritable").mockImplementation((id, metadata) => {
		try {
			assertWritable(id, metadata);
		} catch (error) {
			if (error instanceof ScopeWriteAuthorityError) {
				deniedAdmissions++;
				// Fail fast on the old window-by-window loop without a slow 1,000-admission red run.
				expect(deniedAdmissions).toBeLessThanOrEqual(1);
			}
			throw error;
		}
	});
	const { settings, observe } = options();
	const sweeper = new RawEventSweeper(store, settings);

	// Act/Assert: repeat the default 30-second cadence, beyond the existing 15-second cooldown.
	for (let tick = 0; tick < 3; tick++) {
		deniedAdmissions = 0;
		addHistoricalStream(`healthy-${tick}`);
		const before = retainedHistory();
		await sweeper.tick();
		expect(observe).toHaveBeenCalledTimes(tick + 1);
		expect(deniedAdmissions).toBe(1);
		expect(retainedHistory()).toEqual(before);
		expect(
			store.db.prepare("SELECT * FROM memory_items WHERE session_id=?").all(sessionId),
		).toEqual([]);
		expect(recoveryBatch()).toMatchObject({
			stream_id: "missed-session",
			status: "failed",
			attempt_count: 0,
		});
		vi.setSystemTime(Date.now() + 30_000);
	}
	// Act: a newer membership epoch re-admits the original stream on the next call.
	await refreshHistoricalScope(4);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	// Assert: exclusions were call-local, and the fourth hourly invocation recovers the original window.
	expect(observe).toHaveBeenCalledTimes(4);
	expect(recoveryBatch()).toMatchObject({
		stream_id: "missed-session",
		start_event_seq: 0,
		end_event_seq: 0,
		status: "completed",
		attempt_count: 1,
	});
	expect(
		store.db
			.prepare("SELECT session_id, scope_id FROM memory_items WHERE session_id=?")
			.all(sessionId),
	).toEqual([{ session_id: sessionId, scope_id: "scope-a" }]);
});

it.each([
	{ deniedStream: "missed-session", source: "other", streamId: "missed-session" },
	{ deniedStream: "a:b", source: "opencode:a", streamId: "b" },
])(
	"keeps denied stream keys separate from $source / $streamId",
	async ({ deniedStream, source, streamId }) => {
		// Arrange: identical IDs across sources and colon-colliding tuples have distinct trusted links.
		await mapHistoricalScope();
		if (deniedStream !== "missed-session") {
			store.db.prepare("UPDATE raw_event_flush_batches SET status='completed'").run();
			addHistoricalStream(deniedStream, { cwd: dir });
		}
		const healthySession = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: streamId,
			source,
			cwd: join(dir, "unmanaged"),
			project: "unmanaged",
			metadata: { source: "plugin" },
			startedAt: new Date(eventTime).toISOString(),
			toolVersion: "raw_events",
		});
		store.recordRawEvent({
			opencodeSessionId: streamId,
			source,
			eventId: "healthy-prompt",
			eventType: "user_prompt",
			// Payload labels cannot borrow the denied session's scope or identity.
			payload: {
				type: "user_prompt",
				prompt_text: "Recover separate linked history",
				project: "codemem",
				session_id: sessionId,
			},
			tsWallMs: eventTime,
		});
		const batch = store.getOrCreateRawEventFlushBatch(streamId, source, 0, 0, "raw_events_v1");
		store.db
			.prepare(`UPDATE raw_event_flush_batches SET status='gave_up',
		observer_error_code='auth_missing', created_at=? WHERE id=?`)
			.run(new Date(Date.now() + 2000).toISOString(), batch.batchId);
		store.updateRawEventFlushState(streamId, 0, source);
		const before = retainedHistory();
		const { settings, observe } = options();

		// Act
		const recovered = await recoverOneMissingAuthWindow(store, settings);

		// Assert: only the actual authorized session receives a private observation.
		expect(recovered).toBe(true);
		expect(observe).toHaveBeenCalledTimes(1);
		expect(store.db.prepare("SELECT session_id, scope_id FROM memory_items").all()).toEqual([
			{ session_id: healthySession, scope_id: "local-default" },
		]);
		expect(retainedHistory()).toEqual(before);
		expect(
			store.db
				.prepare(`SELECT status, attempt_count FROM raw_event_flush_batches
		WHERE source='opencode' AND stream_id=? AND extractor_version='raw_events_auth_recovery_v1'`)
				.get(deniedStream),
		).toEqual({ status: "failed", attempt_count: 0 });
	},
);

it.each([false, true])(
	"charges the fourth post-inference denial without allowing a fifth call (tier routing: %s)",
	async (tierRouting) => {
		// Arrange: three real successful recoveries consume three hourly slots.
		await mapHistoricalScope({ revoked: false });
		const { settings, observe } = options();
		if (tierRouting) {
			const routedObserver = settings.observer;
			settings.observer = {
				...routedObserver,
				observe: vi.fn(),
				tierRoutingEnabled: true,
				toConfig: () => ({
					observerProvider: "openai",
					observerModel: "test",
					observerRuntime: "api_http",
					observerTierRoutingEnabled: true,
				}),
			} as IngestOptions["observer"];
			settings.createTierObserver = vi.fn(() => routedObserver);
		}
		for (let i = 0; i < 3; i++) addHistoricalStream(`prior-${i}`);
		store.db
			.prepare("UPDATE raw_event_flush_batches SET created_at=? WHERE stream_id='missed-session'")
			.run(new Date(Date.now() + 2000).toISOString());
		for (let i = 0; i < 3; i++)
			expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
		const response = await observe.mock.results[0].value;
		const startedAt = Date.now();
		observe.mockImplementationOnce(async () => {
			store.db.prepare("UPDATE scope_memberships SET status='revoked'").run();
			vi.setSystemTime(startedAt + 30_000);
			return response;
		});
		const beforeMemories = store.db.prepare("SELECT * FROM memory_items").all();
		const before = retainedHistory();

		// Act: the fourth actual invocation returns before persistence rolls back.
		await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
			ScopeWriteAuthorityError,
		);
		expect(observe).toHaveBeenCalledTimes(4);
		addHistoricalStream("fifth-authorized");
		const blocked = await recoverOneMissingAuthWindow(store, settings);

		// Assert: retries remain neutral, but the hourly slot survives outside the content transaction.
		expect(blocked).toBe(false);
		expect(observe).toHaveBeenCalledTimes(4);
		expect(
			store.db
				.prepare(
					"SELECT attempt_count FROM raw_event_flush_batches WHERE stream_id='missed-session' AND extractor_version='raw_events_auth_recovery_v1'",
				)
				.get(),
		).toEqual({ attempt_count: 0 });
		expect(store.db.prepare("SELECT * FROM memory_items").all()).toEqual(beforeMemories);
		expect(store.db.prepare("SELECT * FROM replication_ops").all()).toEqual(before.replication);
		expect(
			store.db
				.prepare(
					"SELECT created_at, session_id, metadata_json FROM usage_events WHERE event='observer_recovery_scope_denial'",
				)
				.all(),
		).toEqual([
			{ created_at: new Date(startedAt).toISOString(), session_id: null, metadata_json: null },
		]);

		// Act/Assert: start-time accounting expires exactly at the rolling-hour cutoff.
		vi.setSystemTime(startedAt + 3_600_000 - 1);
		expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
		expect(observe).toHaveBeenCalledTimes(4);
		vi.setSystemTime(startedAt + 3_600_000);
		expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
		expect(observe).toHaveBeenCalledTimes(5);
	},
);

it("stops repeated post-inference scope races at four even with zero attempts", async () => {
	// Arrange: each returned invocation revokes real membership; re-admit before the next retry.
	await mapHistoricalScope({ revoked: false });
	const { settings, observe } = options();
	const response = await observe();
	observe.mockClear();
	observe.mockImplementation(async () => {
		store.db.prepare("UPDATE scope_memberships SET status='revoked'").run();
		return response;
	});

	// Act
	for (let i = 0; i < 4; i++) {
		await refreshHistoricalScope(4 + i);
		await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
			ScopeWriteAuthorityError,
		);
		vi.setSystemTime(Date.now() + 30_000);
	}
	await refreshHistoricalScope(8);
	const blocked = await recoverOneMissingAuthWindow(store, settings);

	// Assert
	expect(blocked).toBe(false);
	expect(observe).toHaveBeenCalledTimes(4);
	expect(recoveryBatch()).toMatchObject({ attempt_count: 0, status: "failed" });
	expect(
		store.db
			.prepare(
				"SELECT COUNT(*) AS n FROM usage_events WHERE event='observer_recovery_scope_denial'",
			)
			.get(),
	).toEqual({ n: 4 });
	expect(store.db.prepare("SELECT * FROM memory_items").all()).toEqual([]);
});

it("does not debit a typed scope error thrown before observer output returns", async () => {
	// Arrange: a start hook is not proof of a returned provider invocation.
	await mapHistoricalScope({ revoked: false });
	const { settings, observe } = options();
	observe.mockRejectedValue(new ScopeWriteAuthorityError());

	// Act
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
		ScopeWriteAuthorityError,
	);

	// Assert: the retry release is neutral; no returned inference means no new budget debit.
	expect(recoveryBatch()).toMatchObject({ attempt_count: 0 });
	expect(
		store.db
			.prepare("SELECT * FROM usage_events WHERE event='observer_recovery_scope_denial'")
			.all(),
	).toEqual([]);
});

it("uses inference start time when a denied invocation spans the hourly cutoff", async () => {
	// Arrange: the provider returns more than one hour after its trusted start hook.
	await mapHistoricalScope({ revoked: false });
	const { settings, observe } = options();
	const response = await observe();
	observe.mockClear();
	const startedAt = Date.now();
	observe.mockImplementationOnce(async () => {
		vi.setSystemTime(startedAt + 3_600_000);
		store.db.prepare("UPDATE scope_memberships SET status='revoked'").run();
		return response;
	});

	// Act
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
		ScopeWriteAuthorityError,
	);

	// Assert: the durable debit belongs to the original hour, not the release hour.
	expect(
		store.db
			.prepare("SELECT created_at FROM usage_events WHERE event='observer_recovery_scope_denial'")
			.get(),
	).toEqual({ created_at: new Date(startedAt).toISOString() });
	addHistoricalStream("authorized-after-hour");
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(observe).toHaveBeenCalledTimes(2);
});

it.each([1, 2])(
	"recovers healthy history in the same 30-second sweeper tick after %i older scope denials",
	async (deniedStreams) => {
		// Arrange: first tick has only denied history; healthy history arrives before the default next tick.
		await mapHistoricalScope();
		if (deniedStreams === 2) addHistoricalStream("second-denied", { cwd: dir });
		vi.stubEnv("CODEMEM_RAW_EVENTS_RECOVERY_ENABLED", "1");
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { settings, observe } = options();
		const sweeper = new RawEventSweeper(store, settings);
		await sweeper.tick();
		expect(observe).not.toHaveBeenCalled();
		vi.setSystemTime(Date.now() + 30_000);
		addHistoricalStream("newer-authorized");
		const before = retainedHistory();

		// Act: the previous cooldown has expired, so this tick must fall through fresh denials.
		await sweeper.tick();

		// Assert: every denied batch survives with zero attempts; exactly one healthy inference runs.
		expect(observe).toHaveBeenCalledTimes(1);
		const batches = store.db
			.prepare(
				"SELECT stream_id, status, attempt_count, error_type FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1' ORDER BY stream_id",
			)
			.all();
		expect(batches).toEqual([
			{
				stream_id: "missed-session",
				status: "failed",
				attempt_count: 0,
				error_type: "ScopeWriteAuthorityError",
			},
			{ stream_id: "newer-authorized", status: "completed", attempt_count: 1, error_type: null },
			...(deniedStreams === 2
				? [
						{
							stream_id: "second-denied",
							status: "failed",
							attempt_count: 0,
							error_type: "ScopeWriteAuthorityError",
						},
					]
				: []),
		]);
		expect(retainedHistory()).toEqual(before);
	},
);

it.each([false, true])(
	"stops same-call fallback when authority is revoked during observer inference (tier routing: %s)",
	async (tierRouting) => {
		// Arrange: both streams begin authorized; the real membership changes while the observer runs.
		await mapHistoricalScope({ revoked: false });
		addHistoricalStream("newer-authorized");
		const before = retainedHistory();
		const { settings, observe } = options();
		const baseObserve = vi.fn();
		if (tierRouting) {
			const routedObserver = settings.observer;
			settings.observer = {
				...routedObserver,
				observe: baseObserve,
				tierRoutingEnabled: true,
				toConfig: () => ({
					observerProvider: "openai",
					observerRuntime: "api_http",
					observerModel: "test",
					observerTierRoutingEnabled: true,
				}),
			} as IngestOptions["observer"];
			settings.createTierObserver = vi.fn(() => routedObserver);
		}
		const response = await observe();
		observe.mockClear();
		observe.mockImplementationOnce(async () => {
			store.db.prepare("UPDATE scope_memberships SET status='revoked'").run();
			return response;
		});

		// Act: preflight succeeds but transactional persistence denies the now-revoked session.
		await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
			ScopeWriteAuthorityError,
		);

		// Assert: no second stream is inferred in the same call, despite an attempt-neutral release.
		expect(observe).toHaveBeenCalledTimes(1);
		expect(baseObserve).not.toHaveBeenCalled();
		expect(recoveryBatch()).toMatchObject({
			stream_id: "missed-session",
			status: "failed",
			attempt_count: 0,
			error_type: "ScopeWriteAuthorityError",
		});
		expect(store.db.prepare("SELECT * FROM memory_items").all()).toEqual([]);
		expect(retainedHistory()).toEqual(before);
		expect(
			store.db
				.prepare(
					"SELECT COUNT(*) AS n FROM raw_event_flush_batches WHERE stream_id='newer-authorized' AND extractor_version='raw_events_auth_recovery_v1'",
				)
				.get(),
		).toMatchObject({ n: 0 });
		// Act/Assert: the next default-cadence tick can pass another preflight denial and recover healthy history.
		vi.stubEnv("CODEMEM_RAW_EVENTS_RECOVERY_ENABLED", "1");
		vi.setSystemTime(Date.now() + 30_000);
		await new RawEventSweeper(store, settings).tick();
		expect(observe).toHaveBeenCalledTimes(2);
		expect(baseObserve).not.toHaveBeenCalled();
		expect(retainedHistory()).toEqual(before);
	},
);

it("excludes each denied window for the whole call even when its cooldown expires during later admissions", async () => {
	// Arrange: two actual revoked streams precede healthy history; each denial takes 30 seconds.
	await mapHistoricalScope();
	addHistoricalStream("second-denied", { cwd: dir });
	vi.setSystemTime(Date.now() + 1000);
	addHistoricalStream("newer-authorized");
	const before = retainedHistory();
	const assertWritable = store.assertSessionScopeWritable.bind(store);
	const deniedSessions: number[] = [];
	vi.spyOn(store, "assertSessionScopeWritable").mockImplementation((id, metadata) => {
		try {
			assertWritable(id, metadata);
		} catch (error) {
			if (error instanceof ScopeWriteAuthorityError) {
				deniedSessions.push(id);
				vi.setSystemTime(Date.now() + 30_000);
			}
			throw error;
		}
	});
	const { settings, observe } = options();

	// Act
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);

	// Assert: the oldest window's cooldown expired, but no denied identity was selected twice.
	expect(deniedSessions).toHaveLength(2);
	expect(new Set(deniedSessions).size).toBe(2);
	expect(deniedSessions[0]).toBe(sessionId);
	expect(observe).toHaveBeenCalledTimes(1);
	expect(retainedHistory()).toEqual(before);
});

it("pauses global observer authentication instead of falling through to other healthy streams", async () => {
	// Arrange: a global credential failure differs from a scope-local admission failure.
	await mapHistoricalScope({ revoked: false });
	addHistoricalStream("newer-authorized");
	vi.stubEnv("CODEMEM_RAW_EVENTS_RECOVERY_ENABLED", "1");
	vi.spyOn(console, "error").mockImplementation(() => {});
	const { settings, observe } = options();
	observe.mockRejectedValue(new ObserverAuthError("Credential expired"));
	const sweeper = new RawEventSweeper(store, settings);
	const before = retainedHistory();

	// Act: the first tick invokes one observer and the next default-cadence tick remains paused.
	await sweeper.tick();
	vi.setSystemTime(Date.now() + 30_000);
	await sweeper.tick();

	// Assert: a newer stream cannot bypass the global auth pause or consume a recovery attempt.
	expect(observe).toHaveBeenCalledTimes(1);
	expect(recoveryBatch()).toMatchObject({
		stream_id: "missed-session",
		status: "failed",
		attempt_count: 0,
		error_type: "ObserverAuthError",
	});
	expect(
		store.db
			.prepare(
				"SELECT COUNT(*) AS n FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get(),
	).toMatchObject({ n: 1 });
	expect(retainedHistory()).toEqual(before);
	expect(
		store.db
			.prepare("SELECT * FROM usage_events WHERE event='observer_recovery_scope_denial'")
			.all(),
	).toEqual([]);
});

it("retains a historical window through repeated scope denials and resumes at a newer membership epoch", async () => {
	// Arrange: preserve the historical managed mapping and revoke membership, not authority checks.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(cacheTime));
	const deviceId = store.deviceId;
	store.close();
	store = new MemoryStore(join(dir, "test.sqlite"), {
		runtimeSigningKey: { deviceId, publicKey: CANONICAL_PUBLIC_KEY },
	});
	await refreshHistoricalScope(3);
	store.db
		.prepare(
			"INSERT INTO project_scope_mappings(project_pattern, scope_id, priority, source, created_at, updated_at) VALUES (?, 'scope-a', 100, 'user', ?, ?)",
		)
		.run(dir, cacheTime, cacheTime);
	store.db.prepare("UPDATE scope_memberships SET status='revoked'").run();
	const before = retainedHistory();
	const { settings, observe } = options();
	let deniedBatch: ReturnType<typeof recoveryBatch>;
	// Act: exceed MAX_ATTEMPTS without spending any observer attempts or moving the cursor.
	for (let attempt = 0; attempt < 5; attempt++) {
		await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
			ScopeWriteAuthorityError,
		);
		deniedBatch ??= recoveryBatch();
		// Assert: every retry releases the same claim and retains all historical input.
		expect(recoveryBatch()).toEqual(deniedBatch);
		expect(recoveryBatch()).toMatchObject({
			source: "opencode",
			stream_id: "missed-session",
			start_event_seq: 0,
			end_event_seq: 1,
			status: "failed",
			attempt_count: 0,
			error_type: "ScopeWriteAuthorityError",
			observer_provider: null,
			observer_error_code: null,
			observer_error_message: null,
		});
		expect(retainedHistory()).toEqual(before);
		// An immediate sweep has no eligible work and must not mutate the denied batch.
		expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
		expect(recoveryBatch()).toEqual(deniedBatch);
		expect(retainedHistory()).toEqual(before);
		// A scope denial defers only this window for 15 seconds; later retries still deny.
		vi.setSystemTime(Date.now() + 15_000);
	}
	expect(observe).not.toHaveBeenCalled();
	expect(store.db.prepare("SELECT * FROM memory_items").all()).toEqual([]);
	expect(store.db.prepare("SELECT * FROM usage_events").all()).toEqual([]);
	// Arrange/Act: only a newer epoch restores revoked membership; retry the original window.
	await refreshHistoricalScope(4);
	expect(
		store.db.prepare("SELECT status, membership_epoch FROM scope_memberships").get(),
	).toMatchObject({
		status: "active",
		membership_epoch: 4,
	});
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	// Assert: one observer call completes the same window without discarding or rewinding history.
	expect(recoveryBatch()).toMatchObject({
		...(deniedBatch as Record<string, unknown>),
		status: "completed",
		attempt_count: 1,
		error_type: null,
	});
	expect(observe).toHaveBeenCalledTimes(1);
	expect(retainedHistory()).toEqual({
		...before,
		sourceBatch: {
			...(before.sourceBatch as Record<string, unknown>),
			status: "recovered",
			updated_at: expect.any(String),
		},
	});
	expect(store.db.prepare("SELECT scope_id, session_id FROM memory_items").all()).toEqual([
		{ scope_id: "scope-a", session_id: sessionId },
	]);
});

it("defers a denied oldest stream while recovering a newer authorized stream, then resumes the same batch", async () => {
	// Arrange: actual cached membership denies the historical mapping, not payload labels.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(cacheTime));
	const deviceId = store.deviceId;
	store.close();
	store = new MemoryStore(join(dir, "test.sqlite"), {
		runtimeSigningKey: { deviceId, publicKey: CANONICAL_PUBLIC_KEY },
	});
	await refreshHistoricalScope(3);
	store.db
		.prepare(
			"INSERT INTO project_scope_mappings(project_pattern, scope_id, priority, source, created_at, updated_at) VALUES (?, 'scope-a', 100, 'user', ?, ?)",
		)
		.run(dir, cacheTime, cacheTime);
	store.db.prepare("UPDATE scope_memberships SET status='revoked'").run();
	store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "newer-authorized",
		source: "opencode",
		cwd: join(dir, "unmanaged"),
		project: "unmanaged",
		metadata: { source: "plugin" },
		startedAt: "2026-09-21T09:00:00.000Z",
		toolVersion: "raw_events",
	});
	store.recordRawEvent({
		opencodeSessionId: "newer-authorized",
		eventId: "newer-prompt",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Recover authorized history" },
		tsWallMs: eventTime,
	});
	const newerBatch = store.getOrCreateRawEventFlushBatch(
		"newer-authorized",
		"opencode",
		0,
		0,
		"raw_events_v1",
	);
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='gave_up', observer_error_code='auth_missing', attempt_count=5, created_at=? WHERE id=?",
		)
		.run(new Date(Date.now() + 1000).toISOString(), newerBatch.batchId);
	store.updateRawEventFlushState("newer-authorized", 0);
	// beforeEach used the real clock; pin ordering independently of that wall time.
	store.db
		.prepare("UPDATE raw_event_flush_batches SET created_at=? WHERE stream_id='missed-session'")
		.run(cacheTime);
	const before = retainedHistory();
	const { settings, observe } = options();

	// Act/Assert: a denied admission falls through to healthy history within this same sweep.
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	const deniedBatch = recoveryBatch();
	expect(deniedBatch).toMatchObject({
		stream_id: "missed-session",
		status: "failed",
		attempt_count: 0,
		error_type: "ScopeWriteAuthorityError",
	});
	expect(retainedHistory()).toEqual(before);
	expect(observe).toHaveBeenCalledTimes(1);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(recoveryBatch()).toEqual(deniedBatch);
	expect(retainedHistory()).toEqual(before);

	// Act/Assert: restoring authority does not bypass the short cooldown; its exact expiry resumes.
	await refreshHistoricalScope(4);
	expect(
		store.db.prepare("SELECT status, membership_epoch FROM scope_memberships").get(),
	).toMatchObject({ status: "active", membership_epoch: 4 });
	vi.setSystemTime(Date.now() + 14_999);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(recoveryBatch()).toEqual(deniedBatch);
	expect(observe).toHaveBeenCalledTimes(1);
	vi.setSystemTime(Date.now() + 1);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(recoveryBatch()).toMatchObject({
		...(deniedBatch as Record<string, unknown>),
		status: "completed",
		attempt_count: 1,
		error_type: null,
	});
	expect(observe).toHaveBeenCalledTimes(2);
	expect(retainedHistory()).toEqual(before);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(retainedHistory()).toEqual({
		...before,
		sourceBatch: {
			...(before.sourceBatch as Record<string, unknown>),
			status: "recovered",
			updated_at: expect.any(String),
		},
	});
});

it("limits genuine provider failures even when their message resembles a scope denial", async () => {
	// Arrange: message text alone must never trigger the typed admission release.
	const { settings, observe } = options();
	observe.mockRejectedValue(new Error("unauthorized_scope"));
	// Act
	for (let attempt = 1; attempt <= 3; attempt++) {
		await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow(
			"unauthorized_scope",
		);
		// Assert: actual observer failures consume attempts and retain the historical range.
		expect(recoveryBatch()).toMatchObject({
			status: "failed",
			attempt_count: attempt,
			error_type: "RawEventRecoveryError",
			observer_error_code: "recovery_failed",
		});
	}
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).toHaveBeenCalledTimes(3);
	expect(store.rawEventFlushState("missed-session")).toBe(1);
	expect(
		store.db
			.prepare("SELECT * FROM usage_events WHERE event='observer_recovery_scope_denial'")
			.all(),
	).toEqual([]);
});

it("recovers stranded events once without rewinding the cursor or publishing the old observation", async () => {
	const { settings, observe } = options();
	const before = store.db
		.prepare("SELECT ended_at, metadata_json FROM sessions WHERE id=?")
		.get(sessionId);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).toHaveBeenCalledTimes(1);
	expect(
		store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE extractor_version='raw_events_v1'")
			.get(),
	).toMatchObject({ status: "recovered" });
	expect(store.rawEventFlushState("missed-session")).toBe(1);
	expect(
		store.db.prepare("SELECT ended_at, metadata_json FROM sessions WHERE id=?").get(sessionId),
	).toEqual(before);
	const rows = store.db
		.prepare(
			"SELECT id, created_at, visibility, workspace_kind FROM memory_items WHERE session_id=?",
		)
		.all(sessionId) as Array<{
		id: number;
		created_at: string;
		visibility: string;
		workspace_kind: string;
	}>;
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		created_at: new Date(eventTime).toISOString(),
		visibility: "private",
		workspace_kind: "personal",
	});
	expect(
		store.db
			.prepare("SELECT COUNT(*) AS n FROM replication_ops WHERE entity_id=?")
			.get(String(rows[0]?.id)),
	).toMatchObject({ n: 0 });
	expect(
		store.db
			.prepare(
				"SELECT COUNT(*) AS n FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1' AND status='completed'",
			)
			.get(),
	).toMatchObject({ n: 1 });
});

it("completes a usage-only auth gap without an observer call or cursor rewind", async () => {
	for (const eventId of ["prompt", "tool"]) {
		store.db
			.prepare(
				"UPDATE raw_events SET event_type='assistant_usage', payload_json=? WHERE event_id=?",
			)
			.run(JSON.stringify({ type: "assistant_usage", usage: { input_tokens: 12 } }), eventId);
	}
	store.db
		.prepare(
			"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count) VALUES ('opencode','missed-session','missed-session',0,1,'raw_events_auth_recovery_v1','failed',datetime('now'),datetime('now','-1 hour'),3)",
		)
		.run();
	for (let i = 0; i < 4; i++) {
		store.db
			.prepare(
				"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count) VALUES ('opencode',?, ?, ?, ?,'raw_events_auth_recovery_v1','completed',datetime('now'),?,1)",
			)
			.run(`previous-${i}`, `previous-${i}`, i, i, new Date().toISOString());
	}
	store.recordRawEvent({
		opencodeSessionId: "earlier-content",
		eventId: "earlier-prompt",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Retain this prompt" },
		tsWallMs: eventTime,
	});
	store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "earlier-content",
		source: "opencode",
		cwd: dir,
		project: "codemem",
		metadata: { source: "plugin" },
		startedAt: "2026-09-21T09:00:00.000Z",
		toolVersion: "raw_events",
	});
	const earlier = store.getOrCreateRawEventFlushBatch(
		"earlier-content",
		"opencode",
		0,
		0,
		"raw_events_v1",
	);
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='gave_up', observer_error_code='auth_missing', created_at=datetime('now','-1 day') WHERE id=?",
		)
		.run(earlier.batchId);
	store.updateRawEventFlushState("earlier-content", 0);
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).not.toHaveBeenCalled();
	expect(store.rawEventFlushState("missed-session")).toBe(1);
	expect(store.rawEventsSinceBySeq("missed-session")).toHaveLength(2);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 0 });
	expect(
		store.db
			.prepare(
				"SELECT status, attempt_count FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get(),
	).toMatchObject({ status: "completed", attempt_count: 0 });
	expect(
		store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE extractor_version='raw_events_v1'")
			.get(),
	).toMatchObject({ status: "recovered" });
});

it("keeps exhausted content-bearing auth gaps blocked", async () => {
	store.db
		.prepare(
			"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count) VALUES ('opencode','missed-session','missed-session',0,1,'raw_events_auth_recovery_v1','failed',datetime('now'),datetime('now','-1 hour'),3)",
		)
		.run();
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).not.toHaveBeenCalled();
});

it("does not complete a usage-only gap with a missing event timestamp", async () => {
	for (const eventId of ["prompt", "tool"]) {
		store.db
			.prepare(
				"UPDATE raw_events SET event_type='assistant_usage', payload_json=? WHERE event_id=?",
			)
			.run(JSON.stringify({ type: "assistant_usage", usage: { input_tokens: 12 } }), eventId);
	}
	store.db.prepare("UPDATE raw_events SET ts_wall_ms=NULL WHERE event_id='tool'").run();
	const { settings, observe } = options();
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow(
		"event time is unavailable",
	);
	expect(observe).not.toHaveBeenCalled();
	expect(
		store.db
			.prepare(
				"SELECT status FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get(),
	).toMatchObject({ status: "failed" });
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET attempt_count=3, updated_at=datetime('now','-1 hour') WHERE extractor_version='raw_events_auth_recovery_v1'",
		)
		.run();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(
		store.db
			.prepare(
				"SELECT attempt_count FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get(),
	).toMatchObject({ attempt_count: 3 });
});

it("still infers when an auth gap mixes usage with processable content", async () => {
	store.db
		.prepare(
			"UPDATE raw_events SET event_type='assistant_usage', payload_json=? WHERE event_id='prompt'",
		)
		.run(JSON.stringify({ type: "assistant_usage", usage: { input_tokens: 12 } }));
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(observe).toHaveBeenCalledTimes(1);
});

it("never infers over a completed event range", async () => {
	store.db
		.prepare(
			"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count) VALUES ('opencode','missed-session','missed-session',0,1,'raw_events_completed_v1','completed',datetime('now'),datetime('now'),1)",
		)
		.run();
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).not.toHaveBeenCalled();
	expect(
		store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE extractor_version='raw_events_v1'")
			.get(),
	).toMatchObject({ status: "recovered" });
});

it("coalesces overlapping failed and exhausted ranges into one inference", async () => {
	store.db
		.prepare(
			"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count,observer_error_code) VALUES ('opencode','missed-session','missed-session',0,0,'raw_events_overlap_v1','failed',datetime('now'),datetime('now'),2,'auth_missing')",
		)
		.run();
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).toHaveBeenCalledTimes(1);
});

it("does not rerun inference after a crash following committed observations", async () => {
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='error', attempt_count=1 WHERE extractor_version='raw_events_auth_recovery_v1'",
		)
		.run();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(observe).toHaveBeenCalledTimes(1);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 1 });
});

it("does not rerun a memoryless successful recovery after a crash", async () => {
	const { settings, observe } = options();
	observe.mockResolvedValue({
		raw: '<skip_summary reason="low-signal"/>',
		parsed: null,
		provider: "test",
		model: "test",
	});
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 0 });
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='error', attempt_count=1 WHERE extractor_version='raw_events_auth_recovery_v1'",
		)
		.run();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(observe).toHaveBeenCalledTimes(1);
});

it("does not treat failure usage as a completed memoryless recovery", async () => {
	const { settings, observe } = options();
	observe.mockResolvedValue({ raw: null, parsed: null, provider: "test", model: "test" });
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow();
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow();
	expect(observe).toHaveBeenCalledTimes(2);
	expect(
		store.db
			.prepare(
				"SELECT status FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get(),
	).toMatchObject({ status: "failed" });
});

it("does not treat failed persistence telemetry as a successful recovery", async () => {
	const { settings, observe } = options();
	const remember = vi.spyOn(store, "remember").mockImplementation(() => {
		throw new Error("storage busy");
	});
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow("storage busy");
	remember.mockRestore();
	expect(
		store.db
			.prepare(
				"SELECT COUNT(*) AS n FROM usage_events WHERE json_extract(metadata_json, '$.historical_recovery_batch_id') IS NOT NULL",
			)
			.get(),
	).toMatchObject({ n: 0 });
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(observe).toHaveBeenCalledTimes(2);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 1 });
});

it("leaves missing event timestamps unprocessed rather than inventing a timeline", async () => {
	store.db.prepare("UPDATE raw_events SET ts_wall_ms=NULL WHERE event_id='tool'").run();
	const { settings, observe } = options();
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow(
		"event time is unavailable",
	);
	expect(observe).not.toHaveBeenCalled();
	expect(store.rawEventFlushState("missed-session")).toBe(1);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 0 });
});

it("keeps authentication failures retryable without spending recovery attempts", async () => {
	// Arrange
	const { settings, observe } = options();
	observe.mockImplementation(async () => {
		throw new ObserverAuthError("Credential expired");
	});
	// Act: observer authentication remains attempt-neutral past the processing retry limit.
	for (let attempt = 0; attempt < 5; attempt++) {
		await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
			ObserverAuthError,
		);
		const row = store.db
			.prepare(
				"SELECT status, attempt_count, observer_error_code FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get();
		// Assert
		expect(row).toMatchObject({
			status: "failed",
			attempt_count: 0,
			observer_error_code: "auth_failed",
		});
	}
	expect(store.rawEventFlushState("missed-session")).toBe(1);
	expect(observe).toHaveBeenCalledTimes(5);
});

it("pauses once the per-hour recovery budget is spent", async () => {
	for (let i = 0; i < 4; i++) {
		store.db
			.prepare(
				"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count) VALUES ('opencode',?, ?, ?, ?,'raw_events_auth_recovery_v1','completed',datetime('now'),?,1)",
			)
			.run(`previous-${i}`, `previous-${i}`, i, i, new Date().toISOString());
	}
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).not.toHaveBeenCalled();
});

it("reserves the same window for only one concurrent worker", async () => {
	const { settings, observe } = options();
	let resolve: (() => void) | undefined;
	const pending = new Promise<void>((done) => {
		resolve = done;
	});
	const firstResponse = await observe();
	observe.mockImplementation(async () => {
		await pending;
		return firstResponse;
	});
	const first = recoverOneMissingAuthWindow(store, settings);
	await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	resolve?.();
	expect(await first).toBe(true);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 1 });
});

it("automatically schedules an old auth gap during a normal sweep", async () => {
	const prior = process.env.CODEMEM_RAW_EVENTS_RECOVERY_ENABLED;
	process.env.CODEMEM_RAW_EVENTS_RECOVERY_ENABLED = "1";
	try {
		const { settings, observe } = options();
		const sweeper = new RawEventSweeper(store, settings);
		await sweeper.tick();
		expect(observe).toHaveBeenCalledTimes(1);
		expect(store.rawEventFlushState("missed-session")).toBe(1);
	} finally {
		if (prior === undefined) delete process.env.CODEMEM_RAW_EVENTS_RECOVERY_ENABLED;
		else process.env.CODEMEM_RAW_EVENTS_RECOVERY_ENABLED = prior;
	}
});
