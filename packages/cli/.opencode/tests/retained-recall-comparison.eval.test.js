import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CodememPlugin, __testUtils } from "../plugins/codemem.js";
import { RETAINED_RECALL_EVAL_FIXTURES as fixtures } from "./retained-recall-comparison.eval-fixtures.js";

const pluginRegistrationsKey = Symbol.for("codemem.opencode-plugin.registrations");
const originalEnv = { ...process.env };
const shouldReportComparisons = originalEnv.CODEMEM_RECALL_EVAL_REPORT === "1";
const temporaryDirectories = [];

const jsonResponse = (status, body) => ({
	ok: status >= 200 && status < 300,
	status,
	json: vi.fn().mockResolvedValue(body),
});

const userMessage = (id, text, sessionID) => ({
	info: { id, sessionID, role: "user" },
	parts: [{ id: `${id}-text`, sessionID, messageID: id, type: "text", text }],
});

const packItemKeys = (pack) =>
	pack.rendered_items.map((item) => `${item.id}:${item.fingerprint}`);

const countDuplicates = (deliveredKeys) => {
	const seen = new Set();
	let duplicates = 0;
	for (const key of deliveredKeys) {
		if (seen.has(key)) duplicates += 1;
		seen.add(key);
	}
	return duplicates;
};

const selectRetainedEntries = (entries, retain) => {
	if (!Array.isArray(retain)) return [...entries];
	const retained = new Set(retain);
	return entries.filter((entry) => retained.has(entry.info.id));
};

const stripRecallMetadata = (entries) => {
	for (const entry of entries) {
		for (const part of entry.parts || []) {
			if (__testUtils.isCodememContextPart(part)) delete part.metadata;
		}
	}
};

const coverage = (messages, markers) => {
	const text = JSON.stringify(messages);
	const misses = markers.filter((marker) => !text.includes(marker));
	return { present: markers.length - misses.length, total: markers.length, misses };
};

const summarizeRun = ({ messages, measurements, deliveredKeys, expectedFinalMarkers, expectedNewMarkers }) => ({
	totalNewEstimatedTokens: measurements.reduce((sum, item) => sum + item.new_tokens, 0),
	finalNewEstimatedTokens: measurements.at(-1)?.new_tokens || 0,
	finalRetainedEstimatedTokens: measurements.at(-1)?.retained_tokens || 0,
	duplicateDeliveries: countDuplicates(deliveredKeys),
	duplicatesOmitted: measurements.reduce((sum, item) => sum + item.duplicates_omitted, 0),
	reasons: measurements.map((item) => item.reason),
	expectedRelevantCoverage: coverage(messages, expectedFinalMarkers),
	expectedNewFactCoverage: coverage(messages, expectedNewMarkers),
});

const runStageOneBaseline = (scenario) => {
	const sessionID = `baseline-${scenario.id}`;
	let entries = [];
	const measurements = [];
	const deliveredKeys = [];
	let pendingCompactionSkip = false;

	for (const step of scenario.steps) {
		if (step.type === "restart") {
			if (step.stripRecallMetadata) stripRecallMetadata(entries);
			continue;
		}
		entries = selectRetainedEntries(entries, step.retain);
		const entry = userMessage(step.id, step.text, sessionID);
		entries.push(entry);
		if (step.compactionTransform) pendingCompactionSkip = true;
		let newTokens = 0;
		let reason = "delivered";
		if (pendingCompactionSkip) {
			pendingCompactionSkip = false;
			reason = "compaction_skipped";
		} else {
			const pack = fixtures.packs[step.pack];
			const text = __testUtils.wrapInjectedContext(pack.pack_text);
			entry.parts.push({
				id: `codemem-context-${step.id}`,
				sessionID,
				messageID: step.id,
				type: "text",
				text,
				synthetic: true,
			});
			newTokens = __testUtils.estimateTokens(text);
			deliveredKeys.push(...packItemKeys(pack));
		}
		measurements.push({
			new_tokens: newTokens,
			retained_tokens: __testUtils.countRetainedInjectionTokens(entries),
			duplicates_omitted: 0,
			reason,
		});
	}

	return summarizeRun({
		messages: entries,
		measurements,
		deliveredKeys,
		expectedFinalMarkers: scenario.expectedFinalMarkers,
		expectedNewMarkers: scenario.expectedNewMarkers,
	});
};

const profileResponse = (cwd) => jsonResponse(200, {
	service: "codemem-viewer",
	protocol_version: 1,
	min_supported_protocol_version: 1,
	db_path: resolve(process.env.CODEMEM_DB),
	identity_target: __testUtils.buildViewerIdentityTarget(process.env, cwd),
});

const fitPackToRequestedBudget = (pack, requestBody) => {
	if (__testUtils.estimateTokens(pack.pack_text) <= requestBody.token_budget) return pack;
	return {
		pack_text: "",
		rendered_items: [],
		metrics: { total_items: 0, pack_tokens: 0 },
	};
};

