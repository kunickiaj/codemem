import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	getExtractionBenchmarkProfile,
	type ExtractionBenchmarkLabel,
	type ExtractionBenchmarkProfile,
} from "../../packages/core/src/extraction-benchmarks.js";
import {
	projectReplayBatch,
	type ExtractionReplayProjection,
} from "../../packages/core/src/extraction-replay.js";
import type { ObserverContext, ToolEvent } from "../../packages/core/src/ingest-types.js";
import { loadObserverConfig, type ObserverConfig } from "../../packages/core/src/observer-client.js";
import { compareCodePoints, digest, digestCorpus, project, serialize } from "./release/canonical.js";
import { jsonValue } from "./release/json-shape.js";
import { executeCommand } from "./release/historical-observer.js";
import { parseReleaseEvalManifest, parseSanitizedSubjectIdentifier } from "./release/manifest.js";
import { adaptProjectedObserverCases } from "./release/observer-runner.js";
import { isPathInside } from "./release/path-safety.js";
import type { JsonValue, ProjectedCorpusV1, ReleaseEvalManifestV1 } from "./release/types.js";

const PROFILE_ID = "balanced-observer-quality-v1";
const INJECTION_CLASSES = [
	"locating",
	"decision",
	"outcome",
	"troubleshooting",
	"continuation",
] as const;

export interface PrivateCorpusExportOptions {
	dbPath: string;
	outputDirectory: string;
	candidateVersion: string;
	repositoryRoot?: string;
	repetitions?: number;
}

export interface OutputDirectoryIdentity {
	path: string;
	device: number;
	inode: number;
	parentPath: string;
	parentDevice: number;
	parentInode: number;
}

export interface PrivateCorpusExportDependencies {
	getProfile(id: string): ExtractionBenchmarkProfile | null;
	projectBatch(
		dbPath: string,
		opts: { batchId: number; scenarioId: string },
	): Promise<ExtractionReplayProjection>;
	loadConfig(): ObserverConfig;
	resolveCommit(repositoryRoot: string): Promise<string>;
	readEvaluatorStatus(repositoryRoot: string): Promise<string>;
	writeOutputFile(identity: OutputDirectoryIdentity, name: string, contents: string): Promise<void>;
}

const DEFAULT_DEPENDENCIES: PrivateCorpusExportDependencies = {
	getProfile: getExtractionBenchmarkProfile,
	projectBatch: projectReplayBatch,
	loadConfig: loadObserverConfig,
	resolveCommit: async (repositoryRoot) => {
		const result = await executeCommand("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
		const commit = result.stdout.trim();
		if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
			throw new Error(`Could not resolve current evaluator commit: ${result.stderr.trim()}`);
		}
		return commit;
	},
	readEvaluatorStatus: async (repositoryRoot) => {
		const result = await executeCommand(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all"],
			{ cwd: repositoryRoot },
		);
		if (result.exitCode !== 0) {
			throw new Error(`Could not inspect evaluator worktree: ${result.stderr.trim()}`);
		}
		return result.stdout;
	},
	writeOutputFile: async (identity, name, contents) => await atomicWrite(identity, name, contents),
};

function projectedToolEvent(event: ToolEvent): JsonValue {
	return {
		tool_name: event.toolName,
		tool_input: jsonValue(event.toolInput ?? null, "tool input"),
		tool_output: jsonValue(event.toolOutput ?? null, "tool output"),
		tool_error: jsonValue(event.toolError ?? null, "tool error"),
		timestamp: event.timestamp,
		cwd: event.cwd,
	};
}

function projectedObserverContext(context: ObserverContext): JsonValue {
	return {
		project: context.project,
		user_prompt: context.userPrompt,
		prompt_number: context.promptNumber,
		transcript: context.transcript,
		tool_events: context.toolEvents.map(projectedToolEvent),
		last_assistant_message: context.lastAssistantMessage,
		include_summary: context.includeSummary,
		diff_summary: context.diffSummary,
		recent_files: context.recentFiles,
	};
}

function projectedLabel(label: ExtractionBenchmarkLabel): JsonValue {
	return {
		label_id: label.id,
		title: label.title,
		keyword_groups: label.keywordGroups,
		reviewer_notes: label.reviewerNotes,
		evidence_notes: label.sourceEvidence,
	};
}

function stableContentId(kind: "case" | "probe", ...parts: Array<string | number>): string {
	const hash = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 24);
	return `${kind}-${hash}`;
}

