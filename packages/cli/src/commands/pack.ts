import { posix, win32 } from "node:path";
import * as p from "@clack/prompts";
import type {
	Database,
	MemoryFilters,
	PackArtifacts,
	PackTrace,
	PromptPackAttemptMetadata,
	RetrievalLedgerWriteOutcome,
} from "@codemem/core";
import {
	clonePromptPackAttempt,
	MemoryStore,
	promptPackArtifactFingerprint,
	recordPromptPackArtifacts,
	recordPromptPackTerminal,
	resolveDbPath,
	tryUpdateRetrievalDelivery,
} from "@codemem/core";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	emitJsonError,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";
import { addPackRequestOptions, buildPackRequestOptions, PackUsageError } from "./pack-shared.js";

type PackCommandOptions = DbOpts &
	JsonOpts & {
		limit: string;
		budget?: string;
		tokenBudget?: string;
		workingSetFile?: string[];
		project?: string;
		allProjects?: boolean;
		compact?: boolean;
		compactDetail?: string;
		internalLedger?: boolean;
	};

const MAX_INTERNAL_LEDGER_INPUT_BYTES = 16 * 1024;
const INTERNAL_LEDGER_INPUT_TIMEOUT_MS = 1000;
const FORBIDDEN_INTERNAL_KEYS = new Set([
	"body",
	"context",
	"pack",
	"pack_text",
	"path",
	"preview",
	"prompt",
	"query",
	"raw_prompt",
	"title",
]);

export type InternalLedgerPayload = {
	action?: "record" | "delivery" | "cache_reuse";
	attempt_id: string;
	started_at?: string;
	source?: string;
	stream_id?: string;
	source_session_id?: string;
	prompt_number?: number;
	request_id?: string;
	retrieval_status?: "skipped" | "failed";
	delivery_status?: "handed_off" | "failed" | "unknown";
	failure_code?: string;
	failure_stage?: string;
	original_attempt_id?: string;
};

const INTERNAL_LEDGER_KEYS = new Set([
	"action",
	"attempt_id",
	"started_at",
	"source",
	"stream_id",
	"source_session_id",
	"prompt_number",
	"request_id",
	"retrieval_status",
	"delivery_status",
	"failure_code",
	"failure_stage",
	"original_attempt_id",
]);
const INTERNAL_LEDGER_ACTIONS = new Set(["record", "delivery", "cache_reuse"]);
const INTERNAL_RETRIEVAL_STATUSES = new Set(["skipped", "failed"]);
const INTERNAL_DELIVERY_STATUSES = new Set(["handed_off", "failed", "unknown"]);

async function readInternalLedgerPayload(): Promise<InternalLedgerPayload> {
	const stdin = process.stdin;
	if (stdin.isTTY) {
		throw new PackUsageError("internal ledger metadata requires piped stdin JSON");
	}
	const raw = await new Promise<string>((resolve, reject) => {
		let value = "";
		const cleanup = () => {
			clearTimeout(timer);
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			stdin.off("error", onError);
		};
		const fail = (error: Error) => {
			cleanup();
			stdin.pause();
			reject(error);
		};
		const onData = (chunk: Buffer | string) => {
			value += String(chunk);
			if (Buffer.byteLength(value, "utf8") > MAX_INTERNAL_LEDGER_INPUT_BYTES) {
				fail(new PackUsageError("internal ledger metadata exceeds 16384 bytes"));
			}
		};
		const onEnd = () => {
			cleanup();
			resolve(value);
		};
		const onError = (error: Error) => fail(error);
		const timer = setTimeout(
			() => fail(new PackUsageError("internal ledger metadata read timed out")),
			INTERNAL_LEDGER_INPUT_TIMEOUT_MS,
		);
		stdin.on("data", onData);
		stdin.once("end", onEnd);
		stdin.once("error", onError);
	});
	return parseInternalLedgerPayload(raw);
}