const readMeasurements = (logPath) => readFileSync(logPath, "utf8")
	.split("\n")
	.filter((line) => line.includes("inject.recall "))
	.map((line) => JSON.parse(line.split("inject.recall ")[1]));

const createActualHarness = async (scenario) => {
	const cwd = "/tmp/codemem-retained-recall-eval";
	const sessionID = `actual-${scenario.id}`;
	const logPath = join(process.env.HOME, `${scenario.id}.log`);
	process.env.CODEMEM_PLUGIN_LOG = logPath;
	let activePack = null;
	const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options = {}) => {
		if (String(url).endsWith("/api/prompt-pack-profile")) return profileResponse(cwd);
		if (String(url).endsWith("/api/pack")) {
			const requestBody = JSON.parse(options.body);
			return jsonResponse(200, fitPackToRequestedBudget(fixtures.packs[activePack], requestBody));
		}
		if (String(url).endsWith("/api/prompt-pack-ledger")) return jsonResponse(200, { ok: true });
		throw new Error(`unexpected offline eval request: ${String(url)}`);
	});
	const init = {
		project: { name: "retained-recall-eval" },
		client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
		directory: cwd,
		worktree: cwd,
	};
	let hooks = await CodememPlugin(init);
	let entries = [];
	const deliveredKeys = [];
	const falseSkipCandidates = [];

	for (const step of scenario.steps) {
		if (step.type === "restart") {
			if (step.stripRecallMetadata) stripRecallMetadata(entries);
			hooks.dispose();
			hooks = await CodememPlugin(init);
			continue;
		}
		entries = selectRetainedEntries(entries, step.retain);
		const entry = userMessage(step.id, step.text, sessionID);
		entries.push(entry);
		activePack = step.pack;
		if (step.compactionTransform) {
			await hooks["experimental.session.compacting"]({ sessionID }, { context: [] });
		}
		const beforeText = JSON.stringify(entries.slice(0, -1));
		await hooks["experimental.chat.messages.transform"]({}, { messages: entries });
		const injectedPart = entry.parts.find(__testUtils.isCodememContextPart);
		if (injectedPart?.metadata?.codemem?.items) {
			deliveredKeys.push(
				...injectedPart.metadata.codemem.items.map((item) => `${item.id}:${item.fingerprint}`),
			);
		}
		falseSkipCandidates.push({
			requiresNewMarkers: step.requiresNewMarkers || [],
			wereAlreadyPresent: (step.requiresNewMarkers || []).every((marker) => beforeText.includes(marker)),
		});
		// Measurement logging is fire-and-forget; flush each turn before starting the next.
		await vi.waitFor(() => expect(readMeasurements(logPath)).toHaveLength(falseSkipCandidates.length));
	}

	const expectedMeasurementCount = scenario.steps.filter((step) => step.type === "prompt").length;
	await vi.waitFor(() => expect(readMeasurements(logPath)).toHaveLength(expectedMeasurementCount));
	const measurements = readMeasurements(logPath);
	const falseSkips = measurements.filter((measurement, index) => {
		const candidate = falseSkipCandidates[index];
		const policySkip = ["continuation_only", "unchanged_memories"].includes(measurement.reason);
		return policySkip && candidate.requiresNewMarkers.length > 0 && !candidate.wereAlreadyPresent;
	}).length;
	hooks.dispose();
	expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("http://127.0.0.1:"))).toBe(true);

	return {
		...summarizeRun({
			messages: entries,
			measurements,
			deliveredKeys,
			expectedFinalMarkers: scenario.expectedFinalMarkers,
			expectedNewMarkers: scenario.expectedNewMarkers,
		}),
		falseSkips,
	};
};

const reportComparison = (scenarioId, report) => {
	if (!shouldReportComparisons) return;
	process.stdout.write(`${JSON.stringify({
		scenarioId,
		baseline: report.baseline,
		actual: report.actual,
		interpretation: {
			baselineArm: "simulated-stage1-model, not the pre-change plugin",
			candidateTransport: "mocked whole-pack fit, not core item trimming",
			falseSkipsDefinition: "continuation_only or unchanged_memories suppressed a required new marker; hard-ceiling policy misses are excluded",
			hardCeilingPolicyMisses: scenarioId === "ceiling-pressure"
				? report.actual.expectedRelevantCoverage.misses
				: [],
			restartMissingMetadataDuplicateDeliveryIsDeliberate:
				scenarioId === "restart-missing-metadata",
		},
	})}\n`);
};

