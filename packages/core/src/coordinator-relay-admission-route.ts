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
	/**
	 * Server-owned namespaces keyed by group ID. The signed body's group ID only
	 * selects an entry. Every entry must share one authority and relay audience,
	 * and an unknown group is denied without a default.
	 */
	readonly namespaces: ReadonlyMap<string, RelayAdmissionNamespace>;
	/** Exact externally signed pathname, including a configured mount prefix. */
	readonly externalPathname: string;
	/** Server-owned transport classification, not the forwarded packet's role. */
	readonly ingressKey: string;
	/**
	 * The relay service's Ed25519 public key as SSH text (`ssh-ed25519 <base64>`).
	 * Only `GET /v1/relay/info` reads it, to advertise the key to enrolled devices.
	 * Without a valid key that route serves no group. The options do not carry
	 * the relay origin, so the route cannot check this key against the
	 * namespaces' relay audience ID. Callers must derive both from one key.
	 */
	readonly servicePublicKey?: string;
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

interface PacketClaim {
	readonly expected: RelayProofExpectation;
	/** Unverified until the decision checks the device signature over the body. */
	readonly groupId: string;
}

function packetExpectation(packet: RelayCheckPacket): PacketClaim | null {
	try {
		const check = decodeRelayCheckPacket(packet);
		const groupId = check.value.groupId;
		if (check.kind === "registration") return { expected: { kind: "registration" }, groupId };
		return { expected: { kind: "admission", role: check.value.role }, groupId };
	} catch {
		return null;
	}
}

interface CapturedRelayAdmission {
	readonly namespaces: ReadonlyMap<string, RelayAdmissionNamespace>;
	readonly authorityId: string;
	readonly relayAudienceId: string;
	readonly externalPathname: string;
	readonly ingressKey: string;
	readonly open: CoordinatorRelayAdmissionOptions["open"];
}

/** Copies and freezes every entry, or returns null when entries are unreadable or disagree. */
function captureOptions(options: CoordinatorRelayAdmissionOptions): CapturedRelayAdmission | null {
	try {
		return captureNamespaces(options);
	} catch {
		return null;
	}
}

/**
 * Frozen copies keyed by group ID, or null when the map is empty or its
 * entries disagree on group key, authority, or relay audience. Throws when an
 * entry is unreadable.
 */
export function consistentRelayNamespaces(
	source: ReadonlyMap<string, RelayAdmissionNamespace>,
): ReadonlyMap<string, RelayAdmissionNamespace> | null {
	const namespaces = new Map<string, RelayAdmissionNamespace>();
	for (const [groupId, entry] of source) {
		const { authorityId, relayAudienceId } = entry;
		namespaces.set(
			groupId,
			Object.freeze({ authorityId, groupId: entry.groupId, relayAudienceId }),
		);
	}
	const [first] = namespaces.values();
	if (!first) return null;
	for (const [groupId, entry] of namespaces) {
		if (
			entry.groupId !== groupId ||
			entry.authorityId !== first.authorityId ||
			entry.relayAudienceId !== first.relayAudienceId
		)
			return null;
	}
	return namespaces;
}

function captureNamespaces(options: CoordinatorRelayAdmissionOptions) {
	const namespaces = consistentRelayNamespaces(options.namespaces);
	const [first] = namespaces?.values() ?? [];
	if (!namespaces || !first) return null;
	return {
		namespaces,
		authorityId: first.authorityId,
		relayAudienceId: first.relayAudienceId,
		externalPathname: options.externalPathname,
		ingressKey: options.ingressKey,
		open: options.open,
	};
}

/** A fresh three-field copy, so no caller can hold or mutate a stored entry. */
function namespaceFor(
	options: CapturedRelayAdmission,
	claim: PacketClaim | null,
): RelayAdmissionNamespace | undefined {
	const entry = claim ? options.namespaces.get(claim.groupId) : undefined;
	if (!entry) return undefined;
	const { authorityId, groupId, relayAudienceId } = entry;
	return { authorityId, groupId, relayAudienceId };
}

function admissionResponse(bytes = encodeRelayAdmissionReply(null), status = 200): Response {
	return new Response(new Uint8Array(bytes), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

type RelayBudgets = ReturnType<typeof createAdmissionBudgetAdapters>["relay"];

/**
 * Malformed packets still consume the dedicated ingress budget. Until a
 * configured group is known, only the shared (authority, audience) and
 * authority buckets are charged. No device budget or nonce is touched until
 * the decision verifies the proof.
 */
function reserveRouteIngress(
	budgets: RelayBudgets,
	options: CapturedRelayAdmission,
	claim: PacketClaim | null,
	namespace: RelayAdmissionNamespace | undefined,
) {
	const expected = claim?.expected ?? { kind: "admission", role: "relay" };
	if (!namespace)
		return budgets.reserveSharedIngress({
			authorityId: options.authorityId,
			relayAudienceId: options.relayAudienceId,
			expected,
		});
	return budgets.reserveIngress({ namespace, ingressKey: options.ingressKey, expected });
}

async function admissionCheck(
	request: Request,
	options: CapturedRelayAdmission | null,
): Promise<Response> {
	try {
		const bytes = await readAdmissionBody(request);
		if (!options) return admissionResponse(undefined, bytes === null ? 413 : 200);
		const packet = packetFromRequest(request, bytes ?? new Uint8Array());
		const claim = packetExpectation(packet);
		const namespace = namespaceFor(options, claim);
		const connection = options.open();
		try {
			const budgets = createAdmissionBudgetAdapters({
				database: { writeReturning: connection.database.insertReturning.bind(connection.database) },
			}).relay;
			const reserved = await reserveRouteIngress(budgets, options, claim, namespace);
			if (bytes === null) return admissionResponse(undefined, 413);
			if (bytes === undefined) return admissionResponse();
			const url = new URL(request.url);
			if (
				reserved !== "reserved" ||
				!claim ||
				!namespace ||
				url.search !== "" ||
				url.pathname !== options.externalPathname
			)
				return admissionResponse();
			const decision = await decideRelayAdmission(
				{
					packet,
					expected: claim.expected,
					deviceHeader: request.headers.get("X-Opencode-Device") ?? "",
					externalPathname: options.externalPathname,
					namespace,
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

/**
 * Keys namespaces by their own group ID. Single-group callers pass one entry.
 * Duplicate group IDs return an empty map, so the route registered with it
 * serves only denials instead of silently keeping one of the entries.
 */
export function relayAdmissionNamespaces(
	...namespaces: readonly RelayAdmissionNamespace[]
): ReadonlyMap<string, RelayAdmissionNamespace> {
	const map = new Map(namespaces.map((namespace) => [namespace.groupId, namespace]));
	return map.size === namespaces.length ? map : new Map();
}

/**
 * Optional capability only. This route never provisions policy, schema, or
 * readiness. An empty or inconsistent namespace map serves only denials.
 */
export function registerCoordinatorRelayAdmissionRoute(
	app: Hono,
	options?: CoordinatorRelayAdmissionOptions,
): void {
	if (!options) return;
	const captured = captureOptions(options);
	app.post("/v1/relay/admission-check", (c) => admissionCheck(c.req.raw, captured));
}
