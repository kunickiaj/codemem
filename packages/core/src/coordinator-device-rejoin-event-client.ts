import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import {
	readAccountLinkDevice,
	signAccountLinkRequest,
} from "./coordinator-account-link-signer.js";
import { abortable, boundedJson, discard } from "./coordinator-account-link-status-client.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";

const MAX_EVENTS_PER_PAGE = 50;
const MAX_PAGE_BYTES = 256 * 1024;

export interface CoordinatorDeviceRejoinEvent {
	eventId: string;
	deviceId: string;
	groupIds: string[];
	finalizedAtMs: number;
}

export type CoordinatorDeviceRejoinEventRead =
	| { kind: "page"; items: CoordinatorDeviceRejoinEvent[]; nextCursor: string | null }
	| { kind: "not_enrolled" | "unsupported" | "unavailable" };

interface Options {
	coordinatorUrl: string;
	groupId: string;
	dbPath: string;
	keysDir?: string;
	expectedSigner?: { deviceId: string; fingerprint: string };
	after?: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeEvent(value: unknown): CoordinatorDeviceRejoinEvent {
	if (
		!record(value) ||
		!isAuthControllerId(value.event_id) ||
		!isAuthControllerId(value.device_id) ||
		typeof value.finalized_at_ms !== "number" ||
		!Number.isSafeInteger(value.finalized_at_ms) ||
		value.finalized_at_ms < 0 ||
		!Array.isArray(value.group_ids) ||
		value.group_ids.length === 0 ||
		!value.group_ids.every(isAuthControllerId)
	)
		throw new Error("Invalid rejoin event.");
	return {
		eventId: value.event_id,
		deviceId: value.device_id,
		groupIds: [...value.group_ids],
		finalizedAtMs: value.finalized_at_ms,
	};
}

function decodePage(value: unknown, after: string | undefined): CoordinatorDeviceRejoinEventRead {
	if (!record(value) || !Array.isArray(value.items) || value.items.length > MAX_EVENTS_PER_PAGE)
		return { kind: "unavailable" };
	const items = value.items.map(decodeEvent);
	const ids = new Set(items.map((item) => item.eventId));
	const nextCursor = items.at(-1)?.eventId ?? after ?? null;
	if (ids.size !== items.length || (after && ids.has(after)) || value.next_cursor !== nextCursor)
		return { kind: "unavailable" };
	return { kind: "page", items, nextCursor };
}

function readSigner(options: Options) {
	const device = readAccountLinkDevice(options.dbPath);
	const expected = options.expectedSigner;
	if (
		expected &&
		(device.deviceId !== expected.deviceId || device.fingerprint !== expected.fingerprint)
	)
		throw new Error("Rejoin event signer changed.");
	return device;
}

/** Read one page with the current local key. Failure never advances the caller's cursor. */
export async function readCoordinatorDeviceRejoinEvents(
	options: Options,
): Promise<CoordinatorDeviceRejoinEventRead> {
	const { coordinatorUrl, groupId, dbPath, keysDir, after } = options;
	const origin = normalizeCoordinatorAccountLinkOrigin(coordinatorUrl);
	if (
		!origin ||
		!isAuthControllerId(groupId) ||
		(after !== undefined && !isAuthControllerId(after))
	)
		return { kind: "unavailable" };
	const url = new URL("/v1/auth/rejoin-events", origin);
	url.searchParams.set("group_id", groupId);
	if (after) url.searchParams.set("after", after);
	const timeout = AbortSignal.timeout(10_000);
	const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
	try {
		signal.throwIfAborted();
		const headers = signAccountLinkRequest({
			dbPath,
			keysDir,
			device: readSigner(options),
			method: "GET",
			url: url.href,
			bodyBytes: Buffer.alloc(0),
		});
		signal.throwIfAborted();
		const pending = (options.fetch ?? globalThis.fetch)(url.href, {
			method: "GET",
			headers,
			redirect: "manual",
			credentials: "omit",
			signal,
		}).then((response) => {
			if (signal.aborted) discard(response);
			return response;
		});
		const response = await abortable(pending, signal);
		if (response.status !== 200) {
			discard(response);
			if (response.status === 401 || response.status === 403) return { kind: "not_enrolled" };
			return { kind: response.status === 404 ? "unsupported" : "unavailable" };
		}
		return decodePage(await boundedJson(response, signal, MAX_PAGE_BYTES), after);
	} catch {
		return { kind: "unavailable" };
	}
}
