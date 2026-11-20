import {
	BOUNDARY_READINESS_MAX_BODY_BYTES,
	type BoundaryReadinessProject,
	type BoundaryReadinessRejection,
} from "./coordinator-boundary-readiness.js";
import { BOUNDARY_READINESS_PATH } from "./coordinator-boundary-readiness-route.js";
import { buildAuthHeaders } from "./sync-auth.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";

export interface SubmitBoundaryReadinessInput {
	coordinatorUrl: string;
	groupId: string;
	deviceId: string;
	dbPath: string;
	keysDir?: string;
	sequence: number;
	omittedProjects: number;
	projects: readonly BoundaryReadinessProject[];
	timeoutS?: number;
}

type Failure =
	| "invalid_input"
	| "request_too_large"
	| "signing_failed"
	| "transport_failed"
	| "invalid_response";

export type SubmitBoundaryReadinessResult =
	| { kind: "stored"; sequence: number; rejected: BoundaryReadinessRejection[] }
	// The submitted inventory was not stored. The caller can use this sequence as a floor.
	| { kind: "stale"; sequence: number }
	| { kind: "unsupported" }
	| { kind: "unavailable" }
	| { kind: "rejected"; status: number }
	| { kind: "failed"; reason: Failure };

// Rejections can echo the IDs of every submitted Project, plus an error code per entry.
const MAX_RESPONSE_BYTES = 2 * BOUNDARY_READINESS_MAX_BODY_BYTES;

function failed(reason: Failure): SubmitBoundaryReadinessResult {
	return { kind: "failed", reason };
}

function requestUrl(input: SubmitBoundaryReadinessInput): string | null {
	try {
		const base = new URL(buildBaseUrl(input.coordinatorUrl));
		if (base.protocol !== "https:" && base.protocol !== "http:") return null;
		if (base.username || base.password || /[?#]/u.test(base.href)) return null;
		return `${buildBaseUrl(base.href)}${BOUNDARY_READINESS_PATH}?group_id=${encodeURIComponent(input.groupId)}`;
	} catch {
		return null;
	}
}

function isId(value: string): boolean {
	return value !== "" && value === value.trim();
}

function validInput(input: SubmitBoundaryReadinessInput): boolean {
	return (
		isId(input.groupId) &&
		isId(input.deviceId) &&
		Number.isSafeInteger(input.sequence) &&
		input.sequence > 0 &&
		Number.isSafeInteger(input.omittedProjects) &&
		input.omittedProjects >= 0
	);
}

function requestRecord(input: SubmitBoundaryReadinessInput) {
	return {
		version: 1,
		sequence: input.sequence,
		omitted_projects: input.omittedProjects,
		projects: input.projects.map((project) => ({
			source_scope_id: project.source_scope_id,
			boundary_scope_id: project.boundary_scope_id,
			state: project.state,
			own_rows_in_source: project.own_rows_in_source,
			own_rows_in_boundary: project.own_rows_in_boundary,
		})),
	};
}

function projectKey(source: string, boundary: string): string {
	return JSON.stringify([source, boundary]);
}

function readRejection(value: unknown): BoundaryReadinessRejection | null {
	if (!value || typeof value !== "object") return null;
	const { source_scope_id, boundary_scope_id, reason } = value as Record<string, unknown>;
	if (typeof source_scope_id !== "string" || typeof boundary_scope_id !== "string") return null;
	if (reason !== "boundary_scope_invalid" && reason !== "source_scope_not_authorized") return null;
	return { source_scope_id, boundary_scope_id, reason };
}

function readRejections(
	raw: unknown,
	projects: readonly BoundaryReadinessProject[],
): BoundaryReadinessRejection[] | null {
	if (!Array.isArray(raw) || raw.length > projects.length) return null;
	const sent = new Set(
		projects.map((project) => projectKey(project.source_scope_id, project.boundary_scope_id)),
	);
	const rejected: BoundaryReadinessRejection[] = [];
	for (const value of raw) {
		const entry = readRejection(value);
		if (!entry || !sent.delete(projectKey(entry.source_scope_id, entry.boundary_scope_id)))
			return null;
		rejected.push(entry);
	}
	return rejected;
}

function reply(
	status: number,
	body: Record<string, unknown> | null,
	record: ReturnType<typeof requestRecord>,
): SubmitBoundaryReadinessResult {
	if (status === 404) return { kind: "unsupported" };
	if (status === 503) return { kind: "unavailable" };
	if (status !== 200) return { kind: "rejected", status };
	const sequence = body?.sequence;
	if (body?.version !== 1 || typeof sequence !== "number" || !Number.isSafeInteger(sequence)) {
		return failed("invalid_response");
	}
	if (body.status === "stale" && sequence >= record.sequence) return { kind: "stale", sequence };
	if (body.status !== "stored" || sequence !== record.sequence) return failed("invalid_response");
	const rejected = readRejections(body.rejected, record.projects);
	if (!rejected) return failed("invalid_response");
	return { kind: "stored", sequence, rejected };
}

/** Sends one fitted record using an existing device key. The caller owns sequence and retry policy. */
export async function submitBoundaryReadiness(
	input: SubmitBoundaryReadinessInput,
): Promise<SubmitBoundaryReadinessResult> {
	if (!validInput(input)) return failed("invalid_input");
	const url = requestUrl(input);
	if (!url) return failed("invalid_input");
	const record = requestRecord(input);
	const bodyBytes = Buffer.from(JSON.stringify(record), "utf8");
	if (bodyBytes.byteLength > BOUNDARY_READINESS_MAX_BODY_BYTES) return failed("request_too_large");
	let headers: ReturnType<typeof buildAuthHeaders>;
	try {
		headers = buildAuthHeaders({
			deviceId: input.deviceId,
			dbPath: input.dbPath,
			keysDir: input.keysDir,
			method: "POST",
			url,
			bodyBytes,
		});
	} catch {
		return failed("signing_failed");
	}
	try {
		const [status, body] = await requestJson("POST", url, {
			headers,
			bodyBytes,
			redirect: "error",
			timeoutS: input.timeoutS,
			maxResponseBytes: MAX_RESPONSE_BYTES,
		});
		return reply(status, body, record);
	} catch {
		// The server may have stored the record before the response was lost.
		return failed("transport_failed");
	}
}
