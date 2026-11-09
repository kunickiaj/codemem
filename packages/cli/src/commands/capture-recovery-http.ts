import { isDeepStrictEqual } from "node:util";
import {
	arePromptTransportProtocolRangesCompatible,
	type buildViewerIdentityTarget,
	normalizePromptTransportProtocolRange,
	PROMPT_TRANSPORT_PROTOCOL_RANGE,
} from "@codemem/core";

export class RetryError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly exitCode: 1 | 2 = 1,
	) {
		super(message);
	}
}

export type RetryTarget = {
	db_path: string;
	identity_target: ReturnType<typeof buildViewerIdentityTarget>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateRetryProfile(profile: unknown, target: RetryTarget): void {
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

export async function requestRetryJson(
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

export async function preflightRetry(
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
