import { resolve } from "node:path";
import { buildViewerIdentityTarget, expandUserPath } from "@codemem/core";
import {
	RawEventSpoolInspectionError,
	type RejectedRawEventAcknowledgement,
} from "../../../opencode-plugin/.opencode/lib/raw-event-spool.js";
import {
	preflightRetry,
	RetryError,
	type RetryTarget,
	requestRetryJson,
} from "./capture-recovery-http.js";
import { shouldForceBoundaryFlush } from "./claude-hook-ingest-spool.js";
import {
	inspectNativeHookRejectedReceipt,
	type NativeHookProvider,
	type NativeHookRecoveryResult,
	recoverNativeHookReceipt,
} from "./native-hook-retained-spool.js";
import { shouldForcePiBoundaryFlush } from "./pi-hook-ingest-spool.js";
import { viewerBaseUrl } from "./viewer-http-target.js";

export interface RetryNativeHookReceiptOptions {
	provider: NativeHookProvider;
	dbPath?: string;
	yes?: boolean;
	keepReceipt?: boolean;
}
export interface RetryNativeHookReceiptDeps {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}
export type RetryNativeHookReceiptResult =
	| { ok: true; recovery: NativeHookRecoveryResult }
	| {
			ok: false;
			error: string;
			message: string;
			exitCode: 1 | 2;
			recovery?: NativeHookRecoveryResult;
	  };

function nativePayload(serialized: string, provider: NativeHookProvider): Record<string, unknown> {
	const payload: unknown = JSON.parse(serialized);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new RetryError("invalid", "The retained hook must be a JSON object.");
	}
	if (provider === "pi" && Object.hasOwn(payload, "_codememBoundaryThroughEventSeq")) {
		throw new RetryError(
			"pi_boundary_snapshot_unsupported",
			"HTTP recovery cannot preserve this Pi boundary snapshot. The receipt was left untouched.",
		);
	}
	return payload as Record<string, unknown>;
}

function checkedNativeRequest(
	serialized: string,
	provider: NativeHookProvider,
	target: RetryTarget,
	maxBytes: number,
): { body: string; piBoundary: boolean; headers: Record<string, string> } {
	const payload = nativePayload(serialized, provider);
	const body = JSON.stringify({ ...payload, ...target });
	if (Buffer.byteLength(body, "utf8") > maxBytes) {
		throw new RetryError(
			"payload_too_large",
			"The complete retry request exceeds the viewer size limit. The event was retained.",
		);
	}
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (provider === "claude" && shouldForceBoundaryFlush(payload)) {
		headers["X-Codemem-Boundary-Flush"] = "1";
	}
	return { body, headers, piBoundary: provider === "pi" && shouldForcePiBoundaryFlush(payload) };
}

function nativeAcknowledgement(
	status: number,
	body: unknown,
	piBoundary: boolean,
): RejectedRawEventAcknowledgement | false {
	if (!body || typeof body !== "object" || Array.isArray(body) || Object.hasOwn(body, "error"))
		return false;
	const result = body as Record<string, unknown>;
	if (status === 202 && result.accepted === 1 && result.queued === 1) {
		return { acknowledged: true, acknowledgement: "queued" };
	}
	if (!piBoundary && status === 200 && result.inserted === 1 && result.skipped === 0) {
		return { acknowledged: true, acknowledgement: "ingested" };
	}
	return false;
}

type NativeRetryContext = {
	baseUrl: string;
	target: RetryTarget;
	maxBytes: number;
};

