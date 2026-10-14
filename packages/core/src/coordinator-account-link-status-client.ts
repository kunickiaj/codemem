import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import {
	readAccountLinkDevice,
	signAccountLinkRequest,
} from "./coordinator-account-link-signer.js";
import type { CoordinatorAccountLinkStatus } from "./coordinator-account-link-status.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorDeviceLocalEvidence } from "./coordinator-device-local.js";

export interface ReadCoordinatorAccountLinkStatusOptions {
	dbPath: string;
	keysDir?: string;
	groupId: string;
	coordinatorUrl: string;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}
export type CoordinatorAccountLinkStatusRead =
	| { kind: "status"; status: CoordinatorAccountLinkStatus }
	| { kind: "unsupported" }
	| {
			kind: "unavailable";
			code:
				| "coordinator_unavailable"
				| "rate_limited"
				| "coordinator_rejected"
				| "coordinator_unreachable"
				| "invalid_response"
				| "device_unavailable";
	  };
type UnavailableCode = Extract<CoordinatorAccountLinkStatusRead, { kind: "unavailable" }>["code"];
function unavailable(code: UnavailableCode): CoordinatorAccountLinkStatusRead {
	return { kind: "unavailable", code };
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function displayText(value: unknown, limit: number): value is string {
	return (
		typeof value === "string" &&
		value.length <= limit &&
		value.trim().length > 0 &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}
function accountMetadata(value: unknown): NonNullable<CoordinatorAccountLinkStatus["account"]> {
	if (!record(value) || Object.keys(value).some((key) => key !== "email" && key !== "displayName"))
		throw new Error("Invalid status.");
	const account: NonNullable<CoordinatorAccountLinkStatus["account"]> = {};
	if (Object.hasOwn(value, "email")) {
		if (!displayText(value.email, 320)) throw new Error("Invalid status.");
		account.email = value.email;
	}
	if (Object.hasOwn(value, "displayName")) {
		if (!displayText(value.displayName, 256)) throw new Error("Invalid status.");
		account.displayName = value.displayName;
	}
	return account;
}
function decodeStatus(
	value: unknown,
	groupId: string,
	device: CoordinatorDeviceLocalEvidence,
): CoordinatorAccountLinkStatus {
	if (
		!record(value) ||
		Object.keys(value).length !== 8 ||
		value.version !== 1 ||
		!isAuthControllerId(value.coordinatorId) ||
		value.groupId !== groupId ||
		value.deviceId !== device.deviceId ||
		value.fingerprint !== device.fingerprint
	)
		throw new Error("Invalid status.");
	const base = {
		version: 1 as const,
		coordinatorId: value.coordinatorId,
		groupId,
		deviceId: device.deviceId,
		fingerprint: device.fingerprint,
	};
	if (value.state === "review_required" || value.state === "conflict") {
		if (value.identityId !== null || value.account !== null) throw new Error("Invalid status.");
		return { ...base, identityId: null, state: value.state, account: null };
	}
	if (!isAuthControllerId(value.identityId)) throw new Error("Invalid status.");
	if (value.state === "linked")
		return {
			...base,
			identityId: value.identityId,
			state: "linked",
			account: accountMetadata(value.account),
		};
	if ((value.state !== "unlinked" && value.state !== "revoked") || value.account !== null)
		throw new Error("Invalid status.");
	return { ...base, identityId: value.identityId, state: value.state, account: null };
}

/** Race even injected transports/streams that do not implement AbortSignal themselves. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort = () => {};
	try {
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("Status read stopped."));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
		return await Promise.race([operation, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
function discard(response: Response): void {
	void response.body?.cancel().catch(() => {});
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
	if (!response.body) throw new Error("Invalid status.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await abortable(reader.read(), signal);
			if (done) break;
			size += value.byteLength;
			if (size > 16384) throw new Error("Invalid status.");
			chunks.push(value);
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	} finally {
		// Do not let an uncooperative stream's cancel promise defeat the deadline.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
function responseFailure(status: number): CoordinatorAccountLinkStatusRead | null {
	if (status === 200) return null;
	if (status === 404) return { kind: "unsupported" };
	if (status === 503) return unavailable("coordinator_unavailable");
	if (status === 429) return unavailable("rate_limited");
	if ([401, 403, 409].includes(status)) return unavailable("coordinator_rejected");
	return unavailable("coordinator_unreachable");
}
async function readStatus(
	options: ReadCoordinatorAccountLinkStatusOptions,
	signal: AbortSignal,
): Promise<CoordinatorAccountLinkStatusRead> {
	const origin = normalizeCoordinatorAccountLinkOrigin(options.coordinatorUrl);
	const groupId = options.groupId;
	if (!origin || !isAuthControllerId(groupId)) return unavailable("invalid_response");
	if (signal.aborted) return unavailable("coordinator_unreachable");
	const url = new URL("/v1/auth/account-link-status", origin);
	url.searchParams.set("group_id", groupId);
	url.searchParams.set("coordinator_origin", origin);
	let device: CoordinatorDeviceLocalEvidence;
	let headers: ReturnType<typeof signAccountLinkRequest>;
	try {
		device = readAccountLinkDevice(options.dbPath);
		headers = signAccountLinkRequest({
			dbPath: options.dbPath,
			keysDir: options.keysDir,
			device,
			method: "GET",
			url: url.href,
			bodyBytes: Buffer.alloc(0),
		});
	} catch {
		return unavailable("device_unavailable");
	}
	if (signal.aborted) return unavailable("coordinator_unreachable");
	const pending = (options.fetch ?? globalThis.fetch)(url.href, {
		method: "GET",
		headers,
		redirect: "manual",
		signal,
	}).then((response) => {
		if (signal.aborted) discard(response);
		return response;
	});
	const response = await abortable(pending, signal);
	if (signal.aborted) {
		discard(response);
		return unavailable("coordinator_unreachable");
	}
	const failed = responseFailure(response.status);
	if (failed) {
		discard(response);
		return failed;
	}
	try {
		const body = await boundedJson(response, signal);
		if (signal.aborted) return unavailable("coordinator_unreachable");
		return {
			kind: "status",
			status: decodeStatus(body, groupId, device),
		};
	} catch {
		return unavailable(signal.aborted ? "coordinator_unreachable" : "invalid_response");
	}
}

/** Read remote status only. Failures never imply that an account is unlinked. */
export async function readCoordinatorAccountLinkStatus(
	options: ReadCoordinatorAccountLinkStatusOptions,
): Promise<CoordinatorAccountLinkStatusRead> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const signal = options.signal
			? AbortSignal.any([controller.signal, options.signal])
			: controller.signal;
		return await readStatus(options, signal);
	} catch {
		return unavailable("coordinator_unreachable");
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
