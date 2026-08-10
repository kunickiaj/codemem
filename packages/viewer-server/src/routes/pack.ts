import { homedir } from "node:os";
import { isAbsolute, posix, resolve as resolvePath, win32 } from "node:path";
import type {
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
	promptPackArtifactFingerprint,
	recordPromptPackArtifacts,
	recordPromptPackTerminal,
	resolveDbPath,
	resolveProject,
	tryUpdateRetrievalDelivery,
} from "@codemem/core";
import { Hono } from "hono";

type StoreFactory = () => MemoryStore;
type LedgerOutcome = RetrievalLedgerWriteOutcome | RetrievalLedgerDeliveryOutcome;

const MAX_LEDGER_PAYLOAD_BYTES = 16 * 1024;
const MAX_METADATA_FIELD_CHARS = 512;
const MAX_WORKING_SET_FILES = 50;
const MAX_WORKING_SET_PATH_CHARS = 512;
const INVALID_JSON = Symbol("invalid-json");

const PACK_KEYS = new Set([
	"context",
	"limit",
	"token_budget",
	"project",
	"cwd",
	"all_projects",
	"working_set_files",
	"compact",
	"compact_detail_count",
	"db_path",
	"identity_target",
	"attempt",
]);
const LEDGER_KEYS = new Set([
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
	"db_path",
	"identity_target",
]);
const IDENTITY_TARGET_KEYS = new Set([
	"device_id",
	"actor_id_present",
	"actor_id",
	"config_path",
	"runtime_root",
	"workspace_id",
	"home_dir",
	"pack_compression",
	"embedding_disabled",
	"embedding_model",
]);
const BOOLEAN_IDENTITY_TARGET_KEYS = new Set(["actor_id_present", "embedding_disabled"]);
const ATTEMPT_KEYS = new Set([
	"attempt_id",
	"started_at",
	"source",
	"stream_id",
	"source_session_id",
	"prompt_number",
	"request_id",
]);
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

type ValidatedPackRequest = {
	context: string;
	limit: number;
	tokenBudget: number | null;
	filters: MemoryFilters;
	renderOptions?: PackRenderOptions;
	attempt?: Record<string, unknown>;
};

function invalidRequest(message: string) {
	return { error: { code: "invalid_request", message } };
}

function viewerDbMismatch() {
	return {
		error: {
			code: "viewer_db_mismatch",
			message: "viewer database does not match request",
		},
	};
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

function requestedDbMatches(store: MemoryStore, value: unknown): boolean | null {
	if (value == null) return true;
	if (typeof value !== "string" || !value.trim()) return null;
	return resolvePath(resolveDbPath(value)) === resolvePath(store.dbPath);
}

function normalizeIdentityPath(value: string | undefined): string | null {
	if (!value?.trim()) return null;
	return resolvePath(resolveDbPath(value.trim()));
}

function currentIdentityTarget(): Record<string, string | boolean | null> {
	return {
		device_id: process.env.CODEMEM_DEVICE_ID?.trim() || null,
		actor_id_present: Object.hasOwn(process.env, "CODEMEM_ACTOR_ID"),
		actor_id: process.env.CODEMEM_ACTOR_ID?.trim() || null,
		config_path: normalizeIdentityPath(process.env.CODEMEM_CONFIG),
		runtime_root: normalizeIdentityPath(process.env.CODEMEM_RUNTIME_ROOT),
		workspace_id: process.env.CODEMEM_WORKSPACE_ID?.trim() || null,
		home_dir: normalizeIdentityPath(process.env.HOME || homedir()),
		pack_compression: process.env.CODEMEM_PACK_COMPRESSION?.trim() || null,
		embedding_disabled: ["1", "true", "yes"].includes(
			String(process.env.CODEMEM_EMBEDDING_DISABLED || "").toLowerCase(),
		),
		embedding_model: process.env.CODEMEM_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5",
	};
}

function requestedIdentityMatches(value: unknown): boolean | null | "unsupported" {
	if (value == null) return true;
	if (!isRecord(value)) return null;
	if (
		Object.keys(value).length !== IDENTITY_TARGET_KEYS.size ||
		Object.keys(value).some((key) => !IDENTITY_TARGET_KEYS.has(key))
	)
		return "unsupported";
	const expected = currentIdentityTarget();
	for (const key of IDENTITY_TARGET_KEYS) {
		const requested = value[key];
		if (BOOLEAN_IDENTITY_TARGET_KEYS.has(key)) {
			if (typeof requested !== "boolean") return null;
		} else if (requested !== null && typeof requested !== "string") {
			return null;
		}
		if (requested !== expected[key]) return false;
	}
	return true;
}

function validateMetadataFields(
	payload: Record<string, unknown>,
	allowedKeys: ReadonlySet<string>,
): string | null {
	if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_LEDGER_PAYLOAD_BYTES) {
		return "ledger metadata exceeds 16384 bytes";
	}
	for (const key of Object.keys(payload)) {
		if (FORBIDDEN_LEDGER_KEYS.has(key)) return `ledger metadata rejects sensitive field: ${key}`;
		if (!allowedKeys.has(key)) return `ledger metadata contains unsupported field: ${key}`;
	}
	if (typeof payload.attempt_id !== "string" || payload.attempt_id.length === 0) {
		return "ledger metadata requires attempt_id";
	}
	if (
		payload.prompt_number != null &&
		(typeof payload.prompt_number !== "number" ||
			!Number.isInteger(payload.prompt_number) ||
			payload.prompt_number < 0)
	) {
		return "ledger metadata prompt_number must be a non-negative integer";
	}
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
		const field = payload[key];
		if (field != null && (typeof field !== "string" || field.length > MAX_METADATA_FIELD_CHARS)) {
			return `ledger metadata field ${key} is invalid`;
		}
		if (typeof field === "string" && isAbsolutePath(field)) {
			return `ledger metadata rejects absolute paths in field: ${key}`;
		}
	}
	return null;
}

