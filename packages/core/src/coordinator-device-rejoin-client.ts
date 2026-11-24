import { randomBytes, randomUUID } from "node:crypto";
import { createCoordinatorDeviceRejoinReceiver } from "./coordinator-account-link-receiver.js";
import { abortable } from "./coordinator-account-link-status-client.js";
import {
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import {
	createDeviceRejoinRequests,
	type DeviceRejoinClientReceipt,
	type DeviceRejoinRequestFailure,
} from "./coordinator-device-rejoin-client-requests.js";

const TTL_MS = 600_000;
type Requests = NonNullable<Awaited<ReturnType<typeof createDeviceRejoinRequests>>>;
type Receiver = Awaited<ReturnType<typeof createCoordinatorDeviceRejoinReceiver>>;

export type DeviceRejoinOptions = Parameters<typeof createDeviceRejoinRequests>[0] & {
	loopbackHost?: "127.0.0.1" | "::1";
	openBrowser(url: string): void | Promise<void>;
};

export type DeviceRejoinOutcome =
	| { kind: "finalized"; receipt: DeviceRejoinClientReceipt }
	| DeviceRejoinRequestFailure
	| {
			kind: "failed";
			error: "device_unavailable" | "start_unconfirmed" | "browser_stopped" | "review_unavailable";
	  };

async function complete(
	requests: Requests,
	pins: Parameters<Requests["status"]>[0],
	delivery: Extract<Awaited<Receiver["completion"]>, { kind: "confirmed" }>,
	now: () => number,
): Promise<DeviceRejoinOutcome> {
	const before = await requests.status(pins);
	if (before.kind === "status" && before.state === "finalized")
		return { kind: "finalized", receipt: before.receipt };
	if (before.kind !== "status" || before.state !== "confirmed" || now() >= pins.expiresAtMs)
		return { kind: "failed", error: "review_unavailable" };
	const result = await requests.finalize(pins, delivery);
	if (result.kind === "finalized" || (result.kind === "refused" && result.reason !== "retry"))
		return result;
	// A lost response can hide a commit. Check live status before doing anything else.
	const status = await requests.status(pins);
	if (status.kind === "status" && status.state === "finalized")
		return { kind: "finalized", receipt: status.receipt };
	// No automatic repeat of a mutation with an unknown outcome.
	return { kind: "unknown" };
}

async function browserCeremony(
	requests: Requests,
	receiver: Receiver,
	run: { attemptId: string; signal: AbortSignal; options: DeviceRejoinOptions },
): Promise<DeviceRejoinOutcome> {
	const startCode = randomBytes(32);
	const { attemptId, signal, options } = run;
	const now = options.now ?? (() => Date.now());
	try {
		const started = await requests.start({
			attemptId,
			browserStartHash: await hashCoordinatorAuthProofBytes32(startCode),
			loopbackRedirect: receiver.destination,
		});
		if (started.kind === "unknown") return { kind: "failed", error: "start_unconfirmed" };
		if (started.kind === "refused") return started;
		const { pins } = started;
		const remaining = pins.expiresAtMs - now();
		if (remaining <= 0 || options.assertCurrentContext?.() === false)
			return { kind: "failed", error: "browser_stopped" };
		const browserSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
		const query = new URLSearchParams({
			attempt_id: attemptId,
			start_code: encodeCoordinatorAuthProof32(startCode),
		});
		startCode.fill(0);
		await abortable(
			Promise.resolve(options.openBrowser(`${requests.origin}/auth/rejoin/start?${query}`)),
			browserSignal,
		);
		const delivery = await abortable(receiver.completion, browserSignal);
		if (delivery.kind === "refused") return delivery;
		return complete(requests, pins, delivery, now);
	} catch {
		return { kind: "failed", error: "browser_stopped" };
	} finally {
		startCode.fill(0);
	}
}

/** Rejoin this existing device through Google; never creates keys or changes local sync settings. */
export async function runDeviceRejoin(options: DeviceRejoinOptions): Promise<DeviceRejoinOutcome> {
	const signal = AbortSignal.any([
		AbortSignal.timeout(TTL_MS),
		...(options.signal ? [options.signal] : []),
	]);
	const requests = await createDeviceRejoinRequests({ ...options, signal });
	if (!requests || signal.aborted) return { kind: "failed", error: "device_unavailable" };
	const attemptId = randomUUID();
	let receiver: Receiver;
	try {
		receiver = await createCoordinatorDeviceRejoinReceiver({
			attemptId,
			host: options.loopbackHost,
			signal,
		});
	} catch {
		return { kind: "failed", error: "browser_stopped" };
	}
	try {
		return await browserCeremony(requests, receiver, { attemptId, signal, options });
	} finally {
		await receiver.close().catch(() => {});
	}
}
