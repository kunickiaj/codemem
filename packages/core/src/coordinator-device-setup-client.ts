import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import {
	readAccountLinkDevice,
	signAccountLinkRequest,
} from "./coordinator-account-link-signer.js";
import { abortable, boundedJson, discard } from "./coordinator-account-link-status-client.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorDeviceLocalEvidence } from "./coordinator-device-local.js";

export interface CoordinatorDeviceSetupOptions {
	dbPath: string;
	keysDir?: string;
	coordinatorUrl: string;
	groupId: string;
	currentIdentityId: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}
export type CoordinatorDeviceSetupOutcome =
	| { kind: "ready" | "complete" | "requires_review" | "connect_required" }
	| { kind: "unsupported"; cause: "coordinator_upgrade_required" }
	| { kind: "unknown"; cause: "completion_outcome_unknown" }
	| {
			kind: "unavailable";
			cause:
				| "device_unavailable"
				| "invalid_input"
				| "coordinator_unreachable"
				| "invalid_response"
				| "coordinator_rejected"
				| "rate_limited"
				| "coordinator_auth_schema_upgrade_required"
				| "coordinator_unavailable";
	  };
type Method = "GET" | "POST";
type FailureCause = Extract<CoordinatorDeviceSetupOutcome, { kind: "unavailable" }>["cause"];
type Connection = {
	options: CoordinatorDeviceSetupOptions;
	origin: string;
	device: CoordinatorDeviceLocalEvidence;
};
const unavailable = (cause: FailureCause): CoordinatorDeviceSetupOutcome => ({
	kind: "unavailable",
	cause,
});
const unknown = (): CoordinatorDeviceSetupOutcome => ({
	kind: "unknown",
	cause: "completion_outcome_unknown",
});

function decode(value: unknown, method: Method): CoordinatorDeviceSetupOutcome {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== 1 ||
		!("kind" in value)
	)
		return unavailable("invalid_response");
	if (value.kind === "complete" || value.kind === "requires_review") return { kind: value.kind };
	if (method === "GET" && (value.kind === "ready" || value.kind === "connect_required"))
		return { kind: value.kind };
	return unavailable("invalid_response");
}

function httpFailure(response: Response, method: Method): CoordinatorDeviceSetupOutcome | null {
	if (response.status === 200) return null;
	if (response.status === 404)
		return { kind: "unsupported", cause: "coordinator_upgrade_required" };
	if (response.status === 429) return unavailable("rate_limited");
	if ([400, 401, 403, 409, 413, 415].includes(response.status))
		return unavailable("coordinator_rejected");
	if (method === "POST") return unknown();
	if (
		response.status === 503 &&
		response.headers.get("X-Codemem-Auth-Error") === "coordinator_auth_schema_upgrade_required"
	)
		return unavailable("coordinator_auth_schema_upgrade_required");
	return unavailable("coordinator_unavailable");
}

function prepareRequest(
	{ options, origin, device }: Connection,
	method: Method,
	signal: AbortSignal,
) {
	const url = new URL("/v1/auth/device-binding", origin);
	const input = { group_id: options.groupId, identity_id: options.currentIdentityId };
	if (method === "GET")
		for (const [key, value] of Object.entries(input)) url.searchParams.set(key, value);
	const body = method === "POST" ? Buffer.from(JSON.stringify(input)) : Buffer.alloc(0);
	const headers = signAccountLinkRequest({
		dbPath: options.dbPath,
		keysDir: options.keysDir,
		device,
		method,
		url: url.href,
		bodyBytes: body,
	});
	const init: RequestInit = {
		method,
		headers: { ...headers, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
		...(method === "POST" ? { body } : {}),
		redirect: "manual",
		signal,
	};
	return { url, init };
}

async function request(
	connection: Connection,
	method: Method,
): Promise<CoordinatorDeviceSetupOutcome> {
	const { options } = connection;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	const signal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	let sent = false;
	let received = false;
	try {
		let prepared: ReturnType<typeof prepareRequest>;
		try {
			prepared = prepareRequest(connection, method, signal);
		} catch {
			return unavailable("device_unavailable");
		}
		if (signal.aborted) return unavailable("coordinator_unreachable");
		sent = true;
		const pending = (options.fetch ?? globalThis.fetch)(prepared.url.href, prepared.init).then(
			(response) => {
				if (signal.aborted) discard(response);
				return response;
			},
		);
		const response = await abortable(pending, signal);
		received = true;
		const failure = httpFailure(response, method);
		if (failure) {
			discard(response);
			return failure;
		}
		const result = decode(await boundedJson(response, signal), method);
		if (method === "POST" && result.kind === "unavailable") return unknown();
		return result;
	} catch {
		if (method === "POST" && sent) return unknown();
		return unavailable(
			!received || signal.aborted ? "coordinator_unreachable" : "invalid_response",
		);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

async function run(
	value: CoordinatorDeviceSetupOptions,
	method: Method,
): Promise<CoordinatorDeviceSetupOutcome> {
	const options: CoordinatorDeviceSetupOptions = {
		dbPath: value.dbPath,
		keysDir: value.keysDir,
		coordinatorUrl: value.coordinatorUrl,
		groupId: value.groupId,
		currentIdentityId: value.currentIdentityId,
		fetch: value.fetch ?? globalThis.fetch,
		signal: value.signal,
	};
	const origin = normalizeCoordinatorAccountLinkOrigin(options.coordinatorUrl);
	if (
		!origin ||
		!isAuthControllerId(options.groupId) ||
		!isAuthControllerId(options.currentIdentityId)
	)
		return unavailable("invalid_input");
	let device: CoordinatorDeviceLocalEvidence;
	try {
		device = readAccountLinkDevice(options.dbPath);
	} catch {
		return unavailable("device_unavailable");
	}
	const connection = { options, origin, device };
	const result = await request(connection, method);
	if (method === "GET" || result.kind !== "unknown") return result;
	const recovered = await request(connection, "GET");
	if (recovered.kind === "complete") return recovered;
	if (
		recovered.kind === "unavailable" &&
		recovered.cause === "coordinator_auth_schema_upgrade_required"
	)
		return recovered;
	return unknown();
}

/** Read status once without attempting completion or changing local state. */
export function readCoordinatorDeviceSetup(
	options: CoordinatorDeviceSetupOptions,
): Promise<CoordinatorDeviceSetupOutcome> {
	return run(options, "GET");
}

/** Complete directly. Resolve an ambiguous POST with one GET, never a POST retry. */
export function completeCoordinatorDeviceSetup(
	options: CoordinatorDeviceSetupOptions,
): Promise<CoordinatorDeviceSetupOutcome> {
	return run(options, "POST");
}