function assertUnique<T extends string | number>(values: readonly T[], description: string): void {
	if (new Set(values).size !== values.length) throw new TypeError(`${description} must be unique`);
}

function reviewedProfile(profile: ExtractionBenchmarkProfile | null): ExtractionBenchmarkProfile {
	if (!profile) throw new Error(`Extraction benchmark profile ${PROFILE_ID} is missing`);
	if (profile.id !== PROFILE_ID) throw new TypeError(`Extraction benchmark profile ID must be ${PROFILE_ID}`);
	assertUnique(
		profile.batches.map((batch) => batch.batchId),
		"benchmark batch IDs",
	);
	const shapeCount = profile.batches.filter((batch) => batch.purpose === "shape_quality").length;
	const robustnessCount = profile.batches.filter(
		(batch) => batch.purpose === "replay_robustness",
	).length;
	if (profile.batches.length !== 19 || shapeCount !== 18 || robustnessCount !== 1) {
		throw new TypeError(`${PROFILE_ID} must contain 18 shape cases and one robustness case`);
	}
	for (const batch of profile.batches) {
		if (batch.review?.status !== "reviewed") {
			throw new TypeError(`Benchmark batch ${batch.batchId} is missing reviewed labels`);
		}
		assertUnique(
			batch.review.labels.map((label) => label.id),
			`reviewed label IDs for batch ${batch.batchId}`,
		);
	}
	return profile;
}

export function digestReviewedProfile(profile: ExtractionBenchmarkProfile): string {
	const batches = profile.batches
		.toSorted((left, right) => left.batchId - right.batchId)
		.map((batch) => {
			const review = batch.review;
			if (review?.status !== "reviewed") {
				throw new TypeError(`Benchmark batch ${batch.batchId} is missing reviewed labels`);
			}
			return {
				batch_id: batch.batchId,
				session_id: batch.sessionId,
				label: batch.label,
				purpose: batch.purpose,
				complexity: batch.complexity,
				scenario_id: batch.scenarioId ?? profile.scenarioId,
				expected_summary_disposition: batch.expectedSummaryDisposition,
				observation_policy: batch.observationPolicy ?? "scenario",
				review: {
					reviewer_notes: review.reviewerNotes,
					labels: review.labels.toSorted((left, right) => compareCodePoints(left.id, right.id)),
				},
			};
		});
	return digest(
		jsonValue(
			{ schema_version: 1, profile_id: profile.id, scenario_id: profile.scenarioId, batches },
			"reviewed benchmark profile",
		),
	);
}

function observerRow(input: {
	profile: ExtractionBenchmarkProfile;
	batch: ExtractionBenchmarkProfile["batches"][number];
	projection: ExtractionReplayProjection;
	ordinal: number;
}): ProjectedCorpusV1["rows"][number] {
	const { profile, batch, projection } = input;
	const review = batch.review;
	if (review?.status !== "reviewed") throw new TypeError(`Benchmark batch ${batch.batchId} is unreviewed`);
	const required = review.labels.filter((label) => label.disposition === "required");
	if (batch.observationPolicy === "zero" && required.length > 0) {
		throw new TypeError(
			`Zero-observation benchmark batch ${batch.batchId} must not define required durable labels`,
		);
	}
	return {
		case_id: stableContentId("case", profile.id, batch.batchId),
		ordinal: input.ordinal,
		row_type: "observer_case",
		value: {
			observer_context: projectedObserverContext(projection.observerContext),
			review: {
				reviewer_notes: review.reviewerNotes,
				required: required.toSorted((a, b) => compareCodePoints(a.id, b.id)).map(projectedLabel),
				optional: review.labels
					.filter((label) => label.disposition === "optional")
					.toSorted((a, b) => compareCodePoints(a.id, b.id))
					.map(projectedLabel),
				forbidden: review.labels
					.filter((label) => label.disposition === "forbidden")
					.toSorted((a, b) => compareCodePoints(a.id, b.id))
					.map(projectedLabel),
			},
			expected_summary_disposition: batch.expectedSummaryDisposition,
			expected_observation_policy: batch.observationPolicy === "zero" ? "zero" : "quality",
		},
	};
}

