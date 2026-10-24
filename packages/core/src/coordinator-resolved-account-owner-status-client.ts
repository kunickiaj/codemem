import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import {
	readAccountLinkDevice,
	signAccountLinkRequest,
} from "./coordinator-account-link-signer.js";
import { projectAccountProfileView } from "./coordinator-auth-browser-view.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { capture } from "./coordinator-auth-link-input.js";
import type { CoordinatorDeviceLocalEvidence } from "./coordinator-device-local.js";
import {
	captureResolvedAccountOwnerReceiptReference,
	type ResolvedAccountOwnerReceiptReference,
	type ResolvedAccountOwnerStatus,
} from "./coordinator-resolved-account-owner-status.js";

export interface ReadCoordinatorResolvedAccountOwnerStatusOptions {
	dbPath: string;
	keysDir?: string;
	groupId: string;
	coordinatorUrl: string;
	ownerIdentityId: string;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}
export interface ReadCoordinatorResolvedAccountOwnerReceiptStatusOptions
	extends ReadCoordinatorResolvedAccountOwnerStatusOptions {
	receipt: ResolvedAccountOwnerReceiptReference;
}
export type CoordinatorResolvedAccountOwnerStatusRead =
	| { kind: "owner_status"; status: ResolvedAccountOwnerStatus }
	| { kind: "unsupported" }
	| {
			kind: "unavailable";
			code:
				| "coordinator_unavailable"
				| "coordinator_auth_schema_upgrade_required"
				| "rate_limited"
				| "coordinator_rejected"
				| "coordinator_incompatible"
				| "coordinator_unreachable"
				| "invalid_response"
				| "device_unavailable";
	  };
