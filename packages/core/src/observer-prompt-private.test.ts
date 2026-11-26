import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingest } from "./ingest-pipeline.js";
import { buildObserverPrompt, buildObserverRepairPrompt } from "./ingest-prompts.js";
import type { ObserverContext, ToolEvent } from "./ingest-types.js";
import { ObserverClient } from "./observer-client.js";
import { MemoryStore } from "./store.js";

/*
 * Text a user marks <private> never reaches the observer: not in the request, the
 * summary context, delegated briefs or tool events, within or over budget.
 */

const SECRET = "SYNTHETIC_PRIVATE_VALUE";
const hidden = (label: string) => `${label} before <private>${SECRET} ${label}</private> after`;

function privateBatch(overrides: Partial<ObserverContext> = {}): ObserverContext {
	const toolEvent: ToolEvent = {
		toolName: "read",
		toolInput: { path: hidden("path") },
		toolOutput: hidden("output"),
		toolError: hidden("error"),
		timestamp: null,
		cwd: null,
	};
	return {
		project: null,
		promptNumber: 1,
		includeSummary: true,
		userPrompt: hidden("REQUEST"),
		transcript: hidden("TRANSCRIPT"),
		diffSummary: hidden("DIFF"),
		recentFiles: hidden("FILES"),
		toolEvents: [toolEvent],
		lastAssistantMessage: hidden("ASSISTANT"),
		delegatedBriefs: [hidden("BRIEF")],
		...overrides,
	};
}

const variants = [
	["summary XML", true, "legacy_xml"],
	["summary JSON", true, "json_schema"],
	["observations-only XML", false, "legacy_xml"],
	["observations-only JSON", false, "json_schema"],
] as const;

describe("private blocks in the observer prompt", () => {
	for (const [name, includeSummary, outputMode] of variants) {
		it(`leaves them out of ${name} content within budget`, () => {
			const prompt = buildObserverPrompt(privateBatch({ includeSummary }), {
				outputMode,
				maxChars: 48_000,
			});

			expect(prompt.user).not.toContain(SECRET);
			expect(prompt.user).not.toContain("<private>");
			expect(prompt.user).toContain("REQUEST before");
			expect(prompt.user).toContain("BRIEF before");
			if (includeSummary) expect(prompt.user).toContain("ASSISTANT before");
		});

		it(`leaves them out of ${name} content over budget and of the repair prompt`, () => {
			const context = privateBatch({
				includeSummary,
				transcript: `${hidden("TRANSCRIPT")} ${"filler ".repeat(4_000)}`,
				lastAssistantMessage: `${hidden("ASSISTANT")} ${"more ".repeat(400)}`,
			});
			const prompt = buildObserverPrompt(context, { outputMode, maxChars: 12_000 });
			const repair = buildObserverRepairPrompt(prompt.system, prompt.user, "<summary/>");

			expect(prompt.contentChars).toBeGreaterThan(prompt.user.length);
			expect(prompt.user).not.toContain(SECRET);
			expect(repair.user).not.toContain(SECRET);
		});
	}
});

describe("private blocks through the public ingest entry", () => {
	let directory: string;
	let store: MemoryStore;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-private-ingest-"));
		store = new MemoryStore(join(directory, "test.sqlite"));
	});
	afterEach(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it("never sends the request's or the last assistant message's private text", async () => {
		const sent = vi.fn(async (_system: string, _user: string) => {
			throw new Error("captured");
		});
		const observer = Object.assign(Object.create(ObserverClient.prototype), {
			maxChars: 12_000,
			runtime: "test",
			_callOnce: sent,
			getStatus: () => ({
				provider: "test",
				model: "fixture",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		}) as ObserverClient;
		const now = new Date().toISOString();

		await ingest(
			{
				cwd: directory,
				project: "fixture",
				startedAt: now,
				events: [
					{ type: "user_prompt", prompt_text: hidden("REQUEST"), timestamp: now },
					{ type: "assistant_message", assistant_text: hidden("ASSISTANT"), timestamp: now },
				],
			},
			store,
			{ observer },
		).catch(() => undefined);

		const user = sent.mock.calls[0]?.[1] ?? "";
		expect(user).toContain("REQUEST before");
		expect(user).toContain("ASSISTANT before");
		expect(user).not.toContain(SECRET);
	});
});
