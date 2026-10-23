import { posix, win32 } from "node:path";
import * as z from "zod";
import { createFileContextRunner } from "./file-context.js";
import { getRetrievalAttempt, tryUpdateRetrievalDelivery } from "./retrieval-ledger.js";
import type { MemoryStore } from "./store.js";

/** Capability, not package version: older builds can share a prerelease version. */
export const FILE_CONTEXT_TRANSPORT_PROFILE = Object.freeze({
	file_context_transport: 1,
	visibility_enforced: true,
	deferred_delivery: true,
});
export const FILE_CONTEXT_TRANSPORT_MAX_BYTES = 16_384;

function repositoryPath(value: string): boolean {
	if (!value || posix.isAbsolute(value) || win32.isAbsolute(value)) return false;
	const normalized = posix.normalize(value.replaceAll("\\", "/"));
	return normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

const pathSchema = z.string().max(1024).refine(repositoryPath);
const sessionSchema = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.refine((value) => !posix.isAbsolute(value) && !win32.isAbsolute(value))
	.nullable();
const base = {
	attempt_id: z.uuid(),
	request_id: z.string().regex(/^claude-file-context\/(http|cli|npx)\/[a-f0-9-]{36}$/),
	source_session_id: sessionSchema,
	ledger_enabled: z.boolean(),
	db_path: z.string().trim().min(1).max(4096),
	identity_target: z
		.unknown()
		.refine((value) => value != null && typeof value === "object" && !Array.isArray(value)),
};
const requestSchema = z.discriminatedUnion("action", [
	z.strictObject({
		...base,
		action: z.literal("lookup"),
		relative_path: pathSchema,
		project: z.string().trim().min(1).max(512).nullable(),
		file_mtime_ms: z.number(),
	}),
	z.strictObject({
		...base,
		action: z.literal("skip"),
		reason: z.enum(["file_context_disabled", "outside_cwd", "stat_failed", "below_size_gate"]),
		repository_paths: z.array(pathSchema).max(1).optional(),
	}),
	z.strictObject({
		...base,
		action: z.literal("delivery"),
		delivery_status: z.enum(["handed_off", "failed"]),
	}),
]);

export type FileContextTransportRequest = z.infer<typeof requestSchema>;

/** Shared CLI/HTTP boundary: reject shape and action before acquiring a store. */
export function parseFileContextTransportRequest(value: unknown) {
	return requestSchema.safeParse(value);
}

function acknowledgeDelivery(store: MemoryStore, request: FileContextTransportRequest) {
	if (request.action !== "delivery" || !request.ledger_enabled) return { ok: true };
	const attempt = getRetrievalAttempt(store.db, request.attempt_id);
	if (
		attempt?.source !== "claude" ||
		attempt.surface !== "file_context" ||
		attempt.requestId !== request.request_id ||
		attempt.sourceSessionId !== request.source_session_id
	)
		return { ok: false };
	return {
		ok: tryUpdateRetrievalDelivery(store.db, request.attempt_id, request.delivery_status).ok,
	};
}

/** Caller must validate database/runtime identity before dispatching. No store is closed here. */
export function dispatchFileContextTransport(
	store: MemoryStore,
	request: FileContextTransportRequest,
) {
	if (request.action === "delivery") return acknowledgeDelivery(store, request);
	let inserted = false;
	const runner = createFileContextRunner({
		getStore: () => store,
		sourceSessionId: request.source_session_id,
		requestId: request.request_id,
		createAttemptId: () => request.attempt_id,
		ledgerEnabled: () => request.ledger_enabled,
		deferDelivery: true,
		updateDelivery: (attemptId, status) => {
			// A formatting failure on a replay must not change the original attempt.
			if (inserted) tryUpdateRetrievalDelivery(store.db, attemptId, status);
		},
		onRecorded: (outcome) => {
			inserted = outcome.ok && outcome.value.inserted;
		},
	});
	const result =
		request.action === "skip"
			? runner.skip({ reason: request.reason, repositoryPaths: request.repository_paths })
			: runner.run({
					relativePath: request.relative_path,
					project: request.project,
					fileMtimeMs: request.file_mtime_ms,
				});
	return {
		ok: true,
		attempt_id: request.attempt_id,
		request_id: request.request_id,
		result,
		// A conflicting/replayed attempt must never acknowledge another selection.
		delivery_pending: inserted && result.hookSpecificOutput != null,
	};
}