function retrievalRows(input: {
	profile: ExtractionBenchmarkProfile;
	batch: ExtractionBenchmarkProfile["batches"][number];
	projection: ExtractionReplayProjection;
	observerCaseId: string;
}): Array<Omit<ProjectedCorpusV1["rows"][number], "ordinal">> {
	const review = input.batch.review;
	if (review?.status !== "reviewed") throw new TypeError(`Benchmark batch ${input.batch.batchId} is unreviewed`);
	const required = review.labels
		.filter((label) => label.disposition === "required")
		.toSorted((a, b) => compareCodePoints(a.id, b.id))
		.map((label) => ({
			case_id: stableContentId("probe", input.profile.id, input.batch.batchId, "durable", label.id),
			row_type: "retrieval_probe",
			value: {
				query: label.title,
				expected_mode: "default",
				relevant_case_ids: [input.observerCaseId],
				expected_artifact: "durable",
				explicit_recap: false,
				top_n: 5,
			},
		}));
	if (input.batch.expectedSummaryDisposition !== "required") return required;
	// Historical fbb2b9ea used the reviewed prompt prefixed with "recap" so the
	// future retrieval lane exercises explicit recall routing without new source text.
	return [
		...required,
		{
			case_id: stableContentId("probe", input.profile.id, input.batch.batchId, "recap"),
			row_type: "retrieval_probe",
			value: {
				query: `recap ${input.projection.observerContext.userPrompt}`.trim(),
				expected_mode: "recall",
				relevant_case_ids: [input.observerCaseId],
				expected_artifact: "session_summary",
				explicit_recap: true,
				top_n: 5,
			},
		},
	];
}

async function buildPrivateCorpus(
	dbPath: string,
	profile: ExtractionBenchmarkProfile,
	deps: PrivateCorpusExportDependencies,
): Promise<{ observer: ProjectedCorpusV1; retrieval: ProjectedCorpusV1 }> {
	const batches = profile.batches.toSorted((left, right) => left.batchId - right.batchId);
	const observerRows: ProjectedCorpusV1["rows"] = [];
	const pendingRetrievalRows: Array<Omit<ProjectedCorpusV1["rows"][number], "ordinal">> = [];
	for (const batch of batches) {
		const projection = await deps.projectBatch(dbPath, {
			batchId: batch.batchId,
			scenarioId: batch.scenarioId ?? profile.scenarioId,
		});
		if (projection.analysis.batchId !== batch.batchId) {
			throw new TypeError(`Projected batch ID mismatch for profile batch ${batch.batchId}`);
		}
		if (projection.analysis.sessionId !== batch.sessionId) {
			throw new TypeError(`Projected session mismatch for profile batch ${batch.batchId}`);
		}
		const row = observerRow({ profile, batch, projection, ordinal: observerRows.length });
		observerRows.push(row);
		pendingRetrievalRows.push(
			...retrievalRows({ profile, batch, projection, observerCaseId: row.case_id }),
		);
	}
	const retrieval = pendingRetrievalRows.map((row, ordinal) => ({ ...row, ordinal }));
	assertUnique(
		[...observerRows, ...retrieval].map((row) => row.case_id),
		"projected case and probe IDs",
	);
	adaptProjectedObserverCases({ schema_version: 1, rows: observerRows });
	return {
		observer: { schema_version: 1, rows: observerRows },
		retrieval: { schema_version: 1, rows: retrieval },
	};
}

export function syntheticPublicInjectionCorpus(): ProjectedCorpusV1 {
	const successes = INJECTION_CLASSES.map((scenarioClass, ordinal) => {
		const prompt = `synthetic ${scenarioClass} continuity`;
		const answer = `use-${scenarioClass}-memory`;
		return {
			case_id: `synthetic-injection-${scenarioClass}`,
			ordinal,
			row_type: "injection_case",
			value: {
				scenario_class: scenarioClass,
				first_prompt: prompt,
				latest_prompt: prompt,
				project_name: "release-eval",
				files_modified: [],
				expected_query: `${prompt} release-eval`,
				injection_enabled: true,
				pack_outcome: "success",
				pack_text: `## Observations\n[${ordinal + 1}] ${scenarioClass} evidence [[answer:${answer}]]`,
				memory_ids: [`memory-${scenarioClass}`],
				expected_memory_ids: [`memory-${scenarioClass}`],
				expected_answer: answer,
			},
		};
	});
	const failures = [
		["disabled", false, "success"],
		["empty", true, "empty"],
		["malformed", true, "malformed"],
		["exit-error", true, "exit_error"],
	] as const;
	return {
		schema_version: 1,
		rows: [
			...successes,
			...failures.map(([name, enabled, outcome], index) => ({
				case_id: `synthetic-injection-${name}`,
				ordinal: successes.length + index,
				row_type: "injection_case",
				value: {
					scenario_class: INJECTION_CLASSES[index] ?? "continuation",
					first_prompt: `synthetic ${name} containment`,
					latest_prompt: `synthetic ${name} containment`,
					project_name: "release-eval",
					files_modified: [],
					expected_query: `synthetic ${name} containment release-eval`,
					injection_enabled: enabled,
					pack_outcome: outcome,
					pack_text: "",
					memory_ids: [],
					expected_memory_ids: [],
					expected_answer: `unused-${name}`,
				},
			})),
		],
	};
}

