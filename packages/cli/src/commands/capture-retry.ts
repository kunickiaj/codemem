import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	arePromptTransportProtocolRangesCompatible,
	buildViewerIdentityTarget,
	expandUserPath,
	normalizePromptTransportProtocolRange,
	PROMPT_TRANSPORT_PROTOCOL_RANGE,
} from "@codemem/core";
import {
	inspectRejectedRawEventSpoolEntry,
	RawEventSpoolInspectionError,
	type RejectedRawEventAcknowledgement,
	type RejectedRawEventRecoveryResult,
	recoverRejectedRawEventSpoolEntry,
} from "../../../opencode-plugin/.opencode/lib/raw-event-spool.js";
import { viewerBaseUrl } from "./viewer-http-target.js";

export interface RetryRejectedEventOptions {
	dbPath?: string;
	yes?: boolean;
	keepReceipt?: boolean;
}

export interface RetryRejectedEventDeps {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	fetchImpl?: typeof fetch;
}

export type RetryRejectedEventResult =
	| { ok: true; recovery: RejectedRawEventRecoveryResult }
	| {
			ok: false;
			error: string;
			message: string;
			exitCode: 1 | 2;
			recovery?: RejectedRawEventRecoveryResult;
	  };

class RetryError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly exitCode: 1 | 2 = 1,
	) {
		super(message);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

type RetryTarget = {
	db_path: string;
	identity_target: ReturnType<typeof buildViewerIdentityTarget>;
};

/** Copy only request defaults. The event itself stays verbatim inside the batch. */
export function buildRejectedEventBatchBody(serialized: string, target: RetryTarget): string {
	const event: unknown = JSON.parse(serialized);
	if (!isRecord(event) || event.events != null) {
		throw new RetryError("invalid_event", "The retained event is not a single flat event.");
	}
	const defaults: Record<string, unknown> = {};
	for (const key of [
		"source",
		"session_stream_id",
		"session_id",
		"stream_id",
		"opencode_session_id",
		"cwd",
		"project",
		"started_at",
	]) {
		if (Object.hasOwn(event, key)) defaults[key] = event[key];
	}
	const prefix = JSON.stringify({ ...defaults, ...target });
	return `${prefix.slice(0, -1)},"events":[${serialized}]}`;
}

/** Only the two current raw-events route responses authorize spool cleanup. */
export function rejectedEventAcknowledgement(
	status: number,
	body: unknown,
): RejectedRawEventAcknowledgement | false {
	if (!isRecord(body) || Object.hasOwn(body, "error")) return false;
	if (status === 202 && body.accepted === 1 && body.queued === 1) {
		return { acknowledged: true, acknowledgement: "queued" };
	}
	if (
		status === 200 &&
		body.received === 1 &&
		Number.isSafeInteger(body.inserted) &&
		Number.isSafeInteger(body.skipped) &&
		typeof body.inserted === "number" &&
		typeof body.skipped === "number" &&
		body.inserted >= 0 &&
		body.skipped >= 0 &&
		body.inserted + body.skipped === 1
	) {
		return { acknowledged: true, acknowledgement: "ingested" };
	}
	return false;
}

function validateRetryProfile(profile: unknown, target: RetryTarget): void {
	const range = isRecord(profile)
		? normalizePromptTransportProtocolRange(
				profile.protocol_version,
				profile.min_supported_protocol_version,
			)
		: null;
	if (
		!isRecord(profile) ||
		profile.service !== "codemem-viewer" ||
		!range ||
		!arePromptTransportProtocolRangesCompatible(PROMPT_TRANSPORT_PROTOCOL_RANGE, range)
	) {
		throw new RetryError("profile_invalid", "The current viewer profile is incompatible.");
	}
	if (profile.db_path !== target.db_path) {
		throw new RetryError("target_mismatch", "The viewer does not serve the selected database.");
	}
	if (!isDeepStrictEqual(profile.identity_target, target.identity_target)) {
		throw new RetryError("identity_mismatch", "The viewer identity does not match this runtime.");
	}
}

async function requestRetryJson(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
	const response = await fetchImpl(url, {
		...init,
		redirect: "error",
		signal: AbortSignal.timeout(2000),
	});
	if (
		response.redirected ||
		(response.url && new URL(response.url).origin !== new URL(url).origin)
	) {
		throw new RetryError("unexpected_origin", "The viewer response came from another origin.");
	}
	return { status: response.status, body: await response.json() };
}

async function preflightRetry(
	baseUrl: string,
	target: RetryTarget,
	fetchImpl: typeof fetch,
): Promise<number> {
	const profile = await requestRetryJson(fetchImpl, `${baseUrl}/api/prompt-pack-profile`);
	if (profile.status !== 200) {
		throw new RetryError("profile_unavailable", "Could not verify the current viewer profile.");
	}
	validateRetryProfile(profile.body, target);
	const status = await requestRetryJson(fetchImpl, `${baseUrl}/api/raw-events/status?limit=0`);
	const ingest = isRecord(status.body) ? status.body.ingest : null;
	if (
		status.status !== 200 ||
		!isRecord(ingest) ||
		ingest.available !== true ||
		!Number.isSafeInteger(ingest.max_body_bytes) ||
		typeof ingest.max_body_bytes !== "number" ||
		ingest.max_body_bytes <= 0
	) {
		throw new RetryError(
			"ingest_unavailable",
			"The viewer did not advertise available ingest and a size limit.",
		);
	}
	return ingest.max_body_bytes;
}

function checkedBatchBody(serialized: string, target: RetryTarget, maxBytes: number): string {
	const body = buildRejectedEventBatchBody(serialized, target);
	if (Buffer.byteLength(body, "utf8") > maxBytes) {
		throw new RetryError(
			"payload_too_large",
			"The complete retry request exceeds the viewer size limit. The event was retained.",
		);
	}
	return body;
}

async function recoverWithHttp(
	receipt: string,
	context: { baseUrl: string; target: RetryTarget; maxBytes: number; keepReceipt?: boolean },
	deps: RetryRejectedEventDeps,
): Promise<RetryRejectedEventResult> {
	let failure: RetryError | undefined;
	const recovery = await recoverRejectedRawEventSpoolEntry({
		receipt,
		homeDir: deps.homeDir,
		keepReceipt: context.keepReceipt,
		deliver: async ({ serialized }) => {
			try {
				const body = checkedBatchBody(serialized, context.target, context.maxBytes);
				const response = await requestRetryJson(
					deps.fetchImpl ?? fetch,
					`${context.baseUrl}/api/raw-events`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body,
					},
				);
				return rejectedEventAcknowledgement(response.status, response.body);
			} catch (error) {
				if (error instanceof RetryError) failure = error;
				return false;
			}
		},
	});
	if (
		recovery.delivery === "accepted" &&
		(recovery.cleanup === "removed" || recovery.cleanup === "kept") &&
		recovery.lock === "released"
	) {
		return { ok: true, recovery };
	}
	return {
		ok: false,
		error: failure?.code ?? "retry_incomplete",
		message: failure?.message ?? recoveryMessage(recovery),
		exitCode: 1,
		recovery,
	};
}

