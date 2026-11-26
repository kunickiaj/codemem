import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index.js";
import { FileRawEventInbox } from "./raw-event-inbox.js";

// The inbox file is the first durable write of a raw-event request. These tests read
// its bytes, before anything is drained into SQLite.

const S = "SYNTHETIC_PRIVATE";
const REDACTED = "[REDACTED]";

let root: string;
let release: () => void;
let inbox: FileRawEventInbox;
let store: MemoryStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codemem-inbox-private-"));
	store = new MemoryStore(join(root, "mem.sqlite"));
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	inbox = new FileRawEventInbox({
		directory: join(root, "inbox"),
		processEntry: async () => await blocked,
	});
});

afterEach(async () => {
	release();
	await inbox.stop();
	store.close();
	rmSync(root, { recursive: true, force: true });
});

async function queuedBytes(body: unknown): Promise<string> {
	const app = createApp({ storeFactory: () => store, rawEventInbox: inbox });
	const response = await app.request("/api/raw-events", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:38888" },
		body: JSON.stringify(body),
	});
	expect(response.status).toBe(202);
	const files = readdirSync(join(root, "inbox")).filter((name) => name.endsWith(".json"));
	expect(files).toHaveLength(1);
	return readFileSync(join(root, "inbox", files[0] ?? ""), "utf8");
}

const storedRequest = (bytes: string) => JSON.parse(bytes).request as Record<string, unknown>;

describe("raw-event inbox file", () => {
	it("redacts secret-named fields at every depth, as before, when no marker is present", async () => {
		const bytes = await queuedBytes({
			session_stream_id: "inbox-secrets",
			token: "TOP_LEVEL_SECRET",
			events: [
				{
					event_id: "secrets",
					event_type: "tool.execute.after",
					cookie: "EVENT_LEVEL_SECRET",
					payload: {
						type: "tool.execute.after",
						tool: "bash",
						password: "DEPTH_1_SECRET",
						args: { command: "deploy", api_key: "DEPTH_2_SECRET" },
						result: { steps: [{ name: "login", authorization: "DEPTH_4_SECRET" }] },
					},
				},
			],
		});

		for (const secret of ["TOP_LEVEL", "EVENT_LEVEL", "DEPTH_1", "DEPTH_2", "DEPTH_4"]) {
			expect(bytes).not.toContain(`${secret}_SECRET`);
		}
		// The payload is stored exactly as the earlier recursive redaction left it.
		expect((storedRequest(bytes).events as Array<Record<string, unknown>>)[0]?.payload).toEqual({
			type: "tool.execute.after",
			tool: "bash",
			password: REDACTED,
			args: { command: "deploy", api_key: REDACTED },
			result: { steps: [{ name: "login", authorization: REDACTED }] },
		});
	});

	it("stores no marked field and drops a marked capture context", async () => {
		const text = "Inspect the queue";
		const bytes = await queuedBytes({
			source: "opencode",
			session_stream_id: "child",
			event_id: "brief",
			event_type: "user_prompt",
			notes: `unknown field <private>${S}</private>`,
			cwd: `/work/<private>${S}</private>repo`,
			payload: { type: "user_prompt", prompt_text: `${text} <private>${S}</private>` },
			capture_context: {
				version: 1,
				host: "opencode-v1",
				origin: "delegated_brief",
				parent_session_id: "parent",
				child_session_id: "child",
				task_call_id: "task",
				message_id: "message",
				requested_agent: `explore<private>${S}</private>`,
				current_agent: `explore<private>${S}</private>`,
				brief_sha256: createHash("sha256").update(text).digest("hex"),
			},
		});

		expect(bytes).not.toContain(S);
		expect(storedRequest(bytes)).toEqual({
			source: "opencode",
			session_stream_id: "child",
			event_id: "brief",
			event_type: "user_prompt",
			cwd: "/work/repo",
			payload: { type: "user_prompt", prompt_text: `${text} ` },
		});
	});
});