type ReadFailure = Exclude<CoordinatorResolvedAccountOwnerStatusRead, { kind: "owner_status" }>;
type UnavailableCode = Extract<ReadFailure, { kind: "unavailable" }>["code"];
function unavailable(code: UnavailableCode): Extract<ReadFailure, { kind: "unavailable" }> {
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
function decodeProfile(value: unknown): NonNullable<ResolvedAccountOwnerStatus["profile"]> {
	if (
		!record(value) ||
		Object.keys(value).some((key) => !["displayName", "email", "pictureUrl"].includes(key))
	)
		throw new Error("Invalid owner status.");
	const profile: NonNullable<ResolvedAccountOwnerStatus["profile"]> = {};
	if (Object.hasOwn(value, "displayName")) {
		if (!displayText(value.displayName, 256)) throw new Error("Invalid owner status.");
		profile.displayName = value.displayName;
	}
	if (Object.hasOwn(value, "email")) {
		if (!displayText(value.email, 320)) throw new Error("Invalid owner status.");
		profile.email = value.email;
	}
	if (Object.hasOwn(value, "pictureUrl")) {
		const { pictureUrl } = projectAccountProfileView(value, "https://accounts.google.com");
		if (!pictureUrl || pictureUrl !== value.pictureUrl) throw new Error("Invalid owner status.");
		profile.pictureUrl = pictureUrl;
	}
	return profile;
}
const STATUS_FIELDS = [
	"version",
	"coordinatorId",
	"groupId",
	"deviceId",
	"fingerprint",
	"state",
	"ownerIdentity",
	"profileState",
	"profile",
];
function decodeStatus(
	value: unknown,
	options: ReadCoordinatorResolvedAccountOwnerStatusOptions,
	device: CoordinatorDeviceLocalEvidence,
): ResolvedAccountOwnerStatus {
	if (
		!record(value) ||
		Object.keys(value).length !== STATUS_FIELDS.length ||
		Object.keys(value).some((key) => !STATUS_FIELDS.includes(key)) ||
		value.version !== 1 ||
		!isAuthControllerId(value.coordinatorId) ||
		value.groupId !== options.groupId ||
		value.deviceId !== device.deviceId ||
		value.fingerprint !== device.fingerprint
	)
		throw new Error("Invalid owner status.");
	const base = {
		version: 1 as const,
		coordinatorId: value.coordinatorId,
		groupId: options.groupId,
		deviceId: device.deviceId,
		fingerprint: device.fingerprint,
	};
	return decodeState(value, base, options.ownerIdentityId);
}
function decodeState(
	value: Record<string, unknown>,
	base: Pick<
		ResolvedAccountOwnerStatus,
		"version" | "coordinatorId" | "groupId" | "deviceId" | "fingerprint"
	>,
	ownerIdentityId: string,
): ResolvedAccountOwnerStatus {
	if (value.state === "owner_unconfirmed") {
		if (
			value.ownerIdentity !== null ||
			value.profileState !== "unavailable" ||
			value.profile !== null
		)
			throw new Error("Invalid owner status.");
		return {
			...base,
			state: "owner_unconfirmed",
			ownerIdentity: null,
			profileState: "unavailable",
			profile: null,
		};
	}
	if (value.state !== "owner_confirmed" || value.ownerIdentity !== ownerIdentityId)
		throw new Error("Invalid owner status.");
	if (value.profileState === "linked")
		return {
			...base,
			state: "owner_confirmed",
			ownerIdentity: ownerIdentityId,
			profileState: "linked",
			profile: decodeProfile(value.profile),
		};
	if (
		(value.profileState !== "account_unlinked" && value.profileState !== "unavailable") ||
		value.profile !== null
	)
		throw new Error("Invalid owner status.");
	return {
		...base,
		state: "owner_confirmed",
		ownerIdentity: ownerIdentityId,
		profileState: value.profileState,
		profile: null,
	};
}

/** Also stop injected transports and body streams that ignore AbortSignal. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort = () => {};
	try {
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("Owner status read stopped."));
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
	if (!response.body) throw new Error("Invalid owner status.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await abortable(reader.read(), signal);
			if (done) break;
			size += value.byteLength;
			if (size > 16384) throw new Error("Invalid owner status.");
			chunks.push(value);
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
function responseFailure(response: Response): ReadFailure | null {
	const status = response.status;
	if (
		status === 503 &&
		response.headers.get("X-Codemem-Auth-Error") === "coordinator_auth_schema_upgrade_required"
	)
		return unavailable("coordinator_auth_schema_upgrade_required");
	if (status === 200) return null;
	if (status === 404) return { kind: "unsupported" };
	if (status === 400) return unavailable("coordinator_incompatible");
	if (status === 408 || (status >= 500 && status < 600))
		return unavailable("coordinator_unavailable");
	if (status === 429) return unavailable("rate_limited");
	if ([401, 403, 409].includes(status)) return unavailable("coordinator_rejected");
	return unavailable("invalid_response");
}
function signExistingDevice(options: ReadCoordinatorResolvedAccountOwnerStatusOptions, url: URL) {
	const device = readAccountLinkDevice(options.dbPath);
	const headers = signAccountLinkRequest({
		dbPath: options.dbPath,
		keysDir: options.keysDir,
		device,
		method: "GET",
		url: url.href,
		bodyBytes: Buffer.alloc(0),
	});
	return { device, headers };
}
async function readResponse(
	response: Response,
	signal: AbortSignal,
	options: ReadCoordinatorResolvedAccountOwnerStatusOptions,
	device: CoordinatorDeviceLocalEvidence,
): Promise<CoordinatorResolvedAccountOwnerStatusRead> {
	const failure = responseFailure(response);
	if (failure) {
		discard(response);
		return failure;
	}
	try {
		const body = await boundedJson(response, signal);
		if (signal.aborted) return unavailable("coordinator_unreachable");
		return { kind: "owner_status", status: decodeStatus(body, options, device) };
	} catch {
		return unavailable(signal.aborted ? "coordinator_unreachable" : "invalid_response");
	}
}
async function readStatus(
	options: ReadCoordinatorResolvedAccountOwnerStatusOptions,
	signal: AbortSignal,
	receipt?: ResolvedAccountOwnerReceiptReference,
): Promise<CoordinatorResolvedAccountOwnerStatusRead> {
	const origin = normalizeCoordinatorAccountLinkOrigin(options.coordinatorUrl);
	if (
		!origin ||
		!isAuthControllerId(options.groupId) ||
		!isAuthControllerId(options.ownerIdentityId)
	)
		return unavailable("invalid_response");
	if (signal.aborted) return unavailable("coordinator_unreachable");
	const path = receipt
		? "/v1/auth/resolved-account-owner-receipt-status"
		: "/v1/auth/resolved-account-owner-status";
	const url = new URL(path, origin);
	url.searchParams.set("group_id", options.groupId);
	url.searchParams.set("coordinator_origin", origin);
	url.searchParams.set("owner_identity_id", options.ownerIdentityId);
	if (receipt) {
		url.searchParams.set("attestation_id", receipt.attestationId);
		url.searchParams.set("review_receipt_id", receipt.reviewReceiptId);
		url.searchParams.set("review_evidence_digest", receipt.reviewEvidenceDigest);
		url.searchParams.set("resolution_id", receipt.resolutionId);
		url.searchParams.set("resolution_evidence_digest", receipt.resolutionEvidenceDigest);
	}
	return fetchStatus(options, url, signal);
}

async function fetchStatus(
	options: ReadCoordinatorResolvedAccountOwnerStatusOptions,
	url: URL,
	signal: AbortSignal,
): Promise<CoordinatorResolvedAccountOwnerStatusRead> {
	let signed: ReturnType<typeof signExistingDevice>;
	try {
		signed = signExistingDevice(options, url);
	} catch {
		return unavailable("device_unavailable");
	}
	if (signal.aborted) return unavailable("coordinator_unreachable");
	const pending = (options.fetch ?? globalThis.fetch)(url.href, {
		method: "GET",
		headers: signed.headers,
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
	return readResponse(response, signal, options, signed.device);
}
async function readWithDeadline(
	options: ReadCoordinatorResolvedAccountOwnerStatusOptions,
	receipt?: ResolvedAccountOwnerReceiptReference,
): Promise<CoordinatorResolvedAccountOwnerStatusRead> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const signal = options.signal
			? AbortSignal.any([controller.signal, options.signal])
			: controller.signal;
		return await readStatus(options, signal, receipt);
	} catch {
		return unavailable("coordinator_unreachable");
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

/** Display-only remote read using existing keys; failures never imply unlink or authority. */
export async function readCoordinatorResolvedAccountOwnerStatus(
	options: ReadCoordinatorResolvedAccountOwnerStatusOptions,
): Promise<CoordinatorResolvedAccountOwnerStatusRead> {
	try {
		// Receipt callers must use the constrained endpoint, never silently drop their pins.
		if ("receipt" in options || "expectedReceipt" in options)
			return unavailable("invalid_response");
		return await readWithDeadline(options);
	} catch {
		return unavailable("invalid_response");
	}
}

/** Check a complete pasted receipt using the same existing device and display-only DTO. */
export async function readCoordinatorResolvedAccountOwnerReceiptStatus(
	options: ReadCoordinatorResolvedAccountOwnerReceiptStatusOptions,
): Promise<CoordinatorResolvedAccountOwnerStatusRead> {
	const outer = capture(options, ["receipt"]);
	const receipt = captureResolvedAccountOwnerReceiptReference(outer?.receipt);
	if (!receipt) return unavailable("invalid_response");
	return readWithDeadline(options, receipt);
}
