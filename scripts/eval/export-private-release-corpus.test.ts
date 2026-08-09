import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getExtractionBenchmarkProfile,
	type ExtractionBenchmarkProfile,
} from "../../packages/core/src/extraction-benchmarks.js";
import type { ExtractionReplayProjection } from "../../packages/core/src/extraction-replay.js";
import type { ObserverConfig } from "../../packages/core/src/observer-client.js";
import { compareCodePoints, digestCorpus, project, serialize } from "./release/canonical.js";
import { parseProjectedCorpusJson } from "./release/corpus.js";
import { parseReleaseEvalManifest } from "./release/manifest.js";
import { adaptProjectedObserverCases } from "./release/observer-runner.js";
import { preflightReleaseEval } from "./release/orchestrator.js";
import type { JsonValue } from "./release/types.js";
import {
	buildPrivateReleaseManifest,
	digestReviewedProfile,
	effectiveEvaluatorConfiguration,
	exportPrivateReleaseCorpus,
	parsePrivateCorpusExportArgs,
	syntheticPublicInjectionCorpus,
} from "./export-private-release-corpus.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const COMMIT = "a".repeat(40);
const PRIVATE_MARKER = "private-source-marker";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function externalRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "codemem-private-export-test-"));
	roots.push(root);
	return root;
}

function config(overrides: Partial<ObserverConfig> = {}): ObserverConfig {
	return {
		observerProvider: "openai",
		observerModel: "gpt-test",
		observerRuntime: "api_http",
		observerApiKey: null,
		observerBaseUrl: null,
		observerTemperature: 0.2,
		observerTierRoutingEnabled: false,
		observerOpenAIUseResponses: true,
		observerReasoningEffort: "medium",
		observerReasoningSummary: "auto",
		observerMaxOutputTokens: 4096,
		observerMaxChars: 12_000,
		observerMaxTokens: 4_000,
		observerHeaders: {},
		observerAuthSource: "auto",
		observerAuthFile: null,
		observerAuthCommand: [],
		observerAuthTimeoutMs: 1_500,
		observerAuthCacheTtlS: 300,
		...overrides,
	};
}

function projection(batchId: number, sessionId: number): ExtractionReplayProjection {
	return {
		analysis: { batchId, sessionId },
		observerContext: {
			project: PRIVATE_MARKER,
			userPrompt: `${PRIVATE_MARKER} reviewed prompt ${batchId}`,
			promptNumber: 1,
			transcript: `${PRIVATE_MARKER} transcript ${batchId}`,
			toolEvents: [
				{
					toolName: "read",
					toolInput: { path: "/private/source/path" },
					toolOutput: "private tool output",
					toolError: null,
					timestamp: null,
					cwd: "/private/source",
				},
			],
			lastAssistantMessage: null,
			includeSummary: true,
			diffSummary: "",
			recentFiles: "/private/source/file.ts",
		},
	};
}

function dependencies(profileOverride?: ExtractionBenchmarkProfile) {
	const profile = profileOverride ?? getExtractionBenchmarkProfile("balanced-observer-quality-v1");
	if (!profile) throw new Error("expected balanced profile");
	const sessions = new Map(profile.batches.map((batch) => [batch.batchId, batch.sessionId]));
	return {
		getProfile: () => profile,
		projectBatch: async (_dbPath: string, opts: { batchId: number }) => {
			const sessionId = sessions.get(opts.batchId);
			if (sessionId == null) throw new Error(`Flush batch ${opts.batchId} not found`);
			return projection(opts.batchId, sessionId);
		},
		loadConfig: () => config(),
		resolveCommit: async () => COMMIT,
		readEvaluatorStatus: async () => "",
	};
}

async function exported(directory: string, overrides = dependencies()): Promise<void> {
	await exportPrivateReleaseCorpus(
		{
			dbPath: "/not-opened/private.sqlite",
			outputDirectory: directory,
			candidateVersion: "0.40.0",
			repositoryRoot: REPOSITORY_ROOT,
		},
		overrides,
	);
}

