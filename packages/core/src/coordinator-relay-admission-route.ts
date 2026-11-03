import type { Hono } from "hono";
import { createAdmissionBudgetAdapters } from "./admission-budget-adapters.js";
import { decodeRelayCheckPacket, type RelayCheckPacket } from "./relay-admission-codec.js";
import {
	decideRelayAdmission,
	type RelayAdmissionDecisionDependencies,
} from "./relay-admission-decision.js";
import type { RelayAdmissionNamespace } from "./relay-admission-participant-nonce.js";
import type { RelayProofExpectation } from "./relay-admission-proof.js";
import { encodeRelayAdmissionReply } from "./relay-admission-reply.js";

export interface CoordinatorRelayAdmissionRuntimeOptions {
	/** Explicit server-owned namespace, never derived from request headers or body. */
	readonly namespace: RelayAdmissionNamespace;
	/** Exact externally signed pathname, including a configured mount prefix. */
	readonly externalPathname: string;
	/** Server-owned transport classification, not the forwarded packet's role. */
	readonly ingressKey: string;
}

export interface CoordinatorRelayAdmissionOptions extends CoordinatorRelayAdmissionRuntimeOptions {
	readonly open: () => {
		readonly database: RelayAdmissionDecisionDependencies["database"];
		readonly close: () => void | Promise<void>;
	};
}

async function collectAdmissionBody(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
	deadline: number,
): Promise<Uint8Array | null | undefined> {
	const bytes = new Uint8Array(1024);
	let size = 0;
	while (true) {
		if (signal.aborted || performance.now() >= deadline) return undefined;
		const { done, value } = await reader.read();
		if (done) return bytes.slice(0, size);
		if (size + value.byteLength > bytes.length) return null;
		bytes.set(value, size);
		size += value.byteLength;
	}
}

async function readAdmissionBody(request: Request): Promise<Uint8Array | null | undefined> {
	const stream = request.body;
	if (!stream) return request.signal.aborted ? undefined : new Uint8Array();
	const reader = stream.getReader();
	const deadline = performance.now() + 3000;
	let stop: () => void = () => {};
	const stopped = new Promise<undefined>((resolve) => {
		stop = () => resolve(undefined);
	});
	const timer = setTimeout(stop, 3000);
	request.signal.addEventListener("abort", stop, { once: true });
	try {
		if (request.signal.aborted) return undefined;
		const length = Number(request.headers.get("content-length"));
		if (Number.isFinite(length) && length > 1024) return null;
		const result = await Promise.race([
			collectAdmissionBody(reader, request.signal, deadline),
			stopped,
		]);
		if (request.signal.aborted || performance.now() >= deadline) return undefined;
		return result;
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener("abort", stop);
		// An underlying cancel hook may never settle. It must not delay denial.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function packetFromRequest(request: Request, bytes: Uint8Array): RelayCheckPacket {
	return {
		body: btoa(String.fromCharCode(...bytes))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, ""),
		timestamp: request.headers.get("X-Opencode-Timestamp") ?? "",
		nonce: request.headers.get("X-Opencode-Nonce") ?? "",
		signature: request.headers.get("X-Opencode-Signature") ?? "",
	};
}

function packetExpectation(packet: RelayCheckPacket): RelayProofExpectation | null {
	try {
		const check = decodeRelayCheckPacket(packet);
		if (check.kind === "registration") return { kind: "registration" };
		return { kind: "admission", role: check.value.role };
	} catch {
		return null;
	}
}

function admissionResponse(bytes = encodeRelayAdmissionReply(null), status = 200): Response {
	return new Response(new Uint8Array(bytes), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

async function admissionCheck(
	request: Request,
	options?: CoordinatorRelayAdmissionOptions,
): Promise<Response> {
	try {
		const bytes = await readAdmissionBody(request);
		if (!options) return admissionResponse(undefined, bytes === null ? 413 : 200);
		const packet = packetFromRequest(request, bytes ?? new Uint8Array());
		const expected = packetExpectation(packet);
		const connection = options.open();
		try {
			const budgets = createAdmissionBudgetAdapters({
				database: { writeReturning: connection.database.insertReturning.bind(connection.database) },
			}).relay;
			// Malformed packets still consume the dedicated ingress budget. No device
			// budget or nonce is touched until the decision verifies the proof.
			const reserved = await budgets.reserveIngress({
				namespace: options.namespace,
				ingressKey: options.ingressKey,
				expected: expected ?? { kind: "admission", role: "relay" },
			});
			if (bytes === null) return admissionResponse(undefined, 413);
			if (bytes === undefined) return admissionResponse();
			const url = new URL(request.url);
			if (
				reserved !== "reserved" ||
				!expected ||
				url.search !== "" ||
				url.pathname !== options.externalPathname
			)
				return admissionResponse();
			const decision = await decideRelayAdmission(
				{
					packet,
					expected,
					deviceHeader: request.headers.get("X-Opencode-Device") ?? "",
					externalPathname: options.externalPathname,
					namespace: options.namespace,
					ingressKey: options.ingressKey,
				},
				{
					database: connection.database,
					budgets: { ...budgets, reserveIngress: async () => reserved },
				},
			);
			return admissionResponse(encodeRelayAdmissionReply(decision));
		} finally {
			await connection.close();
		}
	} catch {
		return admissionResponse();
	}
}

/** Optional capability only. This route never provisions policy, schema, or readiness. */
export function registerCoordinatorRelayAdmissionRoute(
	app: Hono,
	options?: CoordinatorRelayAdmissionOptions,
): void {
	if (!options) return;
	const captured = { ...options, namespace: Object.freeze({ ...options.namespace }) };
	app.post("/v1/relay/admission-check", (c) => admissionCheck(c.req.raw, captured));
}