export function parseInternalLedgerPayload(raw: string): InternalLedgerPayload {
	if (Buffer.byteLength(raw, "utf8") > MAX_INTERNAL_LEDGER_INPUT_BYTES) {
		throw new PackUsageError("internal ledger metadata exceeds 16384 bytes");
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new PackUsageError("internal ledger metadata must be valid JSON");
	}
	if (value == null || typeof value !== "object" || Array.isArray(value)) {
		throw new PackUsageError("internal ledger metadata must be an object");
	}
	for (const key of Object.keys(value)) {
		if (FORBIDDEN_INTERNAL_KEYS.has(key)) {
			throw new PackUsageError(`internal ledger metadata rejects sensitive field: ${key}`);
		}
		if (!INTERNAL_LEDGER_KEYS.has(key)) {
			throw new PackUsageError(`internal ledger metadata contains unsupported field: ${key}`);
		}
	}
	const payload = value as InternalLedgerPayload;
	if (typeof payload.attempt_id !== "string") {
		throw new PackUsageError("internal ledger metadata requires attempt_id");
	}
	if (payload.action != null && !INTERNAL_LEDGER_ACTIONS.has(payload.action)) {
		throw new PackUsageError("internal ledger action is invalid");
	}
	if (
		payload.retrieval_status != null &&
		!INTERNAL_RETRIEVAL_STATUSES.has(payload.retrieval_status)
	) {
		throw new PackUsageError("internal ledger retrieval_status is invalid");
	}
	if (payload.delivery_status != null && !INTERNAL_DELIVERY_STATUSES.has(payload.delivery_status)) {
		throw new PackUsageError("internal ledger delivery_status is invalid");
	}
	if (
		payload.prompt_number != null &&
		(!Number.isInteger(payload.prompt_number) || payload.prompt_number < 0)
	) {
		throw new PackUsageError("internal ledger prompt_number must be a non-negative integer");
	}
	for (const key of [
		"started_at",
		"source",
		"stream_id",
		"source_session_id",
		"request_id",
		"failure_code",
		"failure_stage",
		"original_attempt_id",
	] as const) {
		const field = payload[key];
		if (field != null && (typeof field !== "string" || field.length > 512)) {
			throw new PackUsageError(`internal ledger metadata field ${key} is invalid`);
		}
		if (typeof field === "string" && (posix.isAbsolute(field) || win32.isAbsolute(field))) {
			throw new PackUsageError(`internal ledger metadata rejects absolute paths in field: ${key}`);
		}
	}
	return payload;
}

function attemptMetadata(payload: InternalLedgerPayload): PromptPackAttemptMetadata {
	return {
		attemptId: payload.attempt_id,
		startedAt: payload.started_at ?? new Date().toISOString(),
		completedAt: new Date().toISOString(),
		source: payload.source ?? "opencode",
		streamId: payload.stream_id ?? null,
		sourceSessionId: payload.source_session_id ?? null,
		promptNumber: payload.prompt_number ?? null,
		requestId: payload.request_id ?? null,
	};
}

export function handleInstrumentedPackLedger(
	db: Database,
	payload: InternalLedgerPayload,
	context: string,
	filters: MemoryFilters | undefined,
	artifacts: PackArtifacts,
): RetrievalLedgerWriteOutcome {
	return recordPromptPackArtifacts(db, attemptMetadata(payload), context, filters, artifacts);
}

function describeCandidate(candidate: PackTrace["retrieval"]["candidates"][number]): string[] {
	const scoreParts = [
		candidate.scores.combined_score != null
			? `combined=${candidate.scores.combined_score.toFixed(2)}`
			: null,
		candidate.scores.base_score != null ? `base=${candidate.scores.base_score.toFixed(2)}` : null,
		candidate.scores.text_overlap > 0 ? `text=${candidate.scores.text_overlap}` : null,
		candidate.scores.tag_overlap > 0 ? `tag=${candidate.scores.tag_overlap}` : null,
		candidate.scores.working_set_overlap > 0
			? `working_set=${candidate.scores.working_set_overlap.toFixed(2)}`
			: null,
	]
		.filter(Boolean)
		.join(" ");

	const lines = [`${candidate.rank}. [${candidate.id}] (${candidate.kind}) ${candidate.title}`];
	if (candidate.section) lines.push(`   - section: ${candidate.section}`);
	if (candidate.reasons.length > 0) lines.push(`   - reasons: ${candidate.reasons.join(", ")}`);
	if (scoreParts) lines.push(`   - scores: ${scoreParts}`);
	if (candidate.preview) lines.push(`   - preview: ${candidate.preview}`);
	return lines;
}

