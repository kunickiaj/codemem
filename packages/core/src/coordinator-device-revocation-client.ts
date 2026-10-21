import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import { RemoteCoordinatorRequestError } from "./coordinator-actions.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { capture, isHash } from "./coordinator-auth-link-input.js";
import { requestJson } from "./sync-http-client.js";

export const COORDINATOR_DEVICE_REVOCATION_SCOPE =
	"whole_database_device_id_any_key_and_canonical_key_any_device_all_groups";

interface Subjects {
	version: 1;
	coordinator_id: string;
	group_id: string;
	device_id: string;
	key_id: string;
	scope: typeof COORDINATOR_DEVICE_REVOCATION_SCOPE;
}
export interface CoordinatorDeviceRevocationPreview extends Subjects {
	state: "ready";
	expected_digest: string;
}
export interface CoordinatorDeviceRevocationReference {
	subject_kind: "device_id" | "ed25519_key";
	subject_value: string;
	revocation_id: string;
	created_at: string;
}
export interface CoordinatorDeviceRevocationCommit extends Subjects {
	state: "revoked";
	revocations: [CoordinatorDeviceRevocationReference, CoordinatorDeviceRevocationReference];
}
export interface CoordinatorRevokeDeviceActionOptions {
	remoteUrl: string;
	adminSecret: string;
	groupId: string;
	deviceId: string;
	expectedDigest?: string;
	expectedContext?: { coordinatorId: string; keyId: string };
	timeoutS?: number;
	/** Called only after validation, immediately before dispatching the commit request. */
	onDispatch?: () => void;
}

function receiptText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
function reference(value: unknown, kind: "device_id" | "ed25519_key", subject: string) {
	const row = capture(value, ["subject_kind", "subject_value", "revocation_id", "created_at"]);
	if (
		!row ||
		row.subject_kind !== kind ||
		row.subject_value !== subject ||
		!receiptText(row.revocation_id) ||
		!receiptText(row.created_at)
	)
		throw new Error("revocation_response_invalid");
	return {
		subject_kind: kind,
		subject_value: subject,
		revocation_id: row.revocation_id,
		created_at: row.created_at,
	};
}
function parseResponse(
	payload: Record<string, unknown> | null,
	request: Pick<
		CoordinatorRevokeDeviceActionOptions,
		"groupId" | "deviceId" | "expectedDigest" | "expectedContext"
	>,
): CoordinatorDeviceRevocationPreview | CoordinatorDeviceRevocationCommit {
	const commit = request.expectedDigest !== undefined;
	const data = capture(payload, [
		"state",
		"version",
		"coordinator_id",
		"group_id",
		"device_id",
		"key_id",
		"scope",
		commit ? "revocations" : "expected_digest",
	]);
	if (
		!data ||
		!payload ||
		Object.hasOwn(payload, "error") ||
		data.version !== 1 ||
		data.scope !== COORDINATOR_DEVICE_REVOCATION_SCOPE ||
		data.group_id !== request.groupId ||
		data.device_id !== request.deviceId ||
		!isAuthControllerId(data.coordinator_id) ||
		!isHash(data.key_id)
	)
		throw new Error("revocation_response_invalid");
	const subjects: Subjects = {
		version: 1,
		scope: COORDINATOR_DEVICE_REVOCATION_SCOPE,
		coordinator_id: data.coordinator_id,
		group_id: request.groupId,
		device_id: request.deviceId,
		key_id: data.key_id,
	};
	if (!commit) {
		if (data.state !== "ready" || !isHash(data.expected_digest))
			throw new Error("revocation_response_invalid");
		return { state: "ready", ...subjects, expected_digest: data.expected_digest };
	}
	return parseCommit(data, subjects, request.expectedContext);
}