async function prepareNativeRetry(
	receipt: string,
	opts: RetryNativeHookReceiptOptions,
	deps: RetryNativeHookReceiptDeps,
): Promise<NativeRetryContext> {
	if (!opts.dbPath?.trim() || opts.yes !== true || !receipt) {
		throw new RetryError(
			"usage_error",
			"Select a receipt, pass --db-path, and confirm delivery to the current target with -y. Original target provenance is unknown.",
			2,
		);
	}
	if (!["claude", "codex", "pi"].includes(opts.provider)) {
		throw new RetryError("usage_error", "Select --provider claude, codex, or pi.", 2);
	}
	const env = deps.env ?? process.env;
	const baseUrl = viewerBaseUrl(env, { rejectInvalidPort: true });
	if (!baseUrl) {
		throw new RetryError(
			"invalid_target",
			"The viewer must use an approved loopback host and a valid port.",
			2,
		);
	}
	const entry = inspectNativeHookRejectedReceipt({ provider: opts.provider, receipt });
	if (entry.validation !== "valid") {
		throw new RetryError(
			entry.validation,
			"The retained hook could not be read safely. It was left untouched.",
		);
	}
	nativePayload(entry.serialized, opts.provider);
	const target = {
		db_path: resolve(expandUserPath(opts.dbPath)),
		identity_target: buildViewerIdentityTarget(env),
	};
	const maxBytes = await preflightRetry(baseUrl, target, deps.fetchImpl ?? fetch);
	checkedNativeRequest(entry.serialized, opts.provider, target, maxBytes);
	return { baseUrl, target, maxBytes };
}

function recoveryMessage(recovery: NativeHookRecoveryResult): string {
	if (recovery.delivery === "accepted") {
		return "The viewer acknowledged the event, but local cleanup needs inspection. Do not retry blindly.";
	}
	if (recovery.delivery === "not_attempted") {
		return "Recovery did not send the event. Inspect the retained receipt and recovery status.";
	}
	return "No valid acknowledgement was received. The event was retained, but the viewer may already have accepted it.";
}

async function recoverNativeWithHttp(
	receipt: string,
	opts: RetryNativeHookReceiptOptions,
	deps: RetryNativeHookReceiptDeps,
	context: NativeRetryContext,
): Promise<RetryNativeHookReceiptResult> {
	let failure: RetryError | undefined;
	const recovery = await recoverNativeHookReceipt({
		provider: opts.provider,
		receipt,
		keepReceipt: opts.keepReceipt,
		deliver: async ({ serialized }) => {
			try {
				// Recheck the locked snapshot, not the earlier inspection, before any POST.
				const request = checkedNativeRequest(
					serialized,
					opts.provider,
					context.target,
					context.maxBytes,
				);
				const response = await requestRetryJson(
					deps.fetchImpl ?? fetch,
					`${context.baseUrl}/api/${opts.provider}-hooks`,
					{ method: "POST", headers: request.headers, body: request.body },
				);
				return nativeAcknowledgement(response.status, response.body, request.piBoundary);
			} catch (error) {
				if (error instanceof RetryError) failure = error;
				throw error;
			}
		},
	});
	if (
		recovery.delivery === "accepted" &&
		(recovery.cleanup === "removed" || recovery.cleanup === "kept") &&
		recovery.lock === "released"
	)
		return { ok: true, recovery };
	return {
		ok: false,
		error: failure?.code ?? "retry_incomplete",
		message: failure?.message ?? recoveryMessage(recovery),
		exitCode: 1,
		recovery,
	};
}

export async function retryNativeHookReceipt(
	receipt: string,
	opts: RetryNativeHookReceiptOptions,
	deps: RetryNativeHookReceiptDeps = {},
): Promise<RetryNativeHookReceiptResult> {
	try {
		const context = await prepareNativeRetry(receipt, opts, deps);
		return await recoverNativeWithHttp(receipt, opts, deps, context);
	} catch (error) {
		if (error instanceof RetryError) {
			return { ok: false, error: error.code, message: error.message, exitCode: error.exitCode };
		}
		if (error instanceof RawEventSpoolInspectionError) {
			return {
				ok: false,
				error: error.code,
				message: error.message,
				exitCode: error.code === "invalid_receipt" ? 2 : 1,
			};
		}
		return {
			ok: false,
			error: "retry_preflight_failed",
			message: "Retry could not finish. Inspect the retained receipt before retrying.",
			exitCode: 1,
		};
	}
}
