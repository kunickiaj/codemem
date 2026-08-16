import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEnqueueRawEvent } from "./enqueue-raw-event.js";

const cleanupPaths: string[] = [];
const originalExitCode = process.exitCode;

function tempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-enqueue-raw-event-"));
	cleanupPaths.push(dir);
	return join(dir, "test.sqlite");
}

afterEach(() => {
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
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