const runComparison = async (scenarioId) => {
	const scenario = fixtures.scenarios.find((candidate) => candidate.id === scenarioId);
	if (!scenario) throw new Error(`missing eval scenario: ${scenarioId}`);
	if (scenario.retainedBudgetFromPack) {
		const pack = fixtures.packs[scenario.retainedBudgetFromPack];
		process.env.CODEMEM_INJECT_RETAINED_TOKEN_BUDGET = String(
			__testUtils.estimateTokens(__testUtils.wrapInjectedContext(pack.pack_text)) + 1,
		);
	}
	const report = {
		label: fixtures.label,
		workloadKind: fixtures.workload_kind,
		baseline: runStageOneBaseline(scenario),
		actual: await createActualHarness(scenario),
	};
	reportComparison(scenarioId, report);
	return report;
};

describe("offline retained-recall comparative eval", () => {
	beforeEach(() => {
		Reflect.deleteProperty(globalThis, pluginRegistrationsKey);
		const home = mkdtempSync(join(tmpdir(), "codemem-retained-eval-"));
		temporaryDirectories.push(home);
		process.env = {
			...originalEnv,
			HOME: home,
			CODEMEM_DB: join(home, "offline.sqlite"),
			CODEMEM_VIEWER: "1",
			CODEMEM_VIEWER_AUTO: "0",
			CODEMEM_RAW_EVENTS: "0",
			CODEMEM_PLUGIN_DEBUG: "0",
			CODEMEM_PLUGIN_LOG: join(home, "eval.log"),
			CODEMEM_INJECT_CONTEXT: "1",
			CODEMEM_INJECT_TOKEN_BUDGET: "800",
			CODEMEM_INJECT_RETAINED_TOKEN_BUDGET: "8000",
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
		Reflect.deleteProperty(globalThis, pluginRegistrationsKey);
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
		process.env = originalEnv;
	});

	test("reduces duplicate delivery across repetitive follow-ups without losing the relevant fact", async () => {
		// Arrange
		const scenarioId = "repetitive-followups";

		// Act
		const report = await runComparison(scenarioId);

		// Assert
		expect(report).toMatchObject({
			label: "constructed-retained-recall-v1",
			workloadKind: "constructed",
			baseline: { duplicateDeliveries: 2 },
			actual: {
				duplicateDeliveries: 0,
				duplicatesOmitted: 2,
				falseSkips: 0,
				expectedRelevantCoverage: { present: 1, total: 1, misses: [] },
			},
		});
		expect(report.actual.totalNewEstimatedTokens).toBeLessThan(report.baseline.totalNewEstimatedTokens);
	});

	test("delivers a changed fact on continuation and keeps explicit unchanged recall eligible for dedup", async () => {
		// Arrange
		const scenarioId = "changed-fact-and-explicit-recall";

		// Act
		const report = await runComparison(scenarioId);

		// Assert
		expect(report.actual).toMatchObject({
			duplicateDeliveries: 0,
			duplicatesOmitted: 1,
			falseSkips: 0,
			reasons: ["delivered", "delivered", "unchanged_memories"],
			expectedNewFactCoverage: { present: 1, total: 1, misses: [] },
		});
		expect(report.baseline.duplicateDeliveries).toBe(1);
	});

	test("bounds retained tokens under ceiling pressure and records the policy-limited miss", async () => {
		// Arrange
		const scenarioId = "ceiling-pressure";

		// Act
		const report = await runComparison(scenarioId);

		// Assert
		expect(report.actual.finalRetainedEstimatedTokens).toBeLessThanOrEqual(8000);
		expect(report.actual.expectedRelevantCoverage).toMatchObject({ present: 11, total: 12 });
		expect(report.actual.expectedRelevantCoverage.misses).toEqual(["CEILING_FACT_12"]);
		expect(report.actual.falseSkips).toBe(0);
		expect(report.baseline.expectedRelevantCoverage).toMatchObject({ present: 12, total: 12, misses: [] });
		expect(report.baseline.finalRetainedEstimatedTokens).toBeGreaterThan(8000);
	});

	test("does not reclaim on compaction notification but injects after ordinary history proves removal", async () => {
		// Arrange
		const scenarioId = "compaction-evidence";

		// Act
		const report = await runComparison(scenarioId);

		// Assert
		expect(report.actual).toMatchObject({
			reasons: ["delivered", "compaction_skipped", "allowance_exhausted", "delivered"],
			falseSkips: 0,
			expectedNewFactCoverage: { present: 1, total: 1, misses: [] },
		});
		expect(report.actual.finalNewEstimatedTokens).toBeGreaterThan(0);
	});

	test("keeps restart candidates eligible when retained blocks lack fingerprint metadata", async () => {
		// Arrange
		const scenarioId = "restart-missing-metadata";

		// Act
		const report = await runComparison(scenarioId);

		// Assert
		expect(report.actual).toMatchObject({
			duplicateDeliveries: 1,
			duplicatesOmitted: 0,
			falseSkips: 0,
			reasons: ["delivered", "delivered"],
			expectedRelevantCoverage: { present: 1, total: 1, misses: [] },
		});
		expect(report.actual.totalNewEstimatedTokens).toBe(report.baseline.totalNewEstimatedTokens);
	});
});
