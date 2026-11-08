import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, ingestRawEvents, MemoryStore, type ViewerIdentityTarget } from "@codemem/core";
import { expect, it, vi } from "vitest";
import { initTestSchema } from "../../../core/src/test-utils.js";
import type { RawEventInbox } from "../../../viewer-server/src/raw-event-inbox.js";
import { rawEventsRoutes } from "../../../viewer-server/src/routes/raw-events.js";
import { buildRejectedEventBatchBody, rejectedEventAcknowledgement } from "./capture-retry.js";

const identity = vi.hoisted(
	(): ViewerIdentityTarget => ({
		device_id: null,
		actor_id_present: false,
		actor_id: null,
		config_path: null,
		runtime_root: null,
		workspace_id: null,
		home_dir: null,
		pack_compression: null,
		embedding_disabled: true,
		embedding_offline: true,
		embedding_model: "fixture-model",
		embedding_revision: null,
	}),
);
vi.mock("@codemem/core", async (importActual) => ({
	...(await importActual<typeof import("@codemem/core")>()),
	buildViewerIdentityTarget: () => identity,
}));

const target: { db_path: string; identity_target: ViewerIdentityTarget } = {
	db_path: resolve("synthetic-recovery.sqlite"),
	identity_target: identity,
};
function fixture() {
	const getStore = vi.fn(() => {
		throw new Error("route must not access SQLite");
	});
	const enqueue = vi.fn<RawEventInbox["enqueue"]>().mockResolvedValue(undefined);
	const inbox: RawEventInbox = {
		enqueue,
		start: vi.fn(),
		stop: vi.fn().mockResolvedValue(undefined),
		status: vi.fn().mockResolvedValue({ pending: 0, corrupt: 0, draining: false }),
	};
	const app = rawEventsRoutes(getStore, null, inbox, {
		dbPath: target.db_path,
		hasCurrentIdentity: () => true,
	});
	const post = (body: string) =>
		app.request("/api/raw-events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
	return { enqueue, getStore, post };
}

function persistedSnapshot(request: object) {
	const db = connect(":memory:");
	try {
		initTestSchema(db);
		ingestRawEvents({ db }, request);
		const rows = (table: "raw_events" | "raw_event_sessions") =>
			db
				.prepare(`SELECT * FROM ${table}`)
				.all()
				.map((row) => {
					if (!row || typeof row !== "object") throw new Error("expected a stored row");
					return Object.fromEntries(
						Object.entries(row).filter(([key]) => key !== "created_at" && key !== "updated_at"),
					);
				});
		return { events: rows("raw_events"), sessions: rows("raw_event_sessions") };
	} finally {
		db.close();
	}
}

it("recognizes actual HTTP 200 ingestion and duplicate acknowledgement from the unqueued route", async () => {
	// Arrange: the store and configuration belong only to this disposable synthetic home.
	const home = await mkdtemp(join(tmpdir(), "codemem-recovery-200-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_EMBEDDING_OFFLINE", "1");
	let store: MemoryStore | undefined;
	try {
		store = new MemoryStore(":memory:");
		const selectedStore = store;
		const app = rawEventsRoutes(() => selectedStore, null, null);
		const body = buildRejectedEventBatchBody(
			JSON.stringify({
				session_id: "synthetic-200",
				event_id: "synthetic-200-event",
				event_type: "user_prompt",
				payload: { text: "synthetic café" },
			}),
			{ ...target, db_path: store.dbPath },
		);
		// Act: resend identical bytes to exercise the real route's duplicate response.
		const first = await app.request("/api/raw-events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
		const duplicate = await app.request("/api/raw-events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
		const firstBody = await first.json();
		const duplicateBody = await duplicate.json();
		// Assert
		expect(first.status).toBe(200);
		expect(duplicate.status).toBe(200);
		expect(firstBody).toEqual({ inserted: 1, skipped: 0, received: 1 });
		expect(duplicateBody).toEqual({ inserted: 0, skipped: 1, received: 1 });
		for (const responseBody of [firstBody, duplicateBody]) {
			expect(rejectedEventAcknowledgement(200, responseBody)).toEqual({
				acknowledged: true,
				acknowledgement: "ingested",
			});
		}
		expect(store.db.prepare("SELECT COUNT(*) AS total FROM raw_events").get()).toEqual({
			total: 1,
		});
	} finally {
		store?.close();
		vi.unstubAllEnvs();
		await rm(home, { recursive: true, force: true });
	}
});

it.each(["session_stream_id", "session_id", "stream_id", "opencode_session_id"])(
	"queues the same validated event and metadata from flat and wrapped %s requests",
	async (alias) => {
		// Arrange: omitted source exercises the normalizer's OpenCode default.
		const event = {
			[alias]: "synthetic-session",
			event_id: "synthetic-event",
			event_type: "user_prompt",
			cwd: "/synthetic/project",
			project: "synthetic-project",
			started_at: "2026-01-01T00:00:00Z",
			payload: { text: "synthetic café 日本語" },
		};
		const serialized = ` \n${JSON.stringify(event, null, 2)}\t\n`;
		const wrapped = buildRejectedEventBatchBody(serialized, target);
		const { post, enqueue, getStore } = fixture();
		// Act: both requests run the real route's target validation and core normalizer.
		const flatResponse = await post(JSON.stringify({ ...event, ...target }));
		const wrappedResponse = await post(wrapped);
		// Assert: only transport shape differs at the durable queue boundary.
		for (const response of [flatResponse, wrappedResponse]) {
			expect(response.status).toBe(202);
			expect(rejectedEventAcknowledgement(response.status, await response.json())).toEqual({
				acknowledged: true,
				acknowledgement: "queued",
			});
		}
		expect(wrapped).toContain(`"events":[${serialized}]`);
		expect(enqueue.mock.calls).toEqual([
			[event, { flushBoundary: false }],
			[
				{
					[alias]: event[alias],
					cwd: event.cwd,
					project: event.project,
					started_at: event.started_at,
					events: [event],
				},
				{ flushBoundary: false },
			],
		]);
		expect(getStore).not.toHaveBeenCalled();
		// Act: consume both real queue requests through the persistence normalizer.
		const snapshots = enqueue.mock.calls.map(([request]) => persistedSnapshot(request));
		// Assert: compare every stored column except generated timestamps.
		expect(snapshots[1]).toEqual(snapshots[0]);
		expect(snapshots[0]).toMatchObject({
			events: [
				{
					source: "opencode",
					stream_id: "synthetic-session",
					event_id: event.event_id,
					event_type: event.event_type,
					payload_json: JSON.stringify(event.payload),
				},
			],
			sessions: [
				{
					source: "opencode",
					stream_id: "synthetic-session",
					cwd: event.cwd,
					project: event.project,
					started_at: event.started_at,
				},
			],
		});
	},
);

it.each(["database", "identity"])(
	"rejects a wrapped request with mismatched %s before enqueue",
	async (kind) => {
		// Arrange
		const selected = { ...target };
		if (kind === "database") selected.db_path = resolve("different-synthetic.sqlite");
		if (kind === "identity") selected.identity_target = { ...identity, device_id: "different" };
		const serialized = JSON.stringify({
			session_id: "synthetic-session",
			event_id: "synthetic-event",
			event_type: "user_prompt",
			payload: { text: "synthetic" },
		});
		const { post, enqueue, getStore } = fixture();
		// Act
		const response = await post(buildRejectedEventBatchBody(serialized, selected));
		const body = await response.json();
		// Assert
		expect(response.status).toBe(409);
		expect(body).toEqual({
			error: {
				code: kind === "database" ? "viewer_db_mismatch" : "viewer_identity_mismatch",
				message: expect.any(String),
			},
		});
		expect(rejectedEventAcknowledgement(response.status, body)).toBe(false);
		expect(enqueue).not.toHaveBeenCalled();
		expect(getStore).not.toHaveBeenCalled();
	},
);

it("rejects conflicting aliases through the real normalizer in both transport shapes", async () => {
	// Arrange
	const event = {
		session_id: "synthetic-one",
		stream_id: "synthetic-two",
		event_id: "synthetic-event",
		event_type: "user_prompt",
		payload: {},
	};
	const { post, enqueue, getStore } = fixture();
	// Act
	const responses = await Promise.all([
		post(JSON.stringify({ ...event, ...target })),
		post(buildRejectedEventBatchBody(JSON.stringify(event), target)),
	]);
	// Assert
	for (const response of responses) {
		expect(response.status).toBe(400);
		expect(rejectedEventAcknowledgement(response.status, await response.json())).toBe(false);
	}
	expect(enqueue).not.toHaveBeenCalled();
	expect(getStore).not.toHaveBeenCalled();
});
