import { MemoryStore } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DiagnosticEvent, diagnosticsRoutes } from "./diagnostics.js";

type DiagnosticsResponse = {
	contract_version: number;
	items: DiagnosticEvent[];
	next_cursor: string | null;
	redacted: boolean;
	generated_at: string;
};

const stores: MemoryStore[] = [];

function createStore(): MemoryStore {
	const store = new MemoryStore(":memory:");
	stores.push(store);
	return store;
}

function insertSyncAttempt(
	store: MemoryStore,
	input: { at: string; error?: string; id: number; ok: boolean },
) {
	store.db
		.prepare(
			`INSERT INTO sync_attempts(
				id, peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			`private-device-${input.id}`,
			input.at,
			input.at,
			input.ok ? 1 : 0,
			input.id,
			input.id + 1,
			input.error ?? null,
		);
}

function insertRawEvents(store: MemoryStore, streamId: string, count: number, idOffset: number) {
	const insert = store.db.prepare(
		`INSERT INTO raw_events(
			id, source, stream_id, opencode_session_id, event_seq, event_type,
			payload_json, created_at
		) VALUES (?, 'opencode', ?, ?, ?, 'test', '{}', ?)`,
	);
	store.db.transaction(() => {
		for (let eventSeq = 1; eventSeq <= count; eventSeq += 1) {
			insert.run(
				idOffset + eventSeq,
				streamId,
				`session-${streamId}`,
				eventSeq,
				"2026-09-07T12:00:00.000Z",
			);
		}
	})();
}

function insertObserverFailure(store: MemoryStore, error: string) {
	store.db
		.prepare(
			`INSERT INTO raw_event_flush_batches(
				id, source, stream_id, opencode_session_id, start_event_seq, end_event_seq,
				extractor_version, status, error_message, error_type, observer_provider,
				observer_model, observer_error_code, observer_error_message, attempt_count,
				created_at, updated_at
			) VALUES (1, 'opencode', 'private-stream', 'private-session', 1, 2,
				'v1', 'failed', ?, 'provider_error', 'private-provider',
				'private-model', 'auth_failed', ?, 3, ?, ?)`,
		)
		.run(error, error, "2026-09-07T09:00:00.000Z", "2026-09-07T09:00:00.000Z");
}

function insertGaveUpObserverFailure(store: MemoryStore) {
	store.db
		.prepare(
			`INSERT INTO raw_event_flush_batches(
				id, source, stream_id, opencode_session_id, start_event_seq, end_event_seq,
				extractor_version, status, error_type, observer_provider, attempt_count,
				created_at, updated_at
			) VALUES (2, 'opencode', 'stream', 'session', 3, 4,
				'v1', 'gave_up', 'timeout', 'provider', 5, ?, ?)`,
		)
		.run("2026-09-07T12:00:00.000Z", "2026-09-07T12:00:00.000Z");
}

function insertProcessingFailure(
	store: MemoryStore,
	input: { at: string; id: number; status: "error" | "failed" | "gave_up" },
) {
	store.db
		.prepare(
			`INSERT INTO raw_event_flush_batches(
				id, source, stream_id, opencode_session_id, start_event_seq, end_event_seq,
				extractor_version, status, error_type, observer_provider, attempt_count,
				created_at, updated_at
			) VALUES (?, 'opencode', ?, ?, ?, ?, 'v1', ?, 'timeout', 'provider', 1, ?, ?)`,
		)
		.run(
			input.id,
			`stream-${input.id}`,
			`session-${input.id}`,
			input.id,
			input.id,
			input.status,
			input.at,
			input.at,
		);
}

function insertMaintenanceFailure(store: MemoryStore, error: string) {
	store.db
		.prepare(
			`INSERT INTO maintenance_jobs(
				kind, title, status, progress_current, progress_total, progress_unit,
				updated_at, error
			) VALUES (?, ?, 'failed', 4, 10, 'private-unit', ?, ?)`,
		)
		.run("private-kind", "private title", "2026-09-07T08:00:00.000Z", error);
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	vi.restoreAllMocks();
});

describe("GET /api/diagnostics/events query planning", () => {
	it("uses the occurred-at index for bounded sync history", () => {
		const store = createStore();
		const plans = [
			store.db
				.prepare(
					`EXPLAIN QUERY PLAN SELECT id FROM sync_attempts
					ORDER BY CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END DESC,
					id DESC LIMIT 51`,
				)
				.all(),
			store.db
				.prepare(
					`EXPLAIN QUERY PLAN SELECT id FROM sync_attempts
					WHERE CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END < ?
					ORDER BY CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END DESC,
					id DESC LIMIT 51`,
				)
				.all("2026-09-07T12:00:00.000Z"),
		];

		for (const plan of plans) {
			const details = JSON.stringify(plan);
			expect(details).toContain("idx_sync_attempts_occurred");
			expect(details).not.toContain("USE TEMP B-TREE");
		}
	});

	it.each([
		["ok = 0", "idx_sync_attempts_error_occurred"],
		["ok <> 0", "idx_sync_attempts_success_occurred"],
	])("uses the matching partial index for sync history filtered by %s", (severity, index) => {
		const store = createStore();
		const plans = [
			store.db
				.prepare(
					`EXPLAIN QUERY PLAN SELECT id FROM sync_attempts
					WHERE ${severity}
					ORDER BY CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END DESC,
					id DESC LIMIT 51`,
				)
				.all(),
			store.db
				.prepare(
					`EXPLAIN QUERY PLAN SELECT id FROM sync_attempts
					WHERE ${severity} AND
						(CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END < ? OR
						(CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END = ? AND
						's:' || printf('%020d', id) < ?))
					ORDER BY CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END DESC,
					id DESC LIMIT 51`,
				)
				.all("2026-09-07T12:00:00.000Z", "2026-09-07T12:00:00.000Z", "s:00000000000000000100"),
		];

		for (const plan of plans) {
			const details = JSON.stringify(plan);
			expect(details).toContain(index);
			expect(details).not.toContain("USE TEMP B-TREE");
		}
	});

	it("uses the status index for each bounded observer-failure branch", () => {
		const store = createStore();
		for (const status of ["error", "failed", "gave_up"] as const) {
			const plan = store.db
				.prepare(
					`EXPLAIN QUERY PLAN SELECT id FROM raw_event_flush_batches
					WHERE status = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))
					ORDER BY updated_at DESC, id DESC LIMIT 6`,
				)
				.all(status, "2026-09-07T12:00:00.000Z", "2026-09-07T12:00:00.000Z", 100);

			const details = JSON.stringify(plan);
			expect(details).toContain("idx_flush_batches_status_updated");
			expect(details).not.toContain("SCAN raw_event_flush_batches");
			expect(details).not.toContain("USE TEMP B-TREE");
		}
	});

	it.each([
		["observer_provider IS NOT NULL", "idx_flush_batches_observer_status_updated"],
		["observer_provider IS NULL", "idx_flush_batches_capture_status_updated"],
	])("uses a partial status index when filtering providers with %s", (provider, index) => {
		const store = createStore();
		const plan = store.db
			.prepare(
				`EXPLAIN QUERY PLAN SELECT id FROM raw_event_flush_batches
				WHERE status = 'failed' AND ${provider}
				ORDER BY updated_at DESC, id DESC LIMIT 6`,
			)
			.all();

		const details = JSON.stringify(plan);
		expect(details).toContain(index);
		expect(details).not.toContain("USE TEMP B-TREE");
	});
});

describe("GET /api/diagnostics/events", () => {
	it("normalizes recent source records in deterministic order", async () => {
		const store = createStore();
		insertSyncAttempt(store, { at: "2026-09-07T10:00:00.000Z", id: 1, ok: true });
		insertSyncAttempt(store, { at: "2026-09-07T11:00:00.000Z", id: 2, ok: false });
		insertObserverFailure(store, "private observer detail");
		insertMaintenanceFailure(store, "private maintenance detail");
		const app = diagnosticsRoutes(() => store);

		const response = await app.request("/api/diagnostics/events");
		const body = (await response.json()) as DiagnosticsResponse;

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(body.contract_version).toBe(1);
		expect(body.redacted).toBe(true);
		expect(body.items.map((event) => event.code)).toEqual([
			"sync_attempt_failed",
			"sync_attempt_succeeded",
			"observer_flush_failed",
			"maintenance_job_failed",
		]);
		expect(body.items.every((event) => event.technical_detail?.text == null)).toBe(true);
	});

	it("never returns stored sensitive text, identifiers, or paths", async () => {
		const store = createStore();
		const secret = "sk-1234567890SECRET";
		const sensitive = `/Users/private/repo host.internal 10.20.30.40 Bearer abcdefghijklmnop ${secret}`;
		insertSyncAttempt(store, {
			at: "2026-09-07T10:00:00.000Z",
			error: sensitive,
			id: 1,
			ok: false,
		});
		insertObserverFailure(store, sensitive);
		insertMaintenanceFailure(store, sensitive);
		const app = diagnosticsRoutes(() => store);

		const defaultResponse = await app.request("/api/diagnostics/events");
		const technicalResponse = await app.request("/api/diagnostics/events?includeTechnical=1");
		const defaultBody = await defaultResponse.text();
		const technicalBody = await technicalResponse.text();
		const combined = `${defaultBody}${technicalBody}`;

		expect(JSON.parse(defaultBody)).toMatchObject({ redacted: true });
		expect(JSON.parse(technicalBody)).toMatchObject({ redacted: true });

		for (const forbidden of [
			"/Users/private",
			"host.internal",
			"10.20.30.40",
			"abcdefghijklmnop",
			secret,
			"private-device",
			"private-stream",
			"private-session",
			"private-provider",
			"private-model",
			"private-kind",
			"private title",
			"private-unit",
		]) {
			expect(combined).not.toContain(forbidden);
		}
	});

	it("filters by subsystem and severity", async () => {
		const store = createStore();
		insertSyncAttempt(store, { at: "2026-09-07T10:00:00.000Z", id: 1, ok: true });
		insertSyncAttempt(store, { at: "2026-09-07T11:00:00.000Z", id: 2, ok: false });
		insertObserverFailure(store, "failure");
		const app = diagnosticsRoutes(() => store);

		const response = await app.request("/api/diagnostics/events?subsystem=sync&severity=error");
		const body = (await response.json()) as DiagnosticsResponse;

		expect(body.items).toHaveLength(1);
		expect(body.items[0]).toMatchObject({ subsystem: "sync", severity: "error" });
	});

	it("reports retry-exhausted observer failures without claiming another retry", async () => {
		const store = createStore();
		insertGaveUpObserverFailure(store);
		const app = diagnosticsRoutes(() => store);

		const response = await app.request(
			"/api/diagnostics/events?subsystem=observer&severity=error&includeTechnical=1",
		);
		const body = (await response.json()) as DiagnosticsResponse;

		expect(body.items).toHaveLength(1);
		expect(body.items[0]).toMatchObject({
			code: "observer_flush_gave_up",
			message: "Processing stopped after all retry attempts were exhausted.",
			technical_detail: { available: true, text: "Failure category: timeout. Attempts: 5." },
		});
		expect(JSON.stringify(body)).not.toContain("waiting for retry");
	});
});

describe("GET /api/diagnostics/events pagination and validation", () => {
	it("clamps page size and returns an opaque cursor for the next page", async () => {
		const store = createStore();
		for (let id = 1; id <= 105; id += 1) {
			insertSyncAttempt(store, {
				at: new Date(Date.UTC(2026, 8, 7, 0, id)).toISOString(),
				id,
				ok: true,
			});
		}
		const app = diagnosticsRoutes(() => store);

		const firstResponse = await app.request(
			"/api/diagnostics/events?subsystem=sync&severity=info&limit=500",
		);
		const first = (await firstResponse.json()) as DiagnosticsResponse;
		const secondResponse = await app.request(
			`/api/diagnostics/events?subsystem=sync&severity=info&limit=10&cursor=${first.next_cursor}`,
		);
		const second = (await secondResponse.json()) as DiagnosticsResponse;

		expect(first.items).toHaveLength(100);
		expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(second.items).toHaveLength(5);
		expect(new Set([...first.items, ...second.items].map((event) => event.id)).size).toBe(105);
	});

	it("does not drop events when multiple sources share a timestamp across pages", async () => {
		const store = createStore();
		const at = "2026-09-07T10:00:00.000Z";
		for (let id = 1; id <= 13; id += 1) {
			insertSyncAttempt(store, { at, id, ok: true });
		}
		for (let id = 1; id <= 4; id += 1) {
			store.db
				.prepare(
					`INSERT INTO maintenance_jobs(
						kind, title, status, progress_current, progress_total, updated_at
					) VALUES (?, 'Maintenance', 'running', 1, 2, ?)`,
				)
				.run(`maintenance-${id}`, at);
		}
		const app = diagnosticsRoutes(() => store);
		const events: DiagnosticEvent[] = [];
		let cursor: string | null = null;

		do {
			const query = new URLSearchParams({ limit: "5", severity: "info" });
			if (cursor) query.set("cursor", cursor);
			const response = await app.request(`/api/diagnostics/events?${query}`);
			const page = (await response.json()) as DiagnosticsResponse;
			events.push(...page.items);
			cursor = page.next_cursor;
		} while (cursor);

		expect(events).toHaveLength(17);
		expect(new Set(events.map((event) => event.id))).toHaveLength(17);
		expect(events.filter((event) => event.subsystem === "sync")).toHaveLength(13);
		expect(events.filter((event) => event.subsystem === "maintenance")).toHaveLength(4);
	});

	it("pages through more than one page of failures across all terminal statuses", async () => {
		const store = createStore();
		const statuses = ["error", "failed", "gave_up"] as const;
		for (let id = 1; id <= 24; id += 1) {
			insertProcessingFailure(store, {
				at: new Date(Date.UTC(2026, 8, 7, 0, id)).toISOString(),
				id,
				status: statuses[id % statuses.length],
			});
		}
		const app = diagnosticsRoutes(() => store);
		const events: DiagnosticEvent[] = [];
		let cursor: string | null = null;

		do {
			const query = new URLSearchParams({ limit: "5", subsystem: "observer" });
			if (cursor) query.set("cursor", cursor);
			const response = await app.request(`/api/diagnostics/events?${query}`);
			const page = (await response.json()) as DiagnosticsResponse;
			events.push(...page.items);
			cursor = page.next_cursor;
		} while (cursor);

		expect(events).toHaveLength(24);
		expect(new Set(events.map((event) => event.id))).toHaveLength(24);
	});

	it.each([
		"limit=0",
		"limit=nope",
		"cursor=not-json",
		"severity=critical",
		"subsystem=terminal",
		"includeTechnical=true",
	])("rejects invalid query input: %s", async (query) => {
		const store = createStore();
		const app = diagnosticsRoutes(() => store);

		const response = await app.request(`/api/diagnostics/events?${query}`);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_diagnostics_query" });
	});
});

describe("GET /api/diagnostics/events capture backlog", () => {
	it("uses the pending-session partial index for the bounded candidate window", () => {
		const store = createStore();
		const plan = store.db
			.prepare(
				`EXPLAIN QUERY PLAN SELECT source, stream_id, last_flushed_event_seq, updated_at
				FROM raw_event_sessions
				WHERE last_received_event_seq > last_flushed_event_seq
				ORDER BY updated_at DESC LIMIT 1001`,
			)
			.all();

		const details = JSON.stringify(plan);
		expect(details).toContain("idx_raw_event_sessions_pending_updated");
		expect(details).not.toContain("USE TEMP B-TREE");
	});

	it("reports a bounded capture backlog without exposing session rows", async () => {
		const store = createStore();
		insertRawEvents(store, "private-stream-1", 150, 0);
		insertRawEvents(store, "private-stream-2", 100, 1000);
		store.db
			.prepare(
				`INSERT INTO raw_event_sessions(
					source, stream_id, opencode_session_id, last_received_event_seq,
					last_flushed_event_seq, updated_at
				) VALUES ('opencode', 'private-stream-1', 'private-session-1', 150, 0, ?),
					('opencode', 'private-stream-2', 'private-session-2', 100, 0, ?)`,
			)
			.run("2026-09-07T12:00:00.000Z", "2026-09-07T11:00:00.000Z");
		const app = diagnosticsRoutes(() => store);

		const response = await app.request(
			"/api/diagnostics/events?subsystem=capture&severity=warning&includeTechnical=1",
		);
		const body = (await response.json()) as DiagnosticsResponse;

		expect(body.items).toHaveLength(1);
		expect(body.items[0]).toMatchObject({
			code: "capture_backlog_growing",
			technical_detail: { available: true, text: "250 pending events across 2 sessions." },
		});
		expect(JSON.stringify(body)).not.toContain("private-");
	});

	it("does not report purged raw events as pending capture backlog", async () => {
		const store = createStore();
		insertRawEvents(store, "private-stream", 250, 0);
		store.db
			.prepare(
				`INSERT INTO raw_event_sessions(
					source, stream_id, opencode_session_id, last_received_event_seq,
					last_flushed_event_seq, updated_at
				) VALUES ('opencode', 'private-stream', 'private-session', 250, 0, ?)`,
			)
			.run("2026-09-07T12:00:00.000Z");
		store.db.prepare("DELETE FROM raw_events WHERE stream_id = 'private-stream'").run();
		const app = diagnosticsRoutes(() => store);

		const response = await app.request("/api/diagnostics/events?subsystem=capture");
		const body = (await response.json()) as DiagnosticsResponse;

		expect(body.items).toEqual([]);
	});

	it("counts only retained events after a partial raw-event purge", async () => {
		const store = createStore();
		insertRawEvents(store, "private-stream", 1200, 0);
		store.db
			.prepare(
				`INSERT INTO raw_event_sessions(
					source, stream_id, opencode_session_id, last_received_event_seq,
					last_flushed_event_seq, updated_at
				) VALUES ('opencode', 'private-stream', 'private-session', 1200, 0, ?)`,
			)
			.run("2026-09-07T12:00:00.000Z");
		store.db.prepare("DELETE FROM raw_events WHERE event_seq <= 1000").run();
		const app = diagnosticsRoutes(() => store);

		const response = await app.request(
			"/api/diagnostics/events?subsystem=capture&includeTechnical=1",
		);
		const body = (await response.json()) as DiagnosticsResponse;

		expect(body.items).toHaveLength(1);
		expect(body.items[0]).toMatchObject({
			code: "capture_backlog_growing",
			technical_detail: { available: true, text: "200 pending events across 1 session." },
		});
	});

	it("bounds retained-event lookups after selecting recent pending candidates", async () => {
		const store = createStore();
		const insertSession = store.db.prepare(
			`INSERT INTO raw_event_sessions(
				source, stream_id, opencode_session_id, last_received_event_seq,
				last_flushed_event_seq, updated_at
			) VALUES ('opencode', ?, ?, 250, 0, ?)`,
		);
		store.db.transaction(() => {
			for (let index = 0; index < 1000; index += 1) {
				insertSession.run(
					`purged-${index}`,
					`session-${index}`,
					new Date(Date.UTC(2026, 8, 7, 1, 0, index)).toISOString(),
				);
			}
			insertSession.run("retained", "retained-session", "2026-09-07T00:00:00.000Z");
		})();
		insertRawEvents(store, "retained", 250, 0);
		const app = diagnosticsRoutes(() => store);

		const response = await app.request("/api/diagnostics/events?subsystem=capture");
		const body = (await response.json()) as DiagnosticsResponse;

		expect(body.items).toEqual([]);
	});

	it("marks aggregates as lower bounds when the candidate window is truncated", async () => {
		const store = createStore();
		insertRawEvents(store, "retained", 250, 0);
		const insertSession = store.db.prepare(
			`INSERT INTO raw_event_sessions(
				source, stream_id, opencode_session_id, last_received_event_seq,
				last_flushed_event_seq, updated_at
			) VALUES ('opencode', ?, ?, 250, 0, ?)`,
		);
		store.db.transaction(() => {
			insertSession.run("retained", "retained-session", "2026-09-07T12:00:00.000Z");
			for (let index = 0; index < 1000; index += 1) {
				insertSession.run(
					`purged-${index}`,
					`session-${index}`,
					new Date(Date.UTC(2026, 8, 7, 11, 59, 59, 999 - index)).toISOString(),
				);
			}
		})();
		const app = diagnosticsRoutes(() => store);

		const response = await app.request(
			"/api/diagnostics/events?subsystem=capture&includeTechnical=1",
		);
		const body = (await response.json()) as DiagnosticsResponse;

		expect(body.items[0]?.technical_detail?.text).toBe(
			"At least 250 pending events across 1 session.",
		);
	});
});
