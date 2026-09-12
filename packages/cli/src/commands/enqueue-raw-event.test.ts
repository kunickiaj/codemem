import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEnqueueRawEvent } from "./enqueue-raw-event.js";

const cleanupPaths: string[] = [];
const originalExitCode = process.exitCode;

function tempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-enqueue-raw-event-"));
	cleanupPaths.push(dir);
	return join(dir, "test.sqlite");
}

async function captureRuntimePromptEnvelope(
	homeDir: string,
	promptText: string,
	captureContext: Record<string, unknown>,
) {
	for (const [key, value] of Object.entries({
		HOME: homeDir,
		CODEMEM_RAW_EVENTS: "1",
		CODEMEM_VIEWER: "0",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		CODEMEM_RUNNER: "/usr/bin/false",
	})) {
		vi.stubEnv(key, value);
	}
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			if (init?.method === "GET") {
				return new Response(JSON.stringify({ ingest: { available: true } }), { status: 200 });
			}
			throw new Error("viewer unavailable");
		}),
	);
	const runtimeModule = await import(
		new URL("../../../opencode-plugin/.opencode/lib/runtime.js", import.meta.url).href
	);
	const spoolModule = await import(
		new URL("../../../opencode-plugin/.opencode/lib/raw-event-spool.js", import.meta.url).href
	);
	const resolveCaptureContext = vi.fn(async () => captureContext);
	const runtime = await runtimeModule.createCodememRuntime({
		location: {
			project: { name: "cli-wire", root: homeDir },
			directory: homeDir,
			worktree: homeDir,
		},
		host: { log: async () => undefined, notify: null, resolveCaptureContext },
	});
	try {
		await runtime.handleEvent({
			type: "message.updated",
			sessionID: "child-wire",
			messageInfo: {
				id: "message-wire",
				sessionID: "child-wire",
				role: "user",
				agent: "explore",
				time: { created: 201 },
			},
		});
		await runtime.handleEvent({
			type: "message.part.updated",
			sessionID: "child-wire",
			part: {
				id: "prompt-part",
				messageID: "message-wire",
				sessionID: "child-wire",
				type: "text",
				text: promptText,
			},
		});
		await runtime.handleEvent({ type: "session.idle", sessionID: "child-wire" });
		await runtime.dispose();
		const loaded = await spoolModule.loadRawEventSpoolEntries({ homeDir });
		const envelope = loaded.entries[0]?.envelope;
		if (!envelope) throw new Error("runtime prompt envelope was not spooled");
		return { envelope, resolveCaptureContext };
	} finally {
		await runtime.dispose();
	}
}

afterEach(() => {
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("enqueue-raw-event command", () => {
	it("keeps successful ingestion silent", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		process.exitCode = undefined;

		await runEnqueueRawEvent(
			{ dbPath: tempDbPath() },
			{
				readPayload: async () => ({
					source: "opencode",
					session_id: "session-command-success",
					event_id: "event-command-success",
					event_type: "prompt",
					payload: { text: "hello" },
				}),
			},
		);

		expect(log).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("preserves the OpenCode prompt envelope through spool and CLI ingress", async () => {
		// Arrange
		const homeDir = await mkdtemp(join(tmpdir(), "codemem-cli-wire-"));
		const dbPath = join(homeDir, "wire.sqlite");
		const promptText = "Inspect retry ownership and return observed findings.";
		const captureContext = {
			version: 1,
			host: "opencode-v1",
			origin: "delegated_brief",
			parent_session_id: "parent-wire",
			child_session_id: "child-wire",
			task_call_id: "call-wire",
			message_id: "message-wire",
			requested_agent: "explore",
			current_agent: "explore",
			brief_sha256: createHash("sha256").update(promptText).digest("hex"),
		};

		try {
			// Act
			const captured = await captureRuntimePromptEnvelope(homeDir, promptText, captureContext);
			await runEnqueueRawEvent({ dbPath }, { readPayload: async () => captured.envelope });

			// Assert
			expect(captured.resolveCaptureContext).toHaveBeenCalledWith({
				sessionID: "child-wire",
				messageID: "message-wire",
				text: promptText,
			});
			const store = new MemoryStore(dbPath);
			try {
				const row = store.db
					.prepare("SELECT event_type, payload_json, capture_context_json FROM raw_events")
					.get() as {
					event_type: string;
					payload_json: string;
					capture_context_json: string;
				};
				expect({
					eventType: row.event_type,
					payload: JSON.parse(row.payload_json),
					captureContext: JSON.parse(row.capture_context_json),
				}).toEqual({
					eventType: "user_prompt",
					payload: expect.objectContaining({
						type: "user_prompt",
						prompt_number: 1,
						prompt_text: promptText,
					}),
					captureContext,
				});
			} finally {
				store.close();
			}
		} finally {
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("reports canonical validation failures as validation_error", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		process.exitCode = undefined;

		await runEnqueueRawEvent(
			{ dbPath: tempDbPath() },
			{
				readPayload: async () => ({
					source: "opencode",
					session_id: "session-command-invalid",
					event_id: "contains spaces",
					event_type: "prompt",
					payload: {},
				}),
			},
		);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "validation_error",
		});
		expect(process.exitCode).toBe(1);
	});

	it("reports non-validation failures as enqueue_error", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		process.exitCode = undefined;

		await runEnqueueRawEvent(
			{ dbPath: tempDbPath() },
			{
				readPayload: async () => {
					throw new Error("stdin failed");
				},
			},
		);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "enqueue_error",
			message: "stdin failed",
		});
		expect(process.exitCode).toBe(1);
	});
});
