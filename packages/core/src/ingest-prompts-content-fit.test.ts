import { describe, expect, it } from "vitest";
import { boundedDelegatedBriefs, DELEGATED_BRIEF_LABEL } from "./capture-context.js";
import { buildObserverPrompt } from "./ingest-prompts.js";
import type { ObserverContext, ToolEvent } from "./ingest-types.js";
import { observerContentBudget } from "./observer-prompt-budget.js";

/*
 * Over-budget observer content is cut by section instead of by prefix; content
 * within budget is sent exactly as before.
 */

const MARKER = "[...]";

function text(label: string, length: number): string {
	return `${label} ${"word ".repeat(Math.ceil(length / 5))}`.slice(0, length);
}

function toolEvent(index: number, toolName = "read", outputLength = 1_260): ToolEvent {
	return {
		toolName,
		toolInput: { path: `f${index}.ts` },
		toolOutput: `TOOL_${index} ${"x".repeat(outputLength)}`,
		toolError: null,
		timestamp: null,
		cwd: null,
	};
}

/** About 300 request, 4,800 transcript, 7,000 tool event and 900 summary characters. */
function exampleBatch(overrides: Partial<ObserverContext> = {}): ObserverContext {
	return {
		project: null,
		promptNumber: null,
		includeSummary: true,
		diffSummary: "",
		recentFiles: "",
		userPrompt: text("REQUEST", 210),
		transcript: `${text("TRANSCRIPT_START", 4_720)} TRANSCRIPT_END`,
		toolEvents: [0, 1, 2, 3].map((index) => toolEvent(index)).concat(toolEvent(4, "edit")),
		lastAssistantMessage: text("ASSISTANT", 825),
		...overrides,
	};
}

function sentLengths(context: ObserverContext, maxChars: number) {
	const prompt = buildObserverPrompt(context, { outputMode: "legacy_xml", maxChars });
	return Object.fromEntries(prompt.sections.map((section) => [section.name, section.sentChars]));
}