async function outputFiles(directory: string): Promise<Record<string, string>> {
	const names = [
		"private-corpus.json",
		"private-retrieval-corpus.json",
		"public-injection-corpus.json",
		"private-release-manifest.json",
		"export-metadata.json",
	];
	return Object.fromEntries(
		await Promise.all(names.map(async (name) => [name, await readFile(join(directory, name), "utf8")])),
	);
}

describe("private release-corpus export", () => {
	it("is canonical and byte-repeatable across reordered reviewed profile input", async () => {
		const root = await externalRoot();
		const profile = getExtractionBenchmarkProfile("balanced-observer-quality-v1");
		if (!profile) throw new Error("expected profile");
		const reordered = structuredClone(profile);
		reordered.batches.reverse();
		await exported(join(root, "first"), dependencies(profile));
		await exported(join(root, "second"), dependencies(reordered));

		expect(await outputFiles(join(root, "first"))).toEqual(await outputFiles(join(root, "second")));
		expect((await lstat(join(root, "first"))).mode & 0o777).toBe(0o700);
		const source = await readFile(join(root, "first", "private-corpus.json"), "utf8");
		const corpus = parseProjectedCorpusJson(source);
		expect(source).toBe(`${serialize(project(corpus) as unknown as JsonValue)}\n`);
		expect(digestCorpus(corpus)).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("uses deterministic code-point ordering for non-ASCII reviewed labels", async () => {
		const root = await externalRoot();
		const profile = getExtractionBenchmarkProfile("balanced-observer-quality-v1");
		if (!profile) throw new Error("expected profile");
		const first = structuredClone(profile);
		const batch = first.batches.find(
			(entry) => entry.review?.status === "reviewed" && entry.observationPolicy !== "zero",
		);
		if (!batch || batch.review?.status !== "reviewed") throw new Error("expected reviewed batch");
		for (const suffix of ["😀", "é", "z", "Å"]) {
			batch.review.labels.push({
				id: `unicode-${suffix}`,
				disposition: "optional",
				title: `Unicode ${suffix}`,
				keywordGroups: [[suffix]],
				reviewerNotes: "Unicode ordering fixture",
				sourceEvidence: "Unicode ordering fixture",
			});
		}
		const second = structuredClone(first);
		const secondBatch = second.batches.find((entry) => entry.batchId === batch.batchId);
		if (secondBatch?.review?.status !== "reviewed") throw new Error("expected cloned review");
		secondBatch.review.labels.reverse();
		await exported(join(root, "unicode-first"), dependencies(first));
		await exported(join(root, "unicode-second"), dependencies(second));
		expect(await outputFiles(join(root, "unicode-first"))).toEqual(
			await outputFiles(join(root, "unicode-second")),
		);
		const corpus = parseProjectedCorpusJson(
			await readFile(join(root, "unicode-first", "private-corpus.json"), "utf8"),
		);
		const observerCase = adaptProjectedObserverCases(corpus).find((entry) =>
			entry.context.userPrompt.includes(String(batch.batchId)),
		);
		expect(
			observerCase?.review.labels
				.filter((label) => label.id.startsWith("unicode-"))
				.map((label) => label.id),
		).toEqual(["unicode-z", "unicode-Å", "unicode-é", "unicode-😀"]);
	});

	it("exports only stable content-derived case IDs from reviewed batches", async () => {
		const root = await externalRoot();
		const output = join(root, "stable-ids");
		await exported(output);
		const corpus = parseProjectedCorpusJson(await readFile(join(output, "private-corpus.json"), "utf8"));
		expect(corpus.rows.filter((row) => row.row_type === "observer_case")).toHaveLength(19);
		expect(corpus.rows.every((row) => /^(case|probe)-[a-f0-9]{24}$/.test(row.case_id))).toBe(true);
	});

	it("preserves exact reviewed labels and validates observer cases", async () => {
		const root = await externalRoot();
		const output = join(root, "reviews");
		await exported(output);
		const corpus = parseProjectedCorpusJson(await readFile(join(output, "private-corpus.json"), "utf8"));
		const observerCorpus = {
			schema_version: 1 as const,
			rows: corpus.rows.filter((row) => row.row_type === "observer_case"),
		};
		const cases = adaptProjectedObserverCases(observerCorpus);
		const profile = getExtractionBenchmarkProfile("balanced-observer-quality-v1");
		if (!profile) throw new Error("expected profile");
		const expected = profile.batches
			.toSorted((left, right) => left.batchId - right.batchId)
			.map((batch) => {
				const review = batch.review;
				if (review?.status !== "reviewed") return review;
				return {
					...review,
					labels: (["required", "optional", "forbidden"] as const).flatMap((disposition) =>
						review.labels
							.filter((label) => label.disposition === disposition)
							.toSorted((a, b) => compareCodePoints(a.id, b.id)),
					),
				};
			});
		expect(cases.map((entry) => entry.review)).toEqual(expected);
	});

	it("preserves the reviewed 18476 robustness label and historical recap probes", async () => {
		const root = await externalRoot();
		const output = join(root, "historical-contracts");
		await exported(output);
		const profile = getExtractionBenchmarkProfile("balanced-observer-quality-v1");
		if (!profile) throw new Error("expected profile");
		const robustness = profile.batches.find((batch) => batch.batchId === 18476);
		expect(robustness?.label).toBe("Replay no-output robustness case");
		const observerCorpus = parseProjectedCorpusJson(
			await readFile(join(output, "private-corpus.json"), "utf8"),
		);
		const robustnessCase = adaptProjectedObserverCases(observerCorpus).find((entry) =>
			entry.context.userPrompt.includes("18476"),
		);
		expect(robustnessCase?.review).toEqual(robustness?.review);
		const retrievalCorpus = parseProjectedCorpusJson(
			await readFile(join(output, "private-retrieval-corpus.json"), "utf8"),
		);
		const recapRows = retrievalCorpus.rows.filter(
			(row) => (row.value as { explicit_recap?: unknown }).explicit_recap === true,
		);
		expect(recapRows.length).toBeGreaterThan(0);
		for (const row of recapRows) {
			expect(row.value).toMatchObject({
				query: expect.stringMatching(/^recap private-source-marker reviewed prompt /),
				expected_mode: "recall",
				expected_artifact: "session_summary",
				explicit_recap: true,
				top_n: 5,
			});
		}
	});

	it("rejects unreviewed, duplicate, incomplete, contradictory, missing, and mismatched records", async () => {
		const root = await externalRoot();
		const profile = getExtractionBenchmarkProfile("balanced-observer-quality-v1");
		if (!profile) throw new Error("expected profile");

		const unreviewed = structuredClone(profile);
		unreviewed.batches[0]!.review = { status: "unreviewed", reviewerNotes: "pending" };
		await expect(exported(join(root, "unreviewed"), dependencies(unreviewed))).rejects.toThrow(
			"missing reviewed labels",
		);

		const duplicate = structuredClone(profile);
		duplicate.batches[1]!.batchId = duplicate.batches[0]!.batchId;
		await expect(exported(join(root, "duplicate"), dependencies(duplicate))).rejects.toThrow(
			"batch IDs must be unique",
		);
		const duplicateLabels = structuredClone(profile);
		const labeledBatch = duplicateLabels.batches.find(
			(batch) => batch.review?.status === "reviewed" && batch.review.labels.length > 0,
		);
		if (labeledBatch?.review?.status !== "reviewed") throw new Error("expected labeled batch");
		labeledBatch.review.labels.push(structuredClone(labeledBatch.review.labels[0]!));
		await expect(
			exported(join(root, "duplicate-labels"), dependencies(duplicateLabels)),
		).rejects.toThrow("reviewed label IDs");

		const incomplete = structuredClone(profile);
		incomplete.batches.pop();
		await expect(exported(join(root, "incomplete"), dependencies(incomplete))).rejects.toThrow(
			"18 shape cases and one robustness case",
		);

		const contradictory = structuredClone(profile);
		const zeroBatch = contradictory.batches.find((batch) => batch.observationPolicy === "zero");
		if (!zeroBatch || zeroBatch.review?.status !== "reviewed") throw new Error("expected zero batch");
		zeroBatch.review.labels.push({
			id: "contradiction",
			disposition: "required",
			title: "Contradictory output",
			keywordGroups: [["contradictory"]],
			reviewerNotes: "test",
			sourceEvidence: "test",
		});
		await expect(exported(join(root, "contradictory"), dependencies(contradictory))).rejects.toThrow(
			"must not define required durable labels",
		);

		const missing = dependencies();
		missing.projectBatch = async () => {
			throw new Error("Flush batch missing");
		};
		const missingOutput = join(root, "missing");
		await expect(exported(missingOutput, missing)).rejects.toThrow("Flush batch missing");
		expect(await lstat(missingOutput).catch(() => null)).toBeNull();

		const mismatch = dependencies();
		mismatch.projectBatch = async (_dbPath, opts) => projection(opts.batchId, -1);
		const mismatchOutput = join(root, "mismatch");
		await expect(exported(mismatchOutput, mismatch)).rejects.toThrow(
			"Projected session mismatch",
		);
		expect(await lstat(mismatchOutput).catch(() => null)).toBeNull();
	});

	it("requires a new final directory beneath an existing external real parent", async () => {
		await expect(exported("relative/private-export")).rejects.toThrow("explicit absolute path");
		await expect(exported(join(REPOSITORY_ROOT, ".tmp", "private-export-rejected"))).rejects.toThrow(
			"outside the repository",
		);
		const root = await externalRoot();
		await expect(exported(join(root, "missing-parent", "output"))).rejects.toThrow(
			"parent must already exist",
		);
		const externalTarget = join(root, "external-target");
		await mkdir(externalTarget);
		const linked = join(root, "linked-final");
		await symlink(externalTarget, linked, "dir");
		await expect(exported(linked)).rejects.toThrow("new path");
		const intermediate = join(root, "intermediate");
		await symlink(externalTarget, intermediate, "dir");
		await expect(exported(join(intermediate, "output"))).rejects.toThrow(
			"intermediate symbolic links",
		);
		const file = join(root, "file");
		await writeFile(file, "not a directory", "utf8");
		await expect(exported(file)).rejects.toThrow("new path");
		const nonempty = join(root, "nonempty");
		await mkdir(nonempty);
		await writeFile(join(nonempty, "keep.txt"), "occupied", "utf8");
		await expect(exported(nonempty)).rejects.toThrow("new path");
		expect(await readFile(join(nonempty, "keep.txt"), "utf8")).toBe("occupied");
	});

	it("fails closed if the output directory is replaced during projection", async () => {
		const root = await externalRoot();
		const output = join(root, "swapped");
		const redirect = join(root, "redirect");
		await mkdir(redirect);
		const deps = dependencies();
		const projectBatch = deps.projectBatch;
		let swapped = false;
		deps.projectBatch = async (dbPath, opts) => {
			if (!swapped) {
				swapped = true;
				await rm(output, { recursive: true });
				await symlink(redirect, output, "dir");
			}
			return projectBatch(dbPath, opts);
		};

		await expect(exported(output, deps)).rejects.toThrow("became unsafe");
		expect(await readFile(join(redirect, "private-corpus.json"), "utf8").catch(() => null)).toBeNull();
	});

	it("fails closed if an intermediate parent is redirected during projection", async () => {
		const root = await externalRoot();
		const parent = join(root, "parent");
		const originalParent = join(root, "parent-original");
		const redirect = join(root, "redirect-parent");
		await mkdir(parent);
		await mkdir(redirect);
		const output = join(parent, "output");
		const deps = dependencies();
		const projectBatch = deps.projectBatch;
		let swapped = false;
		deps.projectBatch = async (dbPath, opts) => {
			if (!swapped) {
				swapped = true;
				await rename(parent, originalParent);
				await symlink(redirect, parent, "dir");
			}
			return projectBatch(dbPath, opts);
		};

		await expect(exported(output, deps)).rejects.toThrow("parent changed");
		expect(await readFile(join(redirect, "private-corpus.json"), "utf8").catch(() => null)).toBeNull();
	});

	it("validates candidate, configuration, and clean worktree before output or projection", async () => {
		const root = await externalRoot();
		let projections = 0;
		const deps = dependencies();
		deps.projectBatch = async (_dbPath, opts) => {
			projections += 1;
			return projection(opts.batchId, -1);
		};
		deps.readEvaluatorStatus = async () => " M scripts/eval/export-private-release-corpus.ts\n";
		const dirtyOutput = join(root, "dirty");
		await expect(exported(dirtyOutput, deps)).rejects.toThrow("worktree must be clean");
		expect(await lstat(dirtyOutput).catch(() => null)).toBeNull();
		expect(projections).toBe(0);

		const invalidVersionOutput = join(root, "invalid-version");
		await expect(
			exportPrivateReleaseCorpus(
				{
					dbPath: "/not-opened/private.sqlite",
					outputDirectory: invalidVersionOutput,
					candidateVersion: "not-semver",
					repositoryRoot: REPOSITORY_ROOT,
				},
				dependencies(),
			),
		).rejects.toThrow("semantic version");
		expect(await lstat(invalidVersionOutput).catch(() => null)).toBeNull();

		const invalidConfig = dependencies();
		invalidConfig.loadConfig = () => config({ observerRuntime: "invalid" });
		const invalidConfigOutput = join(root, "invalid-config");
		await expect(exported(invalidConfigOutput, invalidConfig)).rejects.toThrow(
			"Unsupported observer runtime",
		);
		expect(await lstat(invalidConfigOutput).catch(() => null)).toBeNull();

		const changed = dependencies();
		let statusChecks = 0;
		changed.readEvaluatorStatus = async () => {
			statusChecks += 1;
			return statusChecks === 1 ? "" : " M changed-after-projection\n";
		};
		const changedOutput = join(root, "changed");
		await expect(exported(changedOutput, changed)).rejects.toThrow("changed during export");
		expect(await lstat(changedOutput).catch(() => null)).toBeNull();
	});

	it("preserves the original write error while rolling back completed files", async () => {
		const root = await externalRoot();
		const output = join(root, "rollback");
		const original = new Error("injected second write failure");
		let calls = 0;
		const deps = {
			...dependencies(),
			writeOutputFile: async (
				identity: { path: string },
				name: string,
				contents: string,
			) => {
				calls += 1;
				if (calls === 2) throw original;
				await writeFile(join(identity.path, name), contents, { encoding: "utf8", flag: "wx" });
			},
		};

		await expect(exported(output, deps)).rejects.toBe(original);
		expect(await readFile(join(output, "private-corpus.json"), "utf8").catch(() => null)).toBeNull();
	});

	it("keeps private source text and local paths out of every public or provenance artifact", async () => {
		const root = await externalRoot();
		const output = join(root, "privacy");
		const deps = dependencies();
		deps.loadConfig = () =>
			config({
				observerApiKey: "private-api-key-value",
				observerBaseUrl: "https://private.example.invalid/v1",
				observerHeaders: { Authorization: "private-header-value" },
				observerAuthFile: "/private/home/auth.json",
				observerAuthCommand: ["private-auth-command", "--secret"],
			});
		await exported(output, deps);
		const files = await outputFiles(output);
		expect(files["private-corpus.json"]).toContain(PRIVATE_MARKER);
		const safeArtifacts = [
			files["public-injection-corpus.json"],
			files["private-release-manifest.json"],
			files["export-metadata.json"],
		].join("\n");
		for (const forbidden of [
			PRIVATE_MARKER,
			"private-api-key-value",
			"private.example.invalid",
			"private-header-value",
			"/private/",
			"private-auth-command",
			"Authorization",
			output,
			REPOSITORY_ROOT,
		]) {
			expect(safeArtifacts).not.toContain(forbidden);
		}
	});

	it("emits unbound sidecars and an observer-only manifest that passes PR1 preflight", async () => {
		const root = await externalRoot();
		const output = join(root, "public");
		await exported(output);
		const publicCorpus = parseProjectedCorpusJson(
			await readFile(join(output, "public-injection-corpus.json"), "utf8"),
		);
		expect(publicCorpus).toEqual(project(syntheticPublicInjectionCorpus()));
		expect(publicCorpus.rows).toHaveLength(9);
		expect(new Set(publicCorpus.rows.map((row) => row.row_type))).toEqual(new Set(["injection_case"]));
		const manifest = parseReleaseEvalManifest(
			JSON.parse(await readFile(join(output, "private-release-manifest.json"), "utf8")),
		);
		expect(manifest.corpora).toHaveLength(1);
		expect(manifest.corpora[0]).toMatchObject({ tier: "private", source_path: "private-corpus.json" });
		expect(manifest.subjects.at(-1)?.subject).toEqual({ kind: "candidate", version: "0.40.0" });
		expect(manifest.subjects.every((subject) => subject.components[0] === "observer")).toBe(true);
		const profile = getExtractionBenchmarkProfile("balanced-observer-quality-v1");
		if (!profile) throw new Error("expected profile");
		const metadata = JSON.parse(await readFile(join(output, "export-metadata.json"), "utf8")) as {
			reviewed_profile_digest?: unknown;
		};
		expect(metadata.reviewed_profile_digest).toBe(digestReviewedProfile(profile));
		const preflight = await preflightReleaseEval({
			repositoryRoot: REPOSITORY_ROOT,
			manifestPath: join(output, "private-release-manifest.json"),
			dependencies: {
				resolveEvaluatorCommit: async () => COMMIT,
				readEvaluatorStatus: async () => "",
				digestEvaluatorComponent: async () => `sha256:${"d".repeat(64)}`,
			},
		});
		expect(preflight.corpus.rows).toHaveLength(19);
		expect(new Set(preflight.corpus.rows.map((row) => row.row_type))).toEqual(
			new Set(["observer_case"]),
		);
	});
});

describe("private release export contracts", () => {
	it("allowlists only effective evaluator configuration", () => {
		expect(
			effectiveEvaluatorConfiguration(
				config({ observerApiKey: "secret", observerHeaders: { Authorization: "secret" } }),
			),
		).toEqual({
			provider: "openai",
			transport: "api_http",
			endpoint_mode: "provider_default",
			model: "gpt-test",
			temperature: 0.2,
			openai_responses: true,
			reasoning_effort: "medium",
			reasoning_summary: "auto",
			max_output_tokens: 4096,
			tier_routing_enabled: false,
		});
		expect(() => effectiveEvaluatorConfiguration(config({ observerRuntime: "unknown" }))).toThrow(
			"Unsupported observer runtime",
		);
	});

	it("pins candidate version, exact refs, digests, and repetitions", () => {
		const manifest = buildPrivateReleaseManifest({
			commit: COMMIT,
			candidateVersion: "0.40.0",
			configuration: effectiveEvaluatorConfiguration(config()),
			privateDigest: `sha256:${"b".repeat(64)}`,
		});
		expect(manifest.repetitions).toBe(3);
		expect(manifest.subjects.map((subject) => subject.requested_ref)).toEqual([
			"v0.37.1",
			"v0.38.0",
			"v0.39.0",
			COMMIT,
		]);
		expect(manifest.subjects.at(-1)?.subject).toEqual({ kind: "candidate", version: "0.40.0" });
	});

	it("parses pnpm separators and rejects removed overwrite behavior", () => {
		expect(
			parsePrivateCorpusExportArgs([
				"--",
				"--db",
				"/private/mem.sqlite",
				"--output-dir",
				"/private/release-corpus",
				"--candidate-version",
				"0.40.0",
			]),
		).toEqual({
			dbPath: "/private/mem.sqlite",
			outputDirectory: "/private/release-corpus",
			candidateVersion: "0.40.0",
		});
		expect(() => parsePrivateCorpusExportArgs(["--overwrite-existing-output"])).toThrow(
			"Unknown argument",
		);
	});
});