function recoveryMessage(recovery: RejectedRawEventRecoveryResult): string {
	if (recovery.delivery === "accepted") {
		return "The viewer acknowledged the event, but local cleanup needs inspection. Do not retry blindly.";
	}
	if (recovery.delivery === "not_attempted") {
		return "Recovery did not send the event. Inspect the retained receipt and recovery status.";
	}
	return "No valid acknowledgement was received. The event was retained, but the viewer may already have accepted it.";
}

const inspectionFailureMessages = {
	changed_during_read:
		"The file changed while reading. Retry inspection. The file was left untouched.",
	read_limit_exceeded:
		"Raw event text exceeds the 16 MiB inspection limit. The file was left untouched.",
	invalid: "Raw event text failed validation. The file was left untouched.",
};

export async function retryRejectedEvent(
	receipt: string,
	opts: RetryRejectedEventOptions,
	deps: RetryRejectedEventDeps = {},
): Promise<RetryRejectedEventResult> {
	try {
		if (!opts.dbPath?.trim() || opts.yes !== true || !receipt) {
			throw new RetryError(
				"usage_error",
				"Select a receipt, pass --db-path, and confirm delivery to the current target with -y. Original target provenance is unknown.",
				2,
			);
		}
		const env = deps.env ?? process.env;
		const baseUrl = viewerBaseUrl(env, { rejectInvalidPort: true });
		if (!baseUrl)
			throw new RetryError(
				"invalid_target",
				"The viewer must use an approved loopback host and a valid port.",
				2,
			);
		const entry = await inspectRejectedRawEventSpoolEntry({ receipt, homeDir: deps.homeDir });
		if (entry.validation !== "valid") {
			throw new RetryError(entry.validation, inspectionFailureMessages[entry.validation]);
		}
		const target = {
			db_path: resolve(expandUserPath(opts.dbPath)),
			identity_target: buildViewerIdentityTarget(env),
		};
		const maxBytes = await preflightRetry(baseUrl, target, deps.fetchImpl ?? fetch);
		checkedBatchBody(entry.serialized, target, maxBytes);
		return await recoverWithHttp(
			receipt,
			{ baseUrl, target, maxBytes, keepReceipt: opts.keepReceipt },
			deps,
		);
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