function xml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function json(value: unknown): string {
	if (value == null) return "";
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function previousRequest(context: ObserverContext): string {
	const block = [
		"<observed_from_primary_session>",
		`  <user_request>${xml(context.userPrompt)}</user_request>`,
	];
	if (context.promptNumber != null)
		block.push(`  <prompt_number>${context.promptNumber}</prompt_number>`);
	if (context.project) block.push(`  <project>${xml(context.project)}</project>`);
	block.push("</observed_from_primary_session>");
	return block.join("\n");
}

function previousToolEvent(event: ToolEvent): string {
	const block = [
		"<observed_from_primary_session>",
		`  <what_happened>${xml(event.toolName)}</what_happened>`,
	];
	for (const [tag, value] of [
		["parameters", event.toolInput],
		["outcome", event.toolOutput],
		["error", event.toolError],
	] as const) {
		const formatted = xml(json(value));
		if (formatted) block.push(`  <${tag}>${formatted}</${tag}>`);
	}
	block.push("</observed_from_primary_session>");
	return block.join("\n");
}

function previousPrimary(tag: string, value: string): string[] {
	return value
		? [
				`<observed_from_primary_session>\n  <${tag}>${xml(value)}</${tag}>\n</observed_from_primary_session>`,
			]
		: [];
}

/** The content as built before sections were fitted, for comparison. */
function previousUser(context: ObserverContext): string {
	const summary =
		context.includeSummary && context.lastAssistantMessage
			? [
					"Summary context:",
					`<summary_context>\n  <assistant_response>${xml(context.lastAssistantMessage)}</assistant_response>\n</summary_context>`,
				]
			: [];
	const user = [
		"Observed session context:",
		...(context.userPrompt ? [previousRequest(context)] : []),
		...(context.transcript.trim()
			? [`<conversation_transcript>\n${xml(context.transcript)}\n</conversation_transcript>`]
			: []),
		...previousPrimary("diff_summary", context.diffSummary),
		...previousPrimary("recent_files", context.recentFiles),
		...context.toolEvents.map(previousToolEvent),
		...summary,
	]
		.join("\n\n")
		.trim();
	const briefs = boundedDelegatedBriefs(context.delegatedBriefs ?? []);
	if (briefs.length === 0) return user;
	return `${user}\n\n[${DELEGATED_BRIEF_LABEL}]\n${briefs.map(xml).join("\n\n")}`;
}

describe("observer content within budget", () => {
	it.each([
		["summary XML", true, "legacy_xml"],
		["summary JSON", true, "json_schema"],
		["observations-only XML", false, "legacy_xml"],
		["observations-only JSON", false, "json_schema"],
	] as const)("sends %s content exactly as before", (_name, includeSummary, outputMode) => {
		const context = exampleBatch({
			includeSummary,
			project: "codemem & co",
			promptNumber: 3,
			diffSummary: "M src/queue.ts",
			recentFiles: "src/queue.ts, src/queue.test.ts",
			delegatedBriefs: ["Check <the> queue"],
		});

		const prompt = buildObserverPrompt(context, { outputMode, maxChars: 48_000 });

		expect(prompt.user).toBe(previousUser(context));
		expect(prompt.sections.every((section) => section.sentChars === section.chars)).toBe(true);
	});
});

describe("observer content over budget", () => {
	it("cuts the example batch by section at 12,000", () => {
		const context = exampleBatch();
		const prompt = buildObserverPrompt(context, { outputMode: "legacy_xml", maxChars: 12_000 });

		expect(prompt.sections.map(({ name, chars }) => [name, chars])).toEqual([
			["request", 306],
			["transcript", 4_788],
			["tool_events", 7_308],
			["summary_context", 923],
		]);
		// The request is whole, the summary context keeps a quarter of the 3,000-character
		// budget, and the transcript and tool events share the rest by size.
		expect(sentLengths(context, 12_000)).toEqual({
			request: 306,
			transcript: 756,
			tool_events: 1_155,
			summary_context: 750,
		});
		expect(prompt.user.length).toBeLessThanOrEqual(3_000);
		expect(prompt.user).toContain("TRANSCRIPT_START");
		expect(prompt.user).toContain("TRANSCRIPT_END");
	});

	it("keeps the example batch whole at 30,000 and 48,000", () => {
		const whole = { request: 306, transcript: 4_788, tool_events: 7_308, summary_context: 923 };
		expect(sentLengths(exampleBatch(), 30_000)).toEqual(whole);
		expect(sentLengths(exampleBatch(), 48_000)).toEqual(whole);
	});

	it("fits a batch far over budget at 48,000 and marks every cut section", () => {
		const context = exampleBatch({
			transcript: `${text("TRANSCRIPT_START", 150_000)} TRANSCRIPT_END`,
			toolEvents: Array.from({ length: 30 }, (_, index) => toolEvent(index, "read", 4_000)),
			lastAssistantMessage: text("ASSISTANT", 40_000),
			recentFiles: text("FILES", 2_000),
			delegatedBriefs: ["Earlier instructions"],
		});
		const prompt = buildObserverPrompt(context, { outputMode: "legacy_xml", maxChars: 48_000 });
		const budget = observerContentBudget(48_000, prompt.system.length);

		expect(prompt.user.length).toBeLessThanOrEqual(budget);
		expect(prompt.user.length).toBeGreaterThan(budget - 200);
		const sent = Object.fromEntries(prompt.sections.map((section) => [section.name, section]));
		expect(sent.request?.sentChars).toBe(sent.request?.chars);
		expect(sent.summary_context?.sentChars).toBeLessThanOrEqual(Math.floor(budget / 4));
		expect(sent.recent_files?.sentChars).toBeLessThanOrEqual(400);
		for (const tag of ["conversation_transcript", "recent_files", "summary_context"]) {
			const block = prompt.user.slice(
				prompt.user.indexOf(`<${tag}>`),
				prompt.user.indexOf(`</${tag}>`),
			);
			expect(block, tag).toContain(MARKER);
		}
		expect(prompt.user).toContain("TRANSCRIPT_END");
		expect(prompt.user).toContain(`TOOL_0 `);
	});

	it("keeps sections in their usual order", () => {
		const context = exampleBatch({
			diffSummary: text("DIFF", 1_000),
			recentFiles: text("FILES", 1_000),
			delegatedBriefs: ["Earlier instructions"],
		});
		const prompt = buildObserverPrompt(context, { outputMode: "legacy_xml", maxChars: 12_000 });
		const positions = [
			"<user_request>",
			"<conversation_transcript>",
			"<diff_summary>",
			"<recent_files>",
			"<what_happened>",
			"<summary_context>",
		].map((tag) => prompt.user.indexOf(tag));

		expect(positions.every((position) => position > 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	it("leaves out tool events by priority and marks where they were", () => {
		const prompt = buildObserverPrompt(exampleBatch(), {
			outputMode: "legacy_xml",
			maxChars: 12_000,
		});
		const tools = prompt.user.slice(
			prompt.user.indexOf("<what_happened>") - 40,
			prompt.user.indexOf("Summary context:"),
		);

		// The edit outranks reads, and the earliest read wins a tie.
		expect(tools).toContain("TOOL_4");
		expect(tools).toContain("TOOL_0");
		expect(tools).not.toContain("TOOL_2");
		expect(tools).toContain(MARKER);
	});

	it("sends only the request, cut head and tail, when it alone is over budget", () => {
		const context = exampleBatch({ userPrompt: `${text("REQUEST_START", 20_000)} REQUEST_END` });
		const prompt = buildObserverPrompt(context, { outputMode: "legacy_xml", maxChars: 12_000 });

		expect(prompt.user.length).toBeLessThanOrEqual(3_000);
		expect(prompt.user).toContain("REQUEST_START");
		expect(prompt.user).toContain("REQUEST_END");
		expect(prompt.user).toContain(MARKER);
		expect(sentLengths(context, 12_000)).toMatchObject({
			transcript: 0,
			tool_events: 0,
			summary_context: 0,
		});
	});

	it("is deterministic", () => {
		const first = buildObserverPrompt(exampleBatch(), {
			outputMode: "legacy_xml",
			maxChars: 12_000,
		});
		const second = buildObserverPrompt(exampleBatch(), {
			outputMode: "legacy_xml",
			maxChars: 12_000,
		});

		expect(second).toEqual(first);
	});
});

/** Every emitted tool event opens and closes each of its tags exactly once, in order. */
function expectWellFormedEvents(user: string) {
	const events =
		user.match(
			/<observed_from_primary_session>\n {2}<what_happened>[\s\S]*?<\/observed_from_primary_session>/g,
		) ?? [];
	for (const event of events) {
		for (const tag of ["what_happened", "parameters", "outcome", "error"]) {
			const opens = event.split(`<${tag}>`).length - 1;
			const closes = event.split(`</${tag}>`).length - 1;
			expect(opens, `${tag} in ${event.slice(0, 120)}`).toBe(closes);
			expect(opens).toBeLessThanOrEqual(1);
		}
	}
	// No entity is cut short: every & starts a complete entity.
	expect(user).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
	return events;
}

describe("tool events cut to fit", () => {
	it("cuts oversized parameters inside their tags", () => {
		const event: ToolEvent = {
			toolName: "bash",
			toolInput: { command: `PARAM_START ${"echo x && ".repeat(1_500)} PARAM_END` },
			toolOutput: `OUTPUT_START ${"line ".repeat(1_000)} OUTPUT_END`,
			toolError: null,
			timestamp: null,
			cwd: null,
		};
		const prompt = buildObserverPrompt(exampleBatch({ toolEvents: [event] }), {
			outputMode: "legacy_xml",
			maxChars: 12_000,
		});

		const [emitted] = expectWellFormedEvents(prompt.user);
		expect(emitted).toContain("PARAM_START");
		expect(emitted).toContain("PARAM_END");
		expect(emitted).toContain("[...]");
		expect(emitted).toContain("<outcome>OUTPUT_START");
		expect(emitted).toContain("OUTPUT_END</outcome>");
	});

	it("never cuts inside an escaped entity", () => {
		for (let length = 1_000; length < 1_040; length += 1) {
			const event: ToolEvent = {
				toolName: "read",
				toolInput: { path: "a.ts" },
				toolOutput: `${"<&>".repeat(length)}`,
				toolError: null,
				timestamp: null,
				cwd: null,
			};
			const prompt = buildObserverPrompt(exampleBatch({ toolEvents: [event, toolEvent(1)] }), {
				outputMode: "legacy_xml",
				maxChars: 12_000,
			});

			expectWellFormedEvents(prompt.user);
		}
	});

	it("leaves out an event that cannot fit and marks the omission once", () => {
		const event: ToolEvent = {
			toolName: "read",
			toolInput: { path: "a.ts" },
			toolOutput: "x".repeat(4_000),
			toolError: null,
			timestamp: null,
			// The fixed markup alone is larger than the event's share.
			cwd: `/${"deep/".repeat(400)}`,
		};
		const prompt = buildObserverPrompt(exampleBatch({ toolEvents: [event] }), {
			outputMode: "legacy_xml",
			maxChars: 12_000,
		});

		expect(prompt.user).not.toContain("<what_happened>");
		expect(prompt.user.match(/\[\.\.\.\]/g)?.length).toBeGreaterThanOrEqual(1);
		expect(sentLengths(exampleBatch({ toolEvents: [event] }), 12_000).tool_events).toBe(5);
	});

	it("keeps every emitted event well formed in a batch far over budget", () => {
		const events = Array.from({ length: 30 }, (_, index) => ({
			...toolEvent(index, index % 3 === 0 ? "edit" : "read", 3_000),
			toolInput: { path: `f${index}.ts`, text: '<tag attr="v">&</tag>'.repeat(100) },
		}));
		for (const maxChars of [12_000, 24_000, 48_000]) {
			const prompt = buildObserverPrompt(exampleBatch({ toolEvents: events }), {
				outputMode: "legacy_xml",
				maxChars,
			});

			const emitted = expectWellFormedEvents(prompt.user);
			expect(emitted.length).toBeGreaterThan(0);
			for (const block of emitted) expect(block.length).toBeGreaterThanOrEqual(300);
		}
	});
});