export function effectiveEvaluatorConfiguration(
	base: ObserverConfig,
): ReleaseEvalManifestV1["evaluator"]["configuration"] {
	const provider = base.observerProvider?.trim().toLowerCase() ?? "";
	const model = base.observerModel?.trim() ?? "";
	if (!provider) throw new TypeError("Release export requires an explicit observer provider");
	if (!model) throw new TypeError("Release export requires an explicit observer model");
	const requestedRuntime = base.observerRuntime?.trim().toLowerCase() || null;
	if (
		requestedRuntime !== null &&
		!["api_http", "claude_sidecar", "codex_sidecar"].includes(requestedRuntime)
	) {
		throw new TypeError(`Unsupported observer runtime for release export: ${requestedRuntime}`);
	}
	const maxOutputTokens =
		typeof base.observerMaxOutputTokens === "number" &&
		Number.isSafeInteger(base.observerMaxOutputTokens) &&
		base.observerMaxOutputTokens > 0
			? base.observerMaxOutputTokens
			: base.observerMaxTokens;
	if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
		throw new TypeError("Effective observer max output tokens must be a positive safe integer");
	}
	const transport = requestedRuntime ?? "api_http";
	return {
		provider,
		transport,
		endpoint_mode: "provider_default",
		model,
		temperature:
			typeof base.observerTemperature === "number" && Number.isFinite(base.observerTemperature)
				? base.observerTemperature
				: 0.2,
		openai_responses:
			typeof base.observerOpenAIUseResponses === "boolean"
				? base.observerOpenAIUseResponses
				: provider === "openai" && transport === "api_http",
		reasoning_effort: base.observerReasoningEffort?.trim() || null,
		reasoning_summary: base.observerReasoningSummary?.trim() || null,
		max_output_tokens: maxOutputTokens,
		tier_routing_enabled: false,
	};
}

export function buildPrivateReleaseManifest(input: {
	commit: string;
	candidateVersion: string;
	configuration: ReleaseEvalManifestV1["evaluator"]["configuration"];
	privateDigest: ReleaseEvalManifestV1["corpora"][number]["expected_digest"];
	repetitions?: number;
}): ReleaseEvalManifestV1 {
	const releases = ["0.37.1", "0.38.0", "0.39.0"].map((version) => ({
		label: `v${version}`,
		requested_ref: `v${version}`,
		observer_context_schema_version: 1 as const,
		subject: { kind: "release" as const, version },
		components: ["observer"] as ["observer"],
	}));
	return parseReleaseEvalManifest({
		schema_version: 1,
		benchmark_profile: "release-v1",
		corpora: [
			{
				tier: "private",
				schema_version: 1,
				source_path: "private-corpus.json",
				expected_digest: input.privateDigest,
			},
		],
		evaluator: { commit: input.commit, configuration: input.configuration },
		subjects: [
			...releases,
			{
				label: "candidate",
				requested_ref: input.commit,
				observer_context_schema_version: 1,
				subject: { kind: "candidate", version: input.candidateVersion },
				components: ["observer"],
			},
		],
		repetitions: input.repetitions ?? 3,
	});
}

async function assertNoRedirectComponents(path: string): Promise<void> {
	const root = parse(path).root;
	const segments = relative(root, path).split(sep).filter(Boolean);
	let current = root;
	for (const [index, segment] of segments.entries()) {
		current = join(current, segment);
		const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") throw new TypeError("Output directory parent must already exist");
			throw error;
		});
		if (entry.isSymbolicLink() && index !== 0) {
			throw new TypeError("Output path must not contain intermediate symbolic links");
		}
	}
}