function attemptMetadata(payload: Record<string, unknown>): PromptPackAttemptMetadata {
	return {
		attemptId: payload.attempt_id as string,
		startedAt: (payload.started_at as string | undefined) ?? new Date().toISOString(),
		completedAt: new Date().toISOString(),
		source: (payload.source as string | undefined) ?? "opencode",
		streamId: (payload.stream_id as string | undefined) ?? null,
		sourceSessionId: (payload.source_session_id as string | undefined) ?? null,
		promptNumber: (payload.prompt_number as number | undefined) ?? null,
		requestId: (payload.request_id as string | undefined) ?? null,
	};
}

function validatePackRequest(value: unknown): ValidatedPackRequest | string {
	if (!isRecord(value)) return "request body must be an object";
	for (const key of Object.keys(value)) {
		if (!PACK_KEYS.has(key)) return `request body contains unsupported field: ${key}`;
	}
	const context = typeof value.context === "string" ? value.context.trim() : "";
	if (!context) return "context required";
	const limit = value.limit ?? 10;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
		return "limit must be a positive int";
	}
	const tokenBudget = value.token_budget ?? null;
	if (
		tokenBudget !== null &&
		(typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget) || tokenBudget < 0)
	) {
		return "token_budget must be a non-negative int";
	}
	if (value.all_projects != null && typeof value.all_projects !== "boolean") {
		return "all_projects must be a boolean";
	}
	if (value.project != null && (typeof value.project !== "string" || !value.project.trim())) {
		return "project must be a non-empty string";
	}
	if (
		value.cwd != null &&
		(typeof value.cwd !== "string" || !value.cwd.trim() || !isAbsolute(value.cwd))
	) {
		return "cwd must be an absolute path";
	}
	if (value.working_set_files != null && !Array.isArray(value.working_set_files)) {
		return "working_set_files must be an array of repository-relative strings";
	}
	const workingSetValues = (value.working_set_files ?? []) as unknown[];
	if (workingSetValues.length > MAX_WORKING_SET_FILES) {
		return `working_set_files must contain at most ${MAX_WORKING_SET_FILES} entries`;
	}
	const workingSetFiles: string[] = [];
	for (const entry of workingSetValues) {
		if (typeof entry !== "string") {
			return "working_set_files must be an array of repository-relative strings";
		}
		const normalized = normalizeWorkingSetPath(entry);
		if (!normalized) return "working_set_files contains an invalid repository-relative path";
		if (!workingSetFiles.includes(normalized)) workingSetFiles.push(normalized);
	}
	if (value.compact != null && typeof value.compact !== "boolean") {
		return "compact must be a boolean";
	}
	if (
		value.compact_detail_count != null &&
		(typeof value.compact_detail_count !== "number" ||
			!Number.isInteger(value.compact_detail_count) ||
			value.compact_detail_count < 0)
	) {
		return "compact_detail_count must be a non-negative int";
	}
	let attempt: Record<string, unknown> | undefined;
	if (value.attempt != null) {
		if (!isRecord(value.attempt)) return "attempt must be an object";
		const attemptError = validateMetadataFields(value.attempt, ATTEMPT_KEYS);
		if (attemptError) return attemptError;
		attempt = value.attempt;
	}

	const filters: MemoryFilters = {};
	if (value.all_projects !== true) {
		const envProject = process.env.CODEMEM_PROJECT?.trim() || null;
		const requestCwd = value.cwd as string | undefined;
		const requestProject = value.project as string | undefined;
		const project = resolveProject(
			requestCwd ?? process.cwd(),
			requestProject ?? (requestCwd == null ? envProject : undefined),
		);
		if (project) filters.project = project;
	}
	if (workingSetFiles.length > 0) filters.working_set_paths = workingSetFiles;

	let renderOptions: PackRenderOptions | undefined;
	if (value.compact != null || value.compact_detail_count != null) {
		renderOptions = {
			compact: value.compact === true || value.compact_detail_count != null,
			...(value.compact_detail_count != null
				? { compactDetailCount: value.compact_detail_count as number }
				: {}),
		};
	}
	return {
		context,
		limit,
		tokenBudget: tokenBudget as number | null,
		filters,
		renderOptions,
		attempt,
	};
}

