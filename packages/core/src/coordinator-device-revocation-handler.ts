import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type {
	CoordinatorCreateDeviceRevocationInput,
	CoordinatorCreateDeviceRevocationResult,
	CoordinatorDeviceRevocationRecord,
} from "./coordinator-device-revocation.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";

export type CoordinatorDeviceRevocationAction = "preview" | "commit";
function isAction(action: unknown): action is CoordinatorDeviceRevocationAction {
	return action === "preview" || action === "commit";
}
export interface CoordinatorDeviceRevocationHandlerOptions {
	store: Pick<CoordinatorStore, "getEnrollment" | "createDeviceRevocation">;
	/** Server composition only: never derive this from a request or enrollment. */
	trustedCoordinatorId: string | null;
	adminSecret?: string | null;
	/** Transport admission only, called after native admin authentication and context checks. */
	beforeBody?: (request: Request) => Response | null;
}
interface RevocationInput {
	group_id: string;
	device_id: string;
	expected_digest?: string;
}
export const COORDINATOR_DEVICE_REVOCATION_MAX_BODY_BYTES = 4096;
const MAX_BODY_BYTES = COORDINATOR_DEVICE_REVOCATION_MAX_BODY_BYTES;
const SCOPE = "whole_database_device_id_any_key_and_canonical_key_any_device_all_groups";
function response(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
function failure(error: string, status: number): Response {
	return response({ error }, status);
}
function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
async function digestBytes(value: string): Promise<ArrayBuffer> {
	return globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}
async function authenticate(provided: string | null, configured: string | null): Promise<boolean> {
	if (typeof configured !== "string" || !configured || !provided || provided.length > 8192)
		return false;
	// Match the controller-review native fixed-length MAC verification pattern.
	const [expected, actual] = await Promise.all([digestBytes(configured), digestBytes(provided)]);
	const key = await globalThis.crypto.subtle.importKey(
		"raw",
		expected,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	const signature = await globalThis.crypto.subtle.sign("HMAC", key, expected);
	return globalThis.crypto.subtle.verify("HMAC", key, signature, actual);
}
async function readBody(request: Request): Promise<Uint8Array | null> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
	const bytes = new Uint8Array(MAX_BODY_BYTES);
	let size = 0;
	let onAbort = () => {};
	try {
		// Resolve interruption so an abort before the first read cannot orphan a rejection.
		const aborted = new Promise<null>((resolve) => {
			onAbort = () => resolve(null);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
		while (true) {
			signal.throwIfAborted();
			const chunk = await Promise.race([reader.read(), aborted]);
			if (chunk === null) throw new Error("revocation_body_stopped");
			const { done, value } = chunk;
			if (done) {
				signal.throwIfAborted();
				return bytes.subarray(0, size);
			}
			if (value.byteLength > MAX_BODY_BYTES - size) return null;
			bytes.set(value, size);
			size += value.byteLength;
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		// Stream teardown must not extend a deadline or delay an oversized-body refusal.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
function parseInput(
	raw: Uint8Array,
	action: CoordinatorDeviceRevocationAction,
): RevocationInput | null {
	try {
		const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
		if (!data || typeof data !== "object" || Array.isArray(data)) return null;
		const fields =
			action === "commit"
				? ["group_id", "device_id", "expected_digest"]
				: ["group_id", "device_id"];
		const keys = Object.keys(data);
		if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) return null;
		if (!("group_id" in data) || !("device_id" in data)) return null;
		if (!isAuthControllerId(data.group_id) || !isAuthControllerId(data.device_id)) return null;
		const input: RevocationInput = { group_id: data.group_id, device_id: data.device_id };
		if (action === "commit") {
			if (!("expected_digest" in data) || !isDigest(data.expected_digest)) return null;
			input.expected_digest = data.expected_digest;
		}
		return input;
	} catch {
		return null;
	}
}
/** Existing canonical parsers intentionally accept invalid inner types/trailing bytes. */
function isStrictEd25519Key(publicKey: string): boolean {
	if (publicKey.length > 16384 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(publicKey.replaceAll("\t", "")))
		return false;
	const [type, encoded] = publicKey.trim().split(/\s+/);
	if (type !== "ssh-ed25519" || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
	try {
		const wire = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
		if (wire.length !== 51) return false;
		const view = new DataView(wire.buffer);
		return (
			view.getUint32(0) === 11 &&
			new TextDecoder().decode(wire.subarray(4, 15)) === "ssh-ed25519" &&
			view.getUint32(15) === 32
		);
	} catch {
		return false;
	}
}
async function evidenceDigest(
	coordinatorId: string,
	tuple: CoordinatorCreateDeviceRevocationInput,
	keyId: string,
): Promise<string> {
	const bytes = await digestBytes(
		JSON.stringify([
			"codemem-global-device-revocation",
			1,
			"revoke",
			coordinatorId,
			tuple.groupId,
			tuple.deviceId,
			tuple.publicKey,
			tuple.fingerprint,
			keyId,
		]),
	);
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
type RevocationReference = Pick<
	CoordinatorDeviceRevocationRecord,
	"subject_kind" | "subject_value" | "revocation_id" | "created_at"
>;
function isReceiptText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
function captureRevocationReferences(
	result: CoordinatorCreateDeviceRevocationResult,
	deviceId: string,
	keyId: string,
): RevocationReference[] | null {
	if (result?.kind !== "revoked" || !Array.isArray(result.records)) return null;
	// First retained subjects may have different revocation IDs and historical metadata.
	const references: RevocationReference[] = [];
	for (const [kind, value] of [
		["device_id", deviceId],
		["ed25519_key", keyId],
	] as const) {
		const matching = result.records.filter(
			(row) => row?.subject_kind === kind && row.subject_value === value,
		);
		if (matching.length !== 1) return null;
		const row = matching[0];
		if (!row) return null;
		const reference = {
			subject_kind: kind,
			subject_value: value,
			revocation_id: row.revocation_id,
			created_at: row.created_at,
		};
		if (!isReceiptText(reference.revocation_id) || !isReceiptText(reference.created_at))
			return null;
		references.push(reference);
	}
	return references;
}
async function applyAction(
	action: CoordinatorDeviceRevocationAction,
	store: CoordinatorDeviceRevocationHandlerOptions["store"],
	coordinatorId: string,
	input: RevocationInput,
): Promise<Response> {
	const includeDisabled = true;
	const enrollment = await store.getEnrollment(input.group_id, input.device_id, includeDisabled);
	if (!enrollment) return failure("revocation_target_unavailable", 409);
	// Copy the exact tuple before any crypto await; never refresh it during commit.
	const tuple = Object.freeze({
		groupId: enrollment.group_id,
		deviceId: enrollment.device_id,
		publicKey: enrollment.public_key,
		fingerprint: enrollment.fingerprint,
	});
	if (
		tuple.groupId !== input.group_id ||
		tuple.deviceId !== input.device_id ||
		typeof tuple.publicKey !== "string" ||
		!isStrictEd25519Key(tuple.publicKey) ||
		typeof tuple.fingerprint !== "string" ||
		!tuple.fingerprint ||
		tuple.fingerprint.includes("\0")
	)
		return failure("revocation_target_unavailable", 409);
	const keyId = await ed25519KeyId(tuple.publicKey);
	if (!keyId) return failure("revocation_target_unavailable", 409);
	const digest = await evidenceDigest(coordinatorId, tuple, keyId);
	const subjects = {
		version: 1,
		coordinator_id: coordinatorId,
		group_id: tuple.groupId,
		device_id: tuple.deviceId,
		key_id: keyId,
		scope: SCOPE,
	};
	if (action === "preview")
		return response({ state: "ready", ...subjects, expected_digest: digest });
	if (input.expected_digest !== digest) return failure("revocation_preview_stale", 409);
	const result = await store.createDeviceRevocation(tuple);
	if (result?.kind === "rejected" && result.error === "enrollment_mismatch")
		return failure("revocation_preview_stale", 409);
	const revocations = captureRevocationReferences(result, tuple.deviceId, keyId);
	if (!revocations) return failure("device_revocation_incomplete", 503);
	return response({ state: "revoked", ...subjects, revocations });
}

/**
 * Internal capability. Transport registration and per-request store ownership live
 * in the runtime route adapter; direct callers retain ownership of their store.
 */
export function createCoordinatorDeviceRevocationHandler(
	options: CoordinatorDeviceRevocationHandlerOptions,
): (action: CoordinatorDeviceRevocationAction, request: Request) => Promise<Response> {
	const fixed = Object.freeze({
		store: options.store,
		trustedCoordinatorId: options.trustedCoordinatorId,
		adminSecret: options.adminSecret ?? null,
		beforeBody: options.beforeBody,
	});
	return async (action: CoordinatorDeviceRevocationAction, request: Request): Promise<Response> => {
		const { store, trustedCoordinatorId, adminSecret } = fixed;
		try {
			if (!(await authenticate(request.headers.get("X-Codemem-Coordinator-Admin"), adminSecret)))
				return failure("unauthorized", 401);
			if (!isAuthControllerId(trustedCoordinatorId) || !store)
				return failure("revocation_unavailable", 503);
			if (!isAction(action)) return failure("revocation_invalid_input", 400);
			const admission = fixed.beforeBody?.(request);
			if (admission) return admission;
			const raw = await readBody(request);
			if (!raw) return failure("body_too_large", 413);
			const input = parseInput(raw, action);
			if (!input) return failure("revocation_invalid_input", 400);
			return await applyAction(action, store, trustedCoordinatorId, input);
		} catch {
			// A lost receipt can follow a committed write: no rollback or compensation claim.
			return failure("device_revocation_incomplete", 503);
		}
	};
}