async function safeOutputDirectory(
	repositoryRoot: string,
	requested: string,
): Promise<OutputDirectoryIdentity> {
	if (!requested || !isAbsolute(requested)) {
		throw new TypeError("Output directory must be an explicit absolute path outside the repository");
	}
	const repositoryReal = await realpath(repositoryRoot);
	const candidate = resolve(requested);
	const parent = dirname(candidate);
	await assertNoRedirectComponents(parent);
	const parentEntry = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			throw new TypeError("Output directory parent must already exist");
		}
		throw error;
	});
	if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
		throw new TypeError("Output directory parent must be a real directory");
	}
	const parentReal = await realpath(parent);
	const projectedReal = resolve(parentReal, basename(candidate));
	if (isPathInside(repositoryReal, projectedReal)) {
		throw new TypeError("Output directory must be outside the repository");
	}
	try {
		await lstat(candidate);
		throw new TypeError("Output directory must be a new path");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(candidate, { recursive: false, mode: 0o700 });
	await chmod(candidate, 0o700);
	const outputReal = await realpath(candidate);
	const parentAfter = await lstat(parent);
	if (
		(await realpath(parent)) !== parentReal ||
		parentAfter.dev !== parentEntry.dev ||
		parentAfter.ino !== parentEntry.ino ||
		outputReal !== projectedReal
	) {
		await rm(candidate, { recursive: true, force: true });
		throw new TypeError("Output directory parent changed during creation");
	}
	const outputEntry = await lstat(candidate);
	if (outputEntry.isSymbolicLink() || !outputEntry.isDirectory()) {
		throw new TypeError("Output directory must be a real directory");
	}
	return {
		path: outputReal,
		device: outputEntry.dev,
		inode: outputEntry.ino,
		parentPath: parentReal,
		parentDevice: parentEntry.dev,
		parentInode: parentEntry.ino,
	};
}

async function assertOutputIdentity(identity: OutputDirectoryIdentity): Promise<void> {
	const parentEntry = await lstat(identity.parentPath);
	if (
		parentEntry.isSymbolicLink() ||
		!parentEntry.isDirectory() ||
		parentEntry.dev !== identity.parentDevice ||
		parentEntry.ino !== identity.parentInode ||
		(await realpath(identity.parentPath)) !== identity.parentPath
	) {
		throw new TypeError("Output directory parent changed during export");
	}
	const directoryEntry = await lstat(identity.path);
	if (
		directoryEntry.isSymbolicLink() ||
		!directoryEntry.isDirectory() ||
		directoryEntry.dev !== identity.device ||
		directoryEntry.ino !== identity.inode ||
		(await realpath(identity.path)) !== identity.path
	) {
		throw new TypeError("Output directory became unsafe during export");
	}
	if (dirname(identity.path) !== identity.parentPath) throw new TypeError("Output directory moved");
}

async function atomicWrite(
	identity: OutputDirectoryIdentity,
	name: string,
	contents: string,
): Promise<void> {
	await assertOutputIdentity(identity);
	const directory = identity.path;
	const target = join(directory, name);
	const temporary = join(
		directory,
		`.${name}.${process.pid}.${createHash("sha256").update(contents).digest("hex").slice(0, 12)}.tmp`,
	);
	let linked = false;
	try {
		await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		try {
			await link(temporary, target);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
				throw new Error(
					`Atomic private-corpus export requires hard-link support in the output filesystem (${code})`,
					{ cause: error },
				);
			}
			throw error;
		}
		linked = true;
		await rm(temporary);
	} catch (error) {
		await Promise.allSettled([
			rm(temporary, { force: true }),
			...(linked ? [rm(target, { force: true })] : []),
		]);
		throw error;
	}
}

function canonicalCorpus(corpus: ProjectedCorpusV1): string {
	return `${serialize(project(corpus) as unknown as JsonValue)}\n`;
}

