import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRawEventSpoolEntries } from "../../opencode-plugin/.opencode/lib/raw-event-spool.js";
import { CodememPlugin } from "../../opencode-plugin/index.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { MemoryStore } from "./store.js";

const HAND_AUTHORED_OPEN_CODE_V1_SOURCE_SHAPE = "1.18.30";
const parentSessionID = "parent-session";
const childSessionID = "child-session";
const parentMessageID = "parent-message";
const childMessageID = "child-message";
const partID = "child-text";
const callID = "task-call";
const agent = "explore";
const brief = "Inspect retry ownership and report only observed findings.";
const createdAt = 2_000_000_000_001;
const fixtureDescription = `hand-authored OpenCode V1 ${HAND_AUTHORED_OPEN_CODE_V1_SOURCE_SHAPE} source-aligned delegation adapter fixture`;

type SnapshotMode = "exact" | "partial" | "mixed" | "time-mismatch";

const taskEvent = (startedAt: number) => ({
	type: "message.part.updated",
	properties: {
		part: {
			id: "parent-task-part",
			type: "tool",
			tool: "task",
			callID,
			sessionID: parentSessionID,
			messageID: parentMessageID,
			state: {
				status: "running",
				time: { start: startedAt },
				input: { subagent_type: agent, description: "Inspect retries", prompt: brief },
				metadata: {
					parentSessionId: parentSessionID,
					sessionId: childSessionID,
					model: {
						providerID: "fixture",
						modelID: HAND_AUTHORED_OPEN_CODE_V1_SOURCE_SHAPE,
					},
				},
			},
		},
	},
});

const userInfo = () => ({
	id: childMessageID,
	sessionID: childSessionID,
	role: "user",
	agent,
	time: { created: createdAt },
});

const textPart = (text = brief) => ({
	id: partID,
	sessionID: childSessionID,
	messageID: childMessageID,
	type: "text",
	text,
});

function persistedMessage(mode: SnapshotMode) {
	const snapshot = { info: userInfo(), parts: [textPart()] as Array<Record<string, unknown>> };
	if (mode === "partial") snapshot.parts[0] = textPart(brief.slice(0, -1));
	if (mode === "mixed") {
		snapshot.parts.push({
			id: "child-file",
			sessionID: childSessionID,
			messageID: childMessageID,
			type: "file",
			url: "file:///fixture-only",
		});
	}
	if (mode === "time-mismatch") snapshot.info.time.created += 1;
	return snapshot;
}

