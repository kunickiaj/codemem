import { isAbsolute, posix, resolve as resolvePath, win32 } from "node:path";
import type {
	AutomaticContext,
	AutomaticRecallWriteOutcome,
	MemoryFilters,
	MemoryStore,
	PackRenderOptions,
	PromptPackAttemptMetadata,
	RetrievalLedgerDeliveryOutcome,
	RetrievalLedgerFailureReason,
	RetrievalLedgerWriteOutcome,
} from "@codemem/core";
import {
	clonePromptPackAttempt,
	isAutomaticRecallMeasurement,
	PROMPT_TRANSPORT_PROTOCOL_RANGE,
	promptPackArtifactFingerprint,
	recordAutomaticRecall,
	recordPromptPackArtifacts,
	recordPromptPackTerminal,
	resolveProject,
	tryUpdateRetrievalDelivery,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import * as z from "zod";
import { currentIdentityTarget, validateViewerTarget } from "./target-validation.js";

type StoreFactory = () => MemoryStore;
type LedgerOutcome =
	| RetrievalLedgerWriteOutcome
	| RetrievalLedgerDeliveryOutcome
	| AutomaticRecallWriteOutcome;

const MAX_LEDGER_PAYLOAD_BYTES = 16 * 1024;
const MAX_METADATA_FIELD_CHARS = 512;
const MAX_WORKING_SET_FILES = 50;
const MAX_WORKING_SET_PATH_CHARS = 512;
const INVALID_JSON = Symbol("invalid-json");

const FORBIDDEN_LEDGER_KEYS = new Set([
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

function optionalMetadataString(field: string) {
	const error = `ledger metadata field ${field} is invalid`;
	return z.string({ error }).max(MAX_METADATA_FIELD_CHARS, { error }).nullish();
}

const attemptMetadataShape = {
	attempt_id: z
		.string({ error: "ledger metadata requires attempt_id" })
		.min(1, { error: "ledger metadata requires attempt_id" })
		.max(MAX_METADATA_FIELD_CHARS, { error: "ledger metadata field attempt_id is invalid" }),
	started_at: optionalMetadataString("started_at"),
	source: optionalMetadataString("source"),
	stream_id: optionalMetadataString("stream_id"),
	source_session_id: optionalMetadataString("source_session_id"),
	prompt_number: z
		.number({ error: "ledger metadata prompt_number must be a non-negative integer" })
		.int({ error: "ledger metadata prompt_number must be a non-negative integer" })
		.nonnegative({ error: "ledger metadata prompt_number must be a non-negative integer" })
		.nullish(),
	request_id: optionalMetadataString("request_id"),
};
const attemptPayloadSchema = z.strictObject(attemptMetadataShape, {
	error: "attempt must be an object",
});
const ledgerPayloadSchema = z.strictObject({
	...attemptMetadataShape,
	automatic_recall: z.unknown().optional(),
	evaluation_key: z.unknown().optional(),
	action: z.unknown().optional(),
	retrieval_status: z.unknown().optional(),
	delivery_status: z.unknown().optional(),
	failure_code: optionalMetadataString("failure_code"),
	failure_stage: optionalMetadataString("failure_stage"),
	original_attempt_id: optionalMetadataString("original_attempt_id"),
	db_path: z.unknown().optional(),
	identity_target: z.unknown().optional(),
});
const automaticContextPayloadSchema = z.strictObject(
	{
		source: z
			.string({ error: "automatic_context source is invalid" })
			.max(64, { error: "automatic_context source is invalid" })
			.trim()
			.min(1, { error: "automatic_context source is invalid" }),
		host_session_id: z
			.string({ error: "automatic_context host_session_id is invalid" })
			.max(MAX_METADATA_FIELD_CHARS, { error: "automatic_context host_session_id is invalid" })
			.trim()
			.min(1, { error: "automatic_context host_session_id is invalid" }),
	},
	{ error: "automatic_context must be an object or null" },
);
const packRequestPayloadSchema = z.strictObject({
	context: z.string({ error: "context required" }).trim().min(1, { error: "context required" }),
	limit: z
		.number({ error: "limit must be a positive int" })
		.int({ error: "limit must be a positive int" })
		.min(1, { error: "limit must be a positive int" })
		.nullish()
		.transform((value) => value ?? 10),
	token_budget: z
		.number({ error: "token_budget must be a non-negative int" })
		.int({ error: "token_budget must be a non-negative int" })
		.nonnegative({ error: "token_budget must be a non-negative int" })
		.nullish()
		.transform((value) => value ?? null),
	project: z
		.string({ error: "project must be a non-empty string" })
		.refine((value) => value.trim().length > 0, { error: "project must be a non-empty string" })
		.nullish(),
	cwd: z
		.string({ error: "cwd must be an absolute path" })
		.refine((value) => value.trim().length > 0, {
			error: "cwd must be an absolute path",
		})
		.nullish(),
	all_projects: z.boolean({ error: "all_projects must be a boolean" }).nullish(),
	working_set_files: z
		.array(
			z.string({ error: "working_set_files must be an array of repository-relative strings" }),
			{
				error: "working_set_files must be an array of repository-relative strings",
			},
		)
		.max(MAX_WORKING_SET_FILES, {
			error: `working_set_files must contain at most ${MAX_WORKING_SET_FILES} entries`,
		})
		.nullish(),
	compact: z.boolean({ error: "compact must be a boolean" }).nullish(),
	compact_detail_count: z
		.number({ error: "compact_detail_count must be a non-negative int" })
		.int({ error: "compact_detail_count must be a non-negative int" })
		.nonnegative({ error: "compact_detail_count must be a non-negative int" })
		.nullish(),
	db_path: z.unknown().optional(),
	identity_target: z.unknown().optional(),
	attempt: attemptPayloadSchema.nullable().optional(),
	automatic_context: automaticContextPayloadSchema.nullable().optional(),
});

type AttemptPayload = z.infer<typeof attemptPayloadSchema>;
type LedgerPayload = z.infer<typeof ledgerPayloadSchema>;
type PackRequestPayload = z.infer<typeof packRequestPayloadSchema>;
type AutomaticContextPayload = z.infer<typeof automaticContextPayloadSchema>;

type ValidatedPackRequest = {
	context: string;
	limit: number;
	tokenBudget: number | null;
	filters: MemoryFilters;
	renderOptions?: PackRenderOptions;
	attempt?: AttemptPayload;
	automaticContext?: AutomaticContext | null;
};

function invalidRequest(message: string) {
	return { error: { code: "invalid_request", message } };
}

function viewerIdentityMismatch() {
	return {
		error: {
			code: "viewer_identity_mismatch",
			message: "viewer identity does not match request",
		},
	};
}

function viewerContractUnsupported() {
	return {
		error: {
			code: "viewer_contract_unsupported",
			message: "viewer request contract is incompatible",
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function firstUnknownKey(value: unknown, shape: Record<string, unknown>): string | null {
	if (!isRecord(value)) return null;
	return Object.keys(value).find((key) => !Object.hasOwn(shape, key)) ?? null;
}

function isAbsolutePath(value: string): boolean {
	return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function normalizeWorkingSetPath(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_WORKING_SET_PATH_CHARS || isAbsolutePath(trimmed)) {
		return null;
	}
	const normalized = posix.normalize(trimmed.replaceAll("\\", "/")).replace(/^\.\//, "");
	if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		return null;
	}
	return normalized;
}

function validateMetadataEnvelope(
	payload: Record<string, unknown>,
	shape: Record<string, unknown>,
): string | null {
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_LEDGER_PAYLOAD_BYTES) {
		return "ledger metadata exceeds 16384 bytes";
	}
	for (const key of Object.keys(payload)) {
		if (FORBIDDEN_LEDGER_KEYS.has(key)) return `ledger metadata rejects sensitive field: ${key}`;
		if (!Object.hasOwn(shape, key)) return `ledger metadata contains unsupported field: ${key}`;
	}
	return null;
}

function validateMetadataPaths(payload: AttemptPayload | LedgerPayload): string | null {
	for (const key of [
		"attempt_id",
		"started_at",
		"source",
		"stream_id",
		"source_session_id",
		"request_id",
		"failure_code",
		"failure_stage",
		"original_attempt_id",
	] as const) {
		const field = (payload as Record<string, unknown>)[key];
		if (typeof field === "string" && isAbsolutePath(field)) {
			return `ledger metadata rejects absolute paths in field: ${key}`;
		}
	}
	return null;
}

function attemptMetadata(payload: AttemptPayload | LedgerPayload): PromptPackAttemptMetadata {
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

function validateAutomaticContext(
	value: AutomaticContextPayload | null,
): AutomaticContext | null | string {
	if (value === null) return null;
	if (isAbsolutePath(value.host_session_id)) {
		return "automatic_context host_session_id is invalid";
	}
	return { source: value.source, hostSessionId: value.host_session_id };
}

function resolveRequestAutomaticContext(
	value: PackRequestPayload,
	attempt: AttemptPayload | undefined,
): AutomaticContext | null | undefined | string {
	if (Object.hasOwn(value, "automatic_context")) {
		const automaticContext = value.automatic_context;
		if (automaticContext === undefined) return "automatic_context must be an object or null";
		return validateAutomaticContext(automaticContext);
	}
	if (!attempt) return undefined;
	// Only the OpenCode plugin's older attempt metadata implies an automatic request.
	// Named non-OpenCode hook sources keep generic behavior so Viewer and their local
	// fallbacks agree; an attempt with no source is unknown origin and stays fail-closed.
	const source = typeof attempt.source === "string" ? attempt.source.trim().toLowerCase() : "";
	if (source && source !== "opencode") return undefined;
	const hostSessionId = attempt.source_session_id;
	if (source === "opencode" && typeof hostSessionId === "string" && hostSessionId.trim()) {
		return { source, hostSessionId: hostSessionId.trim() };
	}
	return null;
}

function packRenderOptions(value: PackRequestPayload): PackRenderOptions | undefined {
	if (value.compact == null && value.compact_detail_count == null) return undefined;
	return {
		compact: value.compact === true || value.compact_detail_count != null,
		...(value.compact_detail_count != null
			? { compactDetailCount: value.compact_detail_count as number }
			: {}),
	};
}

function packRequestArgs(request: ValidatedPackRequest) {
	return [
		request.context,
		request.limit,
		request.tokenBudget,
		request.filters,
		request.renderOptions,
		request.automaticContext,
	] as const;
}

function packSchemaError(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "request body must be an object";
	if (issue.code !== "unrecognized_keys") {
		return issue.path.length === 0 ? "request body must be an object" : issue.message;
	}
	const unexpectedKey = issue.keys[0] ?? "unknown";
	if (issue.path[0] === "attempt") {
		return `ledger metadata contains unsupported field: ${unexpectedKey}`;
	}
	if (issue.path[0] === "automatic_context") {
		return `automatic_context contains unsupported field: ${unexpectedKey}`;
	}
	return `request body contains unsupported field: ${unexpectedKey}`;
}

function normalizeWorkingSetFiles(values: string[]): string[] | string {
	const files: string[] = [];
	for (const value of values) {
		const normalized = normalizeWorkingSetPath(value);
		if (!normalized) return "working_set_files contains an invalid repository-relative path";
		if (!files.includes(normalized)) files.push(normalized);
	}
	return files;
}

function packFilters(request: PackRequestPayload, workingSetFiles: string[]): MemoryFilters {
	const filters: MemoryFilters = {};
	if (request.all_projects !== true) {
		const envProject = process.env.CODEMEM_PROJECT?.trim() || null;
		const project = resolveProject(
			request.cwd ?? process.cwd(),
			request.project ?? (request.cwd == null ? envProject : undefined),
		);
		if (project) filters.project = project;
	}
	if (workingSetFiles.length > 0) filters.working_set_paths = workingSetFiles;
	return filters;
}

function validatePackRequest(value: unknown): ValidatedPackRequest | string {
	const requestUnknownKey = firstUnknownKey(value, packRequestPayloadSchema.shape);
	if (requestUnknownKey) return `request body contains unsupported field: ${requestUnknownKey}`;
	if (isRecord(value) && isRecord(value.attempt)) {
		const attemptEnvelopeError = validateMetadataEnvelope(
			value.attempt,
			attemptPayloadSchema.shape,
		);
		if (attemptEnvelopeError) return attemptEnvelopeError;
	}
	const parsed = packRequestPayloadSchema.safeParse(value);
	if (!parsed.success) return packSchemaError(parsed.error);
	const request = parsed.data;
	if (request.attempt) {
		const attemptPathError = validateMetadataPaths(request.attempt);
		if (attemptPathError) return attemptPathError;
	}
	if (request.cwd != null && !isAbsolute(request.cwd)) return "cwd must be an absolute path";
	const workingSetFiles = normalizeWorkingSetFiles(request.working_set_files ?? []);
	if (typeof workingSetFiles === "string") return workingSetFiles;
	const attempt = request.attempt ?? undefined;
	const automaticContext = resolveRequestAutomaticContext(request, attempt);
	if (typeof automaticContext === "string") return automaticContext;

	return {
		context: request.context,
		limit: request.limit,
		tokenBudget: request.token_budget,
		filters: packFilters(request, workingSetFiles),
		renderOptions: packRenderOptions(request),
		attempt,
		automaticContext,
	};
}

function ledgerFailureStatus(reason: RetrievalLedgerFailureReason): 400 | 409 | 422 | 503 {
	if (reason === "idempotency_conflict") return 409;
	if (reason === "attempt_not_found") return 422;
	if (reason === "storage_unavailable") return 503;
	return 400;
}

function dispatchRecallMeasurement(
	store: MemoryStore,
	payload: LedgerPayload,
): AutomaticRecallWriteOutcome | string | null {
	const action = payload.action;
	if (payload.automatic_recall === undefined && action !== "recall") return null;
	const isValidMeasurement =
		isAutomaticRecallMeasurement(payload.automatic_recall) &&
		typeof payload.evaluation_key === "string" &&
		/^[a-f0-9]{64}$/.test(payload.evaluation_key);
	if (action === "delivery") {
		if (!isValidMeasurement) return null;
		try {
			recordAutomaticRecall(
				store.db,
				payload.attempt_id as string,
				payload.evaluation_key,
				payload.automatic_recall,
			);
		} catch {
			// Delivery diagnostics are best-effort after the receipt has been accepted.
		}
		return null;
	}
	if (action !== "recall" || !isValidMeasurement) {
		return "invalid automatic recall measurement";
	}
	return recordAutomaticRecall(
		store.db,
		payload.attempt_id as string,
		payload.evaluation_key,
		payload.automatic_recall,
	);
}

function dispatchLedger(store: MemoryStore, payload: LedgerPayload): LedgerOutcome | string {
	const action = payload.action;
	const metadata = attemptMetadata(payload);
	if (action === "delivery") {
		const status = payload.delivery_status;
		if (status !== "handed_off" && status !== "failed" && status !== "unknown") {
			return "delivery action requires a valid delivery_status";
		}
		const outcome = tryUpdateRetrievalDelivery(store.db, metadata.attemptId, status);
		if (outcome.ok) dispatchRecallMeasurement(store, payload);
		return outcome;
	}
	const measurement = dispatchRecallMeasurement(store, payload);
	if (measurement !== null) return measurement;
	if (action === "cache_reuse") {
		if (typeof payload.original_attempt_id !== "string" || !payload.original_attempt_id) {
			return "cache_reuse action requires original_attempt_id";
		}
		return clonePromptPackAttempt(store.db, payload.original_attempt_id, metadata);
	}
	if (action !== "record") return "ledger action is invalid";
	if (
		(payload.retrieval_status !== "skipped" && payload.retrieval_status !== "failed") ||
		typeof payload.failure_code !== "string" ||
		!payload.failure_code ||
		typeof payload.failure_stage !== "string" ||
		!payload.failure_stage
	) {
		return "record action requires retrieval_status, failure_code, and failure_stage";
	}
	return recordPromptPackTerminal(
		store.db,
		metadata,
		payload.retrieval_status,
		payload.failure_code,
		payload.failure_stage,
	);
}

type LedgerValidation =
	| { ok: true; payload: LedgerPayload }
	| {
			ok: false;
			status: 400 | 409;
			body: ReturnType<typeof invalidRequest> | ReturnType<typeof viewerContractUnsupported>;
	  };

function validateLedgerPayload(value: unknown): LedgerValidation {
	if (!isRecord(value)) {
		return { ok: false, status: 400, body: invalidRequest("request body must be an object") };
	}
	const validationError = validateMetadataEnvelope(value, ledgerPayloadSchema.shape);
	if (validationError?.startsWith("ledger metadata contains unsupported field:")) {
		return { ok: false, status: 409, body: viewerContractUnsupported() };
	}
	if (validationError) {
		return { ok: false, status: 400, body: invalidRequest(validationError) };
	}
	const parsed = ledgerPayloadSchema.safeParse(value);
	if (!parsed.success) {
		const message = parsed.error.issues[0]?.message ?? "request body must be an object";
		return { ok: false, status: 400, body: invalidRequest(message) };
	}
	const pathError = validateMetadataPaths(parsed.data);
	if (pathError) return { ok: false, status: 400, body: invalidRequest(pathError) };
	return { ok: true, payload: parsed.data };
}

async function handleLedgerRequest(c: Context, getStore: StoreFactory) {
	const body = await c.req.json().catch(() => INVALID_JSON);
	if (body === INVALID_JSON) return c.json(invalidRequest("invalid json body"), 400);
	const validated = validateLedgerPayload(body);
	if (!validated.ok) return c.json(validated.body, validated.status);
	try {
		const store = getStore();
		const target = validateViewerTarget(store, validated.payload, {
			requireCurrentIdentity: true,
		});
		if (!target.ok) return c.json(target.body, target.status);
		const outcome = dispatchLedger(store, validated.payload);
		if (typeof outcome === "string") return c.json(invalidRequest(outcome), 400);
		if (outcome.ok) return c.json(outcome);
		return c.json(outcome, ledgerFailureStatus(outcome.reason));
	} catch {
		return c.json(
			{ error: { code: "ledger_failed", message: "prompt-pack ledger operation failed" } },
			500,
		);
	}
}

function handleProfileRequest(c: Context, getStore: StoreFactory) {
	try {
		const store = getStore();
		if (!store.hasCurrentIdentity()) return c.json(viewerIdentityMismatch(), 409);
		return c.json({
			service: "codemem-viewer",
			protocol_version: PROMPT_TRANSPORT_PROTOCOL_RANGE.protocolVersion,
			min_supported_protocol_version: PROMPT_TRANSPORT_PROTOCOL_RANGE.minSupportedProtocolVersion,
			db_path: resolvePath(store.dbPath),
			identity_target: currentIdentityTarget(),
		});
	} catch {
		return c.json(
			{ error: { code: "profile_failed", message: "viewer profile could not be read" } },
			500,
		);
	}
}

export function packTransportRoutes(getStore: StoreFactory) {
	const app = new Hono();

	app.get("/api/prompt-pack-profile", (c) => handleProfileRequest(c, getStore));

	app.post("/api/pack", async (c) => {
		const parsed = await c.req.json().catch(() => INVALID_JSON);
		if (parsed === INVALID_JSON) return c.json(invalidRequest("invalid json body"), 400);
		const request = validatePackRequest(parsed);
		if (typeof request === "string") {
			if (request.startsWith("request body contains unsupported field:"))
				return c.json(viewerContractUnsupported(), 409);
			return c.json(invalidRequest(request), 400);
		}
		try {
			const store = getStore();
			const target = validateViewerTarget(store, parsed, { requireCurrentIdentity: true });
			if (!target.ok) return c.json(target.body, target.status);
			if (!request.attempt) {
				const pack = await store.buildMemoryPackAsync(...packRequestArgs(request));
				return c.json(pack);
			}
			const artifacts = await store.buildMemoryPackWithTraceAsync(...packRequestArgs(request));
			let ledgerArtifactFingerprint: string | undefined;
			try {
				ledgerArtifactFingerprint = promptPackArtifactFingerprint(
					store.db,
					request.context,
					request.filters,
					artifacts,
				);
			} catch {
				// Fingerprinting is instrumentation and must not block pack delivery.
			}
			let ledgerOutcome: RetrievalLedgerWriteOutcome | undefined;
			try {
				ledgerOutcome = recordPromptPackArtifacts(
					store.db,
					attemptMetadata(request.attempt),
					request.context,
					request.filters,
					artifacts,
				);
			} catch {
				// Ledger instrumentation is best-effort and must not block pack delivery.
			}
			return c.json({
				...artifacts.response,
				...(ledgerArtifactFingerprint
					? { ledger_artifact_fingerprint: ledgerArtifactFingerprint }
					: {}),
				...(ledgerOutcome?.ok === false && ledgerOutcome.reason === "idempotency_conflict"
					? { ledger_outcome: ledgerOutcome }
					: {}),
			});
		} catch {
			return c.json(
				{ error: { code: "pack_failed", message: "memory pack could not be built" } },
				500,
			);
		}
	});

	app.post("/api/prompt-pack-ledger", (c) => handleLedgerRequest(c, getStore));

	return app;
}