export async function exportPrivateReleaseCorpus(
	options: PrivateCorpusExportOptions,
	overrides: Partial<PrivateCorpusExportDependencies> = {},
): Promise<{
	privateDigest: string;
	retrievalSidecarDigest: string;
	injectionSidecarDigest: string;
	outputDirectory: string;
}> {
	if (!options.dbPath || !isAbsolute(options.dbPath)) {
		throw new TypeError("An explicit absolute --db path is required");
	}
	const repositoryRoot = resolve(
		options.repositoryRoot ?? fileURLToPath(new URL("../..", import.meta.url)),
	);
	const deps = { ...DEFAULT_DEPENDENCIES, ...overrides };
	parseSanitizedSubjectIdentifier(
		{ kind: "candidate", version: options.candidateVersion },
		"candidate subject",
	);
	const configuration = effectiveEvaluatorConfiguration(deps.loadConfig());
	const profile = reviewedProfile(deps.getProfile(PROFILE_ID));
	const reviewedProfileDigest = digestReviewedProfile(profile);
	const status = await deps.readEvaluatorStatus(repositoryRoot);
	if (status.trim()) throw new TypeError("Evaluator worktree must be clean, including untracked files");
	const commit = await deps.resolveCommit(repositoryRoot);
	const outputIdentity = await safeOutputDirectory(repositoryRoot, options.outputDirectory);
	const written: string[] = [];
	try {
		const corpora = await buildPrivateCorpus(resolve(options.dbPath), profile, deps);
		const injectionCorpus = syntheticPublicInjectionCorpus();
		const privateDigest = digestCorpus(corpora.observer);
		const retrievalSidecarDigest = digestCorpus(corpora.retrieval);
		const injectionSidecarDigest = digestCorpus(injectionCorpus);
		const manifest = buildPrivateReleaseManifest({
			commit,
			candidateVersion: options.candidateVersion,
			configuration,
			privateDigest,
			repetitions: options.repetitions,
		});
		const metadata: JsonValue = {
			schema_version: 1,
			benchmark_profile: PROFILE_ID,
			evaluator_commit: commit,
			candidate_commit: commit,
			candidate_version: options.candidateVersion,
			reviewed_profile_digest: reviewedProfileDigest,
			private_corpus_digest: privateDigest,
			private_retrieval_sidecar_digest: retrievalSidecarDigest,
			public_injection_sidecar_digest: injectionSidecarDigest,
			observer_case_count: corpora.observer.rows.length,
			retrieval_probe_count: corpora.retrieval.rows.length,
			public_injection_case_count: injectionCorpus.rows.length,
			source_projection: "read_only_completed_raw_event_flush_batches",
		};
		const entries = [
			{ name: "private-corpus.json", contents: canonicalCorpus(corpora.observer) },
			{ name: "private-retrieval-corpus.json", contents: canonicalCorpus(corpora.retrieval) },
			{ name: "public-injection-corpus.json", contents: canonicalCorpus(injectionCorpus) },
			{
				name: "private-release-manifest.json",
				contents: `${serialize(manifest as unknown as JsonValue)}\n`,
			},
			{ name: "export-metadata.json", contents: `${serialize(metadata)}\n` },
		] as const;
		if ((await deps.readEvaluatorStatus(repositoryRoot)).trim()) {
			throw new TypeError("Evaluator worktree changed during export");
		}
		for (const entry of entries) {
			await deps.writeOutputFile(outputIdentity, entry.name, entry.contents);
			written.push(entry.name);
		}
		return {
			privateDigest,
			retrievalSidecarDigest,
			injectionSidecarDigest,
			outputDirectory: outputIdentity.path,
		};
	} catch (error) {
		await Promise.allSettled(
			written.map(async (name) => await rm(join(outputIdentity.path, name), { force: true })),
		);
		await Promise.allSettled([rmdir(outputIdentity.path)]);
		throw error;
	}
}

export function parsePrivateCorpusExportArgs(args: string[]): PrivateCorpusExportOptions {
	let dbPath = "";
	let outputDirectory = "";
	let candidateVersion = "";
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--") continue;
		if (arg === "--db" || arg === "--output-dir" || arg === "--candidate-version") {
			const value = args[index + 1];
			if (!value) throw new TypeError(`${arg} requires a value`);
			if (arg === "--db") dbPath = value;
			else if (arg === "--output-dir") outputDirectory = value;
			else candidateVersion = value;
			index += 1;
			continue;
		}
		throw new TypeError(`Unknown argument: ${arg}`);
	}
	return { dbPath, outputDirectory, candidateVersion };
}

async function main(): Promise<void> {
	const result = await exportPrivateReleaseCorpus(parsePrivateCorpusExportArgs(process.argv.slice(2)));
	process.stdout.write(
		`${JSON.stringify({
			privateDigest: result.privateDigest,
			retrievalSidecarDigest: result.retrievalSidecarDigest,
			injectionSidecarDigest: result.injectionSidecarDigest,
		})}\n`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
