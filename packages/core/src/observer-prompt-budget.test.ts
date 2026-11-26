import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractionReplayObserverIdentity } from "./extraction-replay.js";
import { buildObserverPrompt, buildObserverRepairPrompt } from "./ingest-prompts.js";
import type { ObserverContext } from "./ingest-types.js";
import { loadObserverConfig, ObserverClient } from "./observer-client.js";
import {
	budgetObserverPrompts,
	DEFAULT_OBSERVER_MAX_CHARS,
	observerContentBudget,
} from "./observer-prompt-budget.js";

const generate = vi.hoisted(() => vi.fn());
vi.mock("./opencode-v2-generation.js", async (importActual) => ({
	...(await importActual<typeof import("./opencode-v2-generation.js")>()),
	generateWithOpenCodeV2: generate,
}));

/** The summary rule near the end of the legacy XML instructions that a prefix cut removed. */
const SKIP_SUMMARY_RULE =
	'If nothing meaningful happened, emit <skip_summary reason="low-signal"/>';

function systemPrompt(options: {
	includeSummary: boolean;
	outputMode: "legacy_xml" | "json_schema";
}) {
	const context = {
		project: null,
		userPrompt: "",
		promptNumber: null,
		transcript: "",
		toolEvents: [],
		lastAssistantMessage: null,
		includeSummary: options.includeSummary,
		diffSummary: "",
		recentFiles: "",
	} as unknown as ObserverContext;
	return buildObserverPrompt(context, { outputMode: options.outputMode }).system;
}

/** The clip before this change: a prefix of the instructions and a 25 percent content floor. */
function previousClip(system: string, user: string, maxChars: number) {
	const minUserBudget = Math.floor(maxChars * 0.25);
	const clippedSystem = system.slice(0, Math.max(0, maxChars - minUserBudget));
	const userBudget = Math.max(minUserBudget, maxChars - clippedSystem.length);
	return { system: clippedSystem, user: user.slice(0, userBudget) };
}

describe("observer prompt budget", () => {
	it("keeps the full summary XML instructions that the default budget used to cut", () => {
		const system = systemPrompt({ includeSummary: true, outputMode: "legacy_xml" });
		const content = "c".repeat(12_000);
		expect(system.length).toBeGreaterThan(9_000);
		expect(previousClip(system, content, 12_000).system).not.toContain(SKIP_SUMMARY_RULE);

		const sent = budgetObserverPrompts(system, content, DEFAULT_OBSERVER_MAX_CHARS);

		expect(sent.system).toBe(system);
		expect(sent.system).toContain(SKIP_SUMMARY_RULE);
		// The instructions leave less than the floor, so content keeps a quarter of the budget.
		expect(sent.user).toHaveLength(3_000);
		expect(sent.budget).toEqual({
			maxChars: 12_000,
			instructionChars: system.length,
			contentBudgetChars: 3_000,
			contentChars: 12_000,
			sentContentChars: 3_000,
			contentClipped: true,
			instructionsOverBudget: false,
		});
	});

	it.each([
		["summary JSON", { includeSummary: true, outputMode: "json_schema" }],
		["observations-only XML", { includeSummary: false, outputMode: "legacy_xml" }],
		["observations-only JSON", { includeSummary: false, outputMode: "json_schema" }],
	] as const)(
		"sends the same %s prompt as before at budgets that never cut it",
		(_name, options) => {
			const system = systemPrompt(options);
			const content = "c".repeat(60_000);
			for (const maxChars of [12_000, 24_000, 48_000]) {
				const sent = budgetObserverPrompts(system, content, maxChars);

				expect({ system: sent.system, user: sent.user }).toEqual(
					previousClip(system, content, maxChars),
				);
				expect(sent.budget.contentBudgetChars).toBe(maxChars - system.length);
			}
		},
	);

	it("clips a batch larger than any budget to what the instructions leave", () => {
		const system = systemPrompt({ includeSummary: true, outputMode: "legacy_xml" });
		const content = "c".repeat(200_000);

		const sent = budgetObserverPrompts(system, content, 48_000);

		expect(sent.system).toBe(system);
		expect(sent.user).toHaveLength(48_000 - system.length);
		expect(sent.system.length + sent.user.length).toBe(48_000);
		expect(sent.budget.contentClipped).toBe(true);
	});

	it("leaves content under the budget unchanged", () => {
		const sent = budgetObserverPrompts("instructions", "content", 12_000);

		expect(sent.user).toBe("content");
		expect(sent.budget).toMatchObject({ contentClipped: false, sentContentChars: 7 });
	});

	it("gives repair prompts the same content budget as the observer", () => {
		const system = systemPrompt({ includeSummary: true, outputMode: "legacy_xml" });

		const repair = buildObserverRepairPrompt(system, "u".repeat(20_000), "x".repeat(20_000));
		const sent = budgetObserverPrompts(repair.system, repair.user, DEFAULT_OBSERVER_MAX_CHARS);

		expect(repair.system.endsWith(system)).toBe(true);
		expect(repair.user.length).toBeLessThanOrEqual(
			observerContentBudget(DEFAULT_OBSERVER_MAX_CHARS, repair.system.length),
		);
		expect(sent.system).toBe(repair.system);
		expect(sent.budget.contentClipped).toBe(false);
	});

	it("is the default observer_max_chars", () => {
		expect(loadObserverConfig({}).observerMaxChars).toBe(DEFAULT_OBSERVER_MAX_CHARS);
	});
});

describe("observer prompt budget reporting", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "codemem-prompt-budget-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
		vi.stubEnv("CODEMEM_OBSERVER_MAX_CHARS", undefined);
		generate.mockResolvedValue({ text: "{}", error: null });
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		generate.mockReset();
		rmSync(home, { recursive: true, force: true });
	});

	function serviceObserver(maxChars: number) {
		return new ObserverClient(
			loadObserverConfig({
				observer_runtime: "opencode_v2",
				observer_provider: "openai",
				observer_model: "gpt-5.6",
				observer_max_chars: maxChars,
			}),
		);
	}

	it("sends instructions longer than the budget in full and reports it once in the log", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const observer = serviceObserver(1_000);
		const instructions = "i".repeat(2_000);

		await observer.observe(instructions, "c".repeat(5_000));
		await observer.observe(instructions, "c".repeat(5_000));

		expect(generate.mock.calls[0]?.[0].prompt).toBe(`${instructions}\n\n${"c".repeat(250)}`);
		expect(observer.getStatus().promptBudget).toMatchObject({
			maxChars: 1_000,
			instructionChars: 2_000,
			instructionsOverBudget: true,
		});
		const budgetWarnings = warn.mock.calls.filter(([message]) =>
			String(message).includes("observer_max_chars"),
		);
		expect(budgetWarnings).toHaveLength(1);
		expect(String(budgetWarnings[0]?.[0])).toContain("2000 characters");
	});

	it("reports the last call's lengths in observer status and replay metadata", async () => {
		const observer = serviceObserver(12_000);
		expect(observer.getStatus().promptBudget).toBeNull();

		await observer.observe("i".repeat(10_000), "c".repeat(8_000));

		const expected = {
			maxChars: 12_000,
			instructionChars: 10_000,
			contentBudgetChars: 3_000,
			contentChars: 8_000,
			sentContentChars: 3_000,
			contentClipped: true,
			instructionsOverBudget: false,
		};
		expect(observer.getStatus().promptBudget).toEqual(expected);
		expect(extractionReplayObserverIdentity(observer, null).promptBudget).toEqual(expected);
	});
});