async function createAdapterFixture(mode: SnapshotMode = "exact") {
	const homeDir = await mkdtemp(path.join(tmpdir(), "codemem-v1-delegation-"));
	for (const [key, value] of Object.entries({
		HOME: homeDir,
		CODEMEM_RAW_EVENTS: "1",
		CODEMEM_VIEWER: "0",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		CODEMEM_RUNNER: "/usr/bin/true",
	})) {
		vi.stubEnv(key, value);
	}
	const envelopes: Array<Record<string, unknown>> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init?: RequestInit) => {
			if (init?.method === "POST") envelopes.push(JSON.parse(String(init.body)));
			return new Response(JSON.stringify({ ingest: { available: true } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
	const snapshot = persistedMessage(mode);
	const sessionGet = vi.fn(async () => ({
		data: { id: childSessionID, parentID: parentSessionID },
	}));
	const sessionMessage = vi.fn(async () => ({ data: snapshot }));
	const hooks = await CodememPlugin({
		project: { name: `v1-${path.basename(homeDir)}`, root: homeDir },
		client: {
			app: { log: vi.fn(async () => undefined) },
			session: { get: sessionGet, message: sessionMessage },
			tui: {},
		},
		directory: homeDir,
		worktree: homeDir,
	} as never);
	return { envelopes, homeDir, hooks, sessionGet, sessionMessage, snapshot };
}

async function drivePersistedPrompt(
	fixture: Awaited<ReturnType<typeof createAdapterFixture>>,
	options: { mutateHook?: boolean; observeHook?: boolean } = {},
) {
	const startedAt = Date.now();
	await fixture.hooks.event?.({ event: taskEvent(startedAt) } as never);
	const output = { message: userInfo(), parts: [textPart()] };
	if (options.observeHook !== false) {
		await fixture.hooks["chat.message"]?.(
			{ sessionID: childSessionID, messageID: childMessageID, agent },
			output as never,
		);
	}
	const firstPart = output.parts[0];
	if (options.mutateHook && firstPart) firstPart.text = `${brief} changed by a later hook`;
	await fixture.hooks.event?.({
		event: { type: "message.updated", properties: { info: fixture.snapshot.info } },
	} as never);
	for (const part of fixture.snapshot.parts) {
		await fixture.hooks.event?.({
			event: { type: "message.part.updated", properties: { part } },
		} as never);
	}
	await fixture.hooks.event?.({
		event: {
			type: "message.updated",
			properties: {
				info: {
					id: "assistant-message",
					sessionID: childSessionID,
					role: "assistant",
				},
			},
		},
	} as never);
	await vi.waitFor(() => {
		expect(
			fixture.envelopes.some(
				(envelope) =>
					envelope.event_type === "user_prompt" && envelope.session_stream_id === childSessionID,
			),
		).toBe(true);
	});
	const envelope = fixture.envelopes.find(
		(envelope) =>
			envelope.event_type === "user_prompt" && envelope.session_stream_id === childSessionID,
	);
	if (!envelope) throw new Error("Expected captured child prompt envelope");
	return envelope;
}

async function disposeFixture(fixture: Awaited<ReturnType<typeof createAdapterFixture>>) {
	await fixture.hooks.dispose?.();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(fixture.homeDir, { recursive: true, force: true });
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe(fixtureDescription, () => {
	it("captures exact hook and SDK snapshots and flushes a proven brief without observer", async () => {
		// Arrange
		const fixture = await createAdapterFixture();
		let store: MemoryStore | undefined;

		try {
			// Act
			const envelope = await drivePersistedPrompt(fixture);
			const dbPath = path.join(fixture.homeDir, "captured.sqlite");
			store = new MemoryStore(dbPath);
			ingestRawEvents(store, envelope);
			store.recordRawEvent({
				opencodeSessionId: childSessionID,
				eventId: "idle-after-brief",
				eventType: "session.idle",
				payload: {},
			});
			const observe = vi.fn();
			const flushed = await flushRawEvents(
				store,
				{ observer: { observe } } as unknown as IngestOptions,
				{ opencodeSessionId: childSessionID },
			);

			// Assert
			expect((envelope.payload as { prompt_text?: string }).prompt_text).toBe(brief);
			expect(envelope?.capture_context).toEqual({
				version: 1,
				host: "opencode-v1",
				origin: "delegated_brief",
				parent_session_id: parentSessionID,
				child_session_id: childSessionID,
				task_call_id: callID,
				message_id: childMessageID,
				requested_agent: agent,
				current_agent: agent,
				brief_sha256: createHash("sha256").update(brief).digest("hex"),
			});
			expect(fixture.sessionGet).toHaveBeenCalledWith({
				path: { id: childSessionID },
				signal: expect.any(AbortSignal),
			});
			expect(fixture.sessionMessage).toHaveBeenCalledWith({
				path: { id: childSessionID, messageID: childMessageID },
				signal: expect.any(AbortSignal),
			});
			expect(flushed).toEqual({ flushed: 2, updatedState: 1 });
			expect(observe).not.toHaveBeenCalled();
		} finally {
			store?.close();
			await disposeFixture(fixture);
		}
	});

	it.each([
		{ name: "missing hook snapshot", mode: "exact" as const, observeHook: false },
		{ name: "later hook mutation", mode: "exact" as const, mutateHook: true },
		{ name: "partial SDK message", mode: "partial" as const },
		{ name: "mixed SDK message", mode: "mixed" as const },
		{ name: "SDK timestamp mismatch", mode: "time-mismatch" as const },
	])("keeps provenance unknown for $name", async ({ mode, ...options }) => {
		// Arrange
		const fixture = await createAdapterFixture(mode);

		try {
			// Act
			const envelope = await drivePersistedPrompt(fixture, options);

			// Assert
			expect(envelope).not.toHaveProperty("capture_context");
			if (options.observeHook === false) {
				expect(fixture.sessionGet).not.toHaveBeenCalled();
				expect(fixture.sessionMessage).not.toHaveBeenCalled();
			} else {
				expect(fixture.sessionGet).toHaveBeenCalledOnce();
				expect(fixture.sessionMessage).toHaveBeenCalledOnce();
			}
		} finally {
			await disposeFixture(fixture);
		}
	});
});

describe(`${fixtureDescription} disposal`, () => {
	it("preserves delegated provenance while draining a pending prompt", async () => {
		const fixture = await createAdapterFixture();
		try {
			await fixture.hooks.event?.({ event: taskEvent(Date.now()) } as never);
			await fixture.hooks["chat.message"]?.(
				{ sessionID: childSessionID, messageID: childMessageID, agent },
				{ message: userInfo(), parts: [textPart()] } as never,
			);
			await fixture.hooks.event?.({
				event: { type: "message.updated", properties: { info: fixture.snapshot.info } },
			} as never);
			for (const part of fixture.snapshot.parts) {
				await fixture.hooks.event?.({
					event: { type: "message.part.updated", properties: { part } },
				} as never);
			}

			await fixture.hooks.dispose?.();

			const spool = await loadRawEventSpoolEntries({ homeDir: fixture.homeDir });
			const envelope = spool.entries.find(
				(entry) =>
					entry.envelope.event_type === "user_prompt" &&
					entry.envelope.session_stream_id === childSessionID,
			);
			expect(envelope?.envelope.capture_context).toMatchObject({
				origin: "delegated_brief",
				parent_session_id: parentSessionID,
				child_session_id: childSessionID,
				task_call_id: callID,
			});
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			await rm(fixture.homeDir, { recursive: true, force: true });
		}
	});
});