function ledgerFailureStatus(reason: RetrievalLedgerFailureReason): 400 | 409 | 422 | 503 {
	if (reason === "idempotency_conflict") return 409;
	if (reason === "attempt_not_found") return 422;
	if (reason === "storage_unavailable") return 503;
	return 400;
}

function dispatchLedger(
	store: MemoryStore,
	payload: Record<string, unknown>,
): LedgerOutcome | string {
	const action = payload.action;
	if (action !== "record" && action !== "delivery" && action !== "cache_reuse") {
		return "ledger action is invalid";
	}
	const metadata = attemptMetadata(payload);
	if (action === "delivery") {
		const status = payload.delivery_status;
		if (status !== "handed_off" && status !== "failed" && status !== "unknown") {
			return "delivery action requires a valid delivery_status";
		}
		return tryUpdateRetrievalDelivery(store.db, metadata.attemptId, status);
	}
	if (action === "cache_reuse") {
		if (typeof payload.original_attempt_id !== "string" || !payload.original_attempt_id) {
			return "cache_reuse action requires original_attempt_id";
		}
		return clonePromptPackAttempt(store.db, payload.original_attempt_id, metadata);
	}
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

export function packTransportRoutes(getStore: StoreFactory) {
	const app = new Hono();

	app.get("/api/prompt-pack-profile", (c) => {
		try {
			const store = getStore();
			if (!store.hasCurrentIdentity()) return c.json(viewerIdentityMismatch(), 409);
			return c.json({
				service: "codemem-viewer",
				protocol_version: 1,
				db_path: resolvePath(store.dbPath),
				identity_target: currentIdentityTarget(),
			});
		} catch {
			return c.json(
				{ error: { code: "profile_failed", message: "viewer profile could not be read" } },
				500,
			);
		}
	});

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
			const dbMatches = requestedDbMatches(store, parsed.db_path);
			if (dbMatches == null)
				return c.json(invalidRequest("db_path must be a non-empty string"), 400);
			if (!dbMatches) return c.json(viewerDbMismatch(), 409);
			const identityMatches = requestedIdentityMatches(parsed.identity_target);
			if (identityMatches === "unsupported") return c.json(viewerContractUnsupported(), 409);
			if (identityMatches == null) return c.json(invalidRequest("identity_target is invalid"), 400);
			if (!identityMatches) return c.json(viewerIdentityMismatch(), 409);
			if (!store.hasCurrentIdentity()) return c.json(viewerIdentityMismatch(), 409);
			if (!request.attempt) {
				const pack = await store.buildMemoryPackAsync(
					request.context,
					request.limit,
					request.tokenBudget,
					request.filters,
					request.renderOptions,
				);
				return c.json(pack);
			}
			const artifacts = await store.buildMemoryPackWithTraceAsync(
				request.context,
				request.limit,
				request.tokenBudget,
				request.filters,
				request.renderOptions,
			);
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

	app.post("/api/prompt-pack-ledger", async (c) => {
		const parsed = await c.req.json().catch(() => INVALID_JSON);
		if (parsed === INVALID_JSON) return c.json(invalidRequest("invalid json body"), 400);
		if (!isRecord(parsed)) return c.json(invalidRequest("request body must be an object"), 400);
		const validationError = validateMetadataFields(parsed, LEDGER_KEYS);
		if (validationError) {
			if (validationError.startsWith("ledger metadata contains unsupported field:"))
				return c.json(viewerContractUnsupported(), 409);
			return c.json(invalidRequest(validationError), 400);
		}
		try {
			const store = getStore();
			const dbMatches = requestedDbMatches(store, parsed.db_path);
			if (dbMatches == null)
				return c.json(invalidRequest("db_path must be a non-empty string"), 400);
			if (!dbMatches) return c.json(viewerDbMismatch(), 409);
			const identityMatches = requestedIdentityMatches(parsed.identity_target);
			if (identityMatches === "unsupported") return c.json(viewerContractUnsupported(), 409);
			if (identityMatches == null) return c.json(invalidRequest("identity_target is invalid"), 400);
			if (!identityMatches) return c.json(viewerIdentityMismatch(), 409);
			if (!store.hasCurrentIdentity()) return c.json(viewerIdentityMismatch(), 409);
			const outcome = dispatchLedger(store, parsed);
			if (typeof outcome === "string") return c.json(invalidRequest(outcome), 400);
			if (outcome.ok) return c.json(outcome);
			return c.json(outcome, ledgerFailureStatus(outcome.reason));
		} catch {
			return c.json(
				{ error: { code: "ledger_failed", message: "prompt-pack ledger operation failed" } },
				500,
			);
		}
	});

	return app;
}