export function renderPackTrace(trace: PackTrace): string {
	const workingSet =
		trace.inputs.working_set_files.length > 0
			? trace.inputs.working_set_files.join(", ")
			: "(none)";
	const lines = [
		"Pack trace",
		`- Query: ${trace.inputs.query}`,
		...(trace.inputs.sanitized_query ? [`- Sanitized query: ${trace.inputs.sanitized_query}`] : []),
		`- Project: ${trace.inputs.project ?? "(default)"}`,
		`- Working set: ${workingSet}`,
		`- Mode: ${trace.mode.selected}`,
		`- Mode reasons: ${trace.mode.reasons.join(", ") || "(none)"}`,
		`- Token budget: ${trace.inputs.token_budget ?? "(none)"}`,
		"",
	];

	for (const disposition of ["selected", "dropped", "deduped", "trimmed"] as const) {
		const group = trace.retrieval.candidates.filter(
			(candidate) => candidate.disposition === disposition,
		);
		if (group.length === 0) continue;
		lines.push(disposition.charAt(0).toUpperCase() + disposition.slice(1));
		for (const candidate of group) {
			lines.push(...describeCandidate(candidate));
		}
		lines.push("");
	}

	lines.push("Assembly");
	lines.push(`- deduped ids: ${trace.assembly.deduped_ids.join(", ") || "(none)"}`);
	lines.push(`- trimmed ids: ${trace.assembly.trimmed_ids.join(", ") || "(none)"}`);
	lines.push(`- trim reasons: ${trace.assembly.trim_reasons.join(", ") || "(none)"}`);
	lines.push(
		`- section counts: summary=${trace.output.section_counts.summary} timeline=${trace.output.section_counts.timeline} observations=${trace.output.section_counts.observations}`,
	);
	lines.push(`- estimated tokens: ${trace.output.estimated_tokens}`);
	lines.push(`- truncated: ${trace.output.truncated ? "yes" : "no"}`);
	lines.push("");
	lines.push("Final pack");
	lines.push(trace.output.pack_text);
	return lines.join("\n");
}

async function withStore(
	opts: PackCommandOptions,
	errorCode: string,
	run: (store: MemoryStore) => Promise<void>,
): Promise<void> {
	let store: MemoryStore | null = null;
	try {
		store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
		await run(store);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const usageError = error instanceof PackUsageError;
		if (opts.json) {
			emitJsonError(usageError ? "usage_error" : errorCode, message, usageError ? 2 : 1);
			return;
		}
		p.log.error(message);
		process.exitCode = usageError ? 2 : 1;
	} finally {
		store?.close();
	}
}

async function packAction(context: string, opts: PackCommandOptions): Promise<void> {
	await withStore(opts, "pack_failed", async (store) => {
		const { limit, budget, filters, renderOptions } = buildPackRequestOptions(opts, {
			envProject: process.env.CODEMEM_PROJECT,
		});
		let result: Awaited<ReturnType<MemoryStore["buildMemoryPackAsync"]>>;
		if (opts.internalLedger) {
			const artifacts = await store.buildMemoryPackWithTraceAsync(
				context,
				limit,
				budget,
				filters,
				renderOptions,
			);
			result = artifacts.response;
			let artifactFingerprint: string | undefined;
			try {
				artifactFingerprint = promptPackArtifactFingerprint(store.db, context, filters, artifacts);
			} catch {
				// Fingerprinting is instrumentation and must not block pack delivery.
			}
			let ledgerOutcome: RetrievalLedgerWriteOutcome | undefined;
			try {
				const ledgerPayload = await readInternalLedgerPayload();
				ledgerOutcome = handleInstrumentedPackLedger(
					store.db,
					ledgerPayload,
					context,
					filters,
					artifacts,
				);
			} catch {
				// Instrumentation is best-effort and must not change pack output or exit status.
			}
			emitPackResult(
				context,
				opts,
				result,
				artifactFingerprint,
				ledgerOutcome?.ok === false && ledgerOutcome.reason === "idempotency_conflict"
					? ledgerOutcome
					: undefined,
			);
			return;
		} else {
			result = await store.buildMemoryPackAsync(context, limit, budget, filters, renderOptions);
		}
		emitPackResult(context, opts, result);
	});
}