function parseCommit(
	data: Record<string, unknown>,
	subjects: Subjects,
	expectedContext: CoordinatorRevokeDeviceActionOptions["expectedContext"],
): CoordinatorDeviceRevocationCommit {
	if (
		data.state !== "revoked" ||
		!Array.isArray(data.revocations) ||
		data.revocations.length !== 2 ||
		(expectedContext &&
			(subjects.coordinator_id !== expectedContext.coordinatorId ||
				subjects.key_id !== expectedContext.keyId))
	)
		throw new Error("revocation_response_invalid");
	return {
		state: "revoked",
		...subjects,
		revocations: [
			reference(data.revocations[0], "device_id", subjects.device_id),
			reference(data.revocations[1], "ed25519_key", subjects.key_id),
		],
	};
}

function expectedSubjects(value: unknown): CoordinatorRevokeDeviceActionOptions["expectedContext"] {
	if (value === undefined) return undefined;
	const context = capture(value, ["coordinatorId", "keyId"]);
	if (!context || !isAuthControllerId(context.coordinatorId) || !isHash(context.keyId))
		throw new Error("revocation_invalid_input");
	return { coordinatorId: context.coordinatorId, keyId: context.keyId };
}
function validateCredential(value: unknown): asserts value is string {
	if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value))
		throw new Error("revocation_admin_required");
	try {
		// Header validation must finish before the commit-dispatch callback.
		new Headers({ "X-Codemem-Coordinator-Admin": value });
	} catch {
		throw new Error("revocation_admin_required");
	}
}
function prepare(opts: CoordinatorRevokeDeviceActionOptions) {
	// Pin phase, target, credentials and expected context before the first await.
	const {
		remoteUrl,
		adminSecret,
		groupId,
		deviceId,
		expectedDigest,
		timeoutS = 3,
		onDispatch,
	} = opts;
	const expectedContext = expectedSubjects(opts.expectedContext);
	const origin = normalizeCoordinatorAccountLinkOrigin(remoteUrl);
	if (
		!origin ||
		!isAuthControllerId(groupId) ||
		!isAuthControllerId(deviceId) ||
		(expectedDigest !== undefined && !isHash(expectedDigest)) ||
		(expectedContext && expectedDigest === undefined) ||
		!Number.isFinite(timeoutS) ||
		timeoutS < 1 ||
		timeoutS > 3600
	)
		throw new Error("revocation_invalid_input");
	validateCredential(adminSecret);
	const commit = expectedDigest !== undefined;
	const fallback = commit ? "revocation_outcome_unknown" : "revocation_unavailable";
	const body: Record<string, unknown> = { group_id: groupId, device_id: deviceId };
	if (commit) body.expected_digest = expectedDigest;
	return {
		origin,
		adminSecret,
		groupId,
		deviceId,
		expectedDigest,
		expectedContext,
		timeoutS,
		onDispatch,
		commit,
		fallback,
		body,
	};
}
function denialCode(status: number, code: unknown, fallback: string): string {
	if (
		status === 409 &&
		(code === "revocation_preview_stale" || code === "revocation_target_unavailable")
	)
		return code;
	return fallback;
}
/** Network preview by default. Explicit digest commits once; never redirects or retries. */
export async function coordinatorRevokeDeviceAction(
	opts: CoordinatorRevokeDeviceActionOptions,
): Promise<CoordinatorDeviceRevocationPreview | CoordinatorDeviceRevocationCommit> {
	const request = prepare(opts);
	const { origin, adminSecret, timeoutS, onDispatch, commit, fallback, body } = request;
	try {
		if (commit) onDispatch?.();
		const [status, payload] = await requestJson(
			"POST",
			`${origin}/v1/admin/devices/${commit ? "revoke" : "revoke-preview"}`,
			{
				headers: { "X-Codemem-Coordinator-Admin": adminSecret },
				body,
				timeoutS,
				maxResponseBytes: 16384,
			},
		);
		if (status !== 200) {
			throw new RemoteCoordinatorRequestError(status, denialCode(status, payload?.error, fallback));
		}
		return parseResponse(payload, request);
	} catch (error) {
		if (error instanceof RemoteCoordinatorRequestError)
			throw new RemoteCoordinatorRequestError(
				error.status,
				denialCode(error.status, error.code, fallback),
			);
		// Do not attach response bodies, transport messages, credentials or causes.
		throw new Error(fallback);
	}
}