function emitPackResult(
	context: string,
	opts: Pick<PackCommandOptions, "json">,
	result: Awaited<ReturnType<MemoryStore["buildMemoryPackAsync"]>>,
	ledgerArtifactFingerprint?: string,
	ledgerOutcome?: Extract<RetrievalLedgerWriteOutcome, { ok: false }>,
): void {
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					...result,
					...(ledgerArtifactFingerprint
						? { ledger_artifact_fingerprint: ledgerArtifactFingerprint }
						: {}),
					...(ledgerOutcome ? { ledger_outcome: ledgerOutcome } : {}),
				},
				null,
				2,
			),
		);
		return;
	}

	p.intro(`Memory pack for "${context}"`);

	if (result.items.length === 0) {
		p.log.warn("No relevant memories found.");
		p.outro("done");
		return;
	}

	const metrics = result.metrics;
	p.log.info(
		`${metrics.total_items} items, ~${metrics.pack_tokens} tokens` +
			(metrics.fallback_used ? " (fallback)" : "") +
			`  [fts:${metrics.sources.fts} sem:${metrics.sources.semantic} fuzzy:${metrics.sources.fuzzy}]`,
	);

	for (const item of result.items) {
		p.log.step(`#${item.id}  ${item.kind}  ${item.title}`);
	}

	p.note(result.pack_text, "pack_text");
	p.outro("done");
}

async function traceAction(context: string, opts: PackCommandOptions): Promise<void> {
	await withStore(opts, "pack_trace_failed", async (store) => {
		const { limit, budget, filters, renderOptions } = buildPackRequestOptions(opts, {
			envProject: process.env.CODEMEM_PROJECT,
		});
		const trace = await store.buildMemoryPackTraceAsync(
			context,
			limit,
			budget,
			filters,
			renderOptions,
		);

		if (opts.json) {
			console.log(JSON.stringify(trace, null, 2));
			return;
		}

		console.log(renderPackTrace(trace));
	});
}

const packCmd = addPackRequestOptions(
	new Command("pack")
		.enablePositionalOptions()
		.configureHelp(helpStyle)
		.description("Build a context-aware memory pack")
		.argument("<context>", "context string to search for"),
);
packCmd.addOption(new Option("--internal-ledger").hideHelp());

addDbOption(packCmd);
addJsonOption(packCmd);
packCmd.action(packAction);

const traceCmd = addPackRequestOptions(
	new Command("trace")
		.configureHelp(helpStyle)
		.description("Trace retrieval and assembly for a memory pack")
		.argument("<context>", "context string to trace"),
);

addDbOption(traceCmd);
addJsonOption(traceCmd);
traceCmd.action(traceAction);
packCmd.addCommand(traceCmd);

export const packCommand = packCmd;

export function handlePromptPackLedger(db: Database, payload: InternalLedgerPayload) {
	const metadata = attemptMetadata(payload);
	if (payload.action === "delivery") {
		const status = payload.delivery_status;
		if (!status) throw new PackUsageError("delivery action requires delivery_status");
		const outcome = tryUpdateRetrievalDelivery(db, payload.attempt_id, status);
		if (!outcome.ok) throw new Error(outcome.reason);
		return outcome.value;
	}
	if (payload.action === "cache_reuse") {
		if (!payload.original_attempt_id) {
			throw new PackUsageError("cache_reuse action requires original_attempt_id");
		}
		const outcome = clonePromptPackAttempt(db, payload.original_attempt_id, metadata);
		if (!outcome.ok) throw new Error(outcome.reason);
		return outcome.value;
	}
	if (payload.action === "record") {
		if (!payload.retrieval_status || !payload.failure_code || !payload.failure_stage) {
			throw new PackUsageError(
				"record action requires retrieval_status, failure_code, and failure_stage",
			);
		}
		const outcome = recordPromptPackTerminal(
			db,
			metadata,
			payload.retrieval_status,
			payload.failure_code,
			payload.failure_stage,
		);
		if (!outcome.ok) throw new Error(outcome.reason);
		return outcome.value;
	}
	throw new PackUsageError("internal ledger action is invalid");
}

async function promptPackLedgerAction(opts: DbOpts): Promise<void> {
	await withStore(opts as PackCommandOptions, "prompt_pack_ledger_failed", async (store) => {
		const payload = await readInternalLedgerPayload();
		handlePromptPackLedger(store.db, payload);
	});
}

const ledgerCmd = new Command("prompt-pack-ledger")
	.description("Record internal prompt-pack lifecycle metadata")
	.action(promptPackLedgerAction);
addDbOption(ledgerCmd);
export const promptPackLedgerCommand = ledgerCmd;
