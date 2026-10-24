import { isAuthControllerId } from "./coordinator-auth-controller.js";

const SCOPE = "historical_included_owner_labels_only";
interface ResolutionOptions {
	purpose?: "existing_account_owner";
	resolutionScope?: typeof SCOPE;
	groupId: string;
	deviceId: string;
	identityId: string;
	fingerprint: string;
	confirmEvidenceDigest?: string;
	confirmOwnerResolutionDigest?: string;
	assertBeforeOwnerResolutionConfirm?: () => void;
}
type PostReview = (body: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
function isHash(value: unknown): value is string {
	return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}

export function validateResolutionOptions(opts: ResolutionOptions): void {
	if (
		Object.hasOwn(opts, "assertBeforeOwnerResolutionConfirm") &&
		typeof opts.assertBeforeOwnerResolutionConfirm !== "function"
	)
		throw new Error("owner_resolution_assertion_invalid");
	if (opts.resolutionScope === undefined && !Object.hasOwn(opts, "resolutionScope")) {
		if (Object.hasOwn(opts, "assertBeforeOwnerResolutionConfirm"))
			throw new Error("owner_resolution_assertion_requires_scope");
		if (Object.hasOwn(opts, "confirmOwnerResolutionDigest"))
			throw new Error("owner_resolution_confirm_requires_scope");
		return;
	}
	if (opts.resolutionScope !== SCOPE || opts.purpose !== "existing_account_owner")
		throw new Error("owner_resolution_scope_or_purpose_invalid");
	if (Object.hasOwn(opts, "confirmEvidenceDigest"))
		throw new Error("owner_resolution_confirm_invalid");
	if (
		!isAuthControllerId(opts.groupId) ||
		!isAuthControllerId(opts.deviceId) ||
		!isAuthControllerId(opts.identityId) ||
		!isHash(opts.fingerprint)
	)
		throw new Error("owner_resolution_selection_invalid");
	if (
		Object.hasOwn(opts, "confirmOwnerResolutionDigest") &&
		!isHash(opts.confirmOwnerResolutionDigest)
	)
		throw new Error("owner_resolution_confirm_invalid");
}

function validateEcho(
	payload: Record<string, unknown> | null,
	opts: ResolutionOptions,
): asserts payload is Record<string, unknown> {
	if (payload?.purpose !== "existing_account_owner" || payload.resolution_scope !== SCOPE)
		throw new Error("owner_resolution_scope_unsupported");
	if (
		payload.group_id !== opts.groupId ||
		payload.device_id !== opts.deviceId ||
		payload.identity_id !== opts.identityId ||
		payload.fingerprint !== opts.fingerprint
	)
		throw new Error("owner_resolution_selection_mismatch");
	if (
		!isAuthControllerId(payload.coordinator_id) ||
		!Array.isArray(payload.reasons) ||
		!payload.reasons.every((reason) => typeof reason === "string")
	)
		throw new Error("owner_resolution_response_invalid");
}

function validReceipt(value: unknown, field: string): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const receipt = value as Record<string, unknown>;
	const id = receipt[field];
	return (
		isAuthControllerId(id) &&
		(receipt.disposition === "created" || receipt.disposition === "reused") &&
		isHash(receipt.evidence_digest) &&
		typeof receipt.created_at === "string" &&
		Number.isFinite(Date.parse(receipt.created_at))
	);
}

function validateReceipts(payload: Record<string, unknown>): void {
	const id = payload.attestation_id;
	if (
		!isAuthControllerId(id) ||
		!validReceipt(payload.recovery_receipt, "review_receipt_id") ||
		!validReceipt(payload.owner_resolution, "resolution_id")
	)
		throw new Error("owner_resolution_receipt_invalid");
}

function validatePreview(
	payload: Record<string, unknown> | null,
	opts: ResolutionOptions,
): Record<string, unknown> {
	validateEcho(payload, opts);
	if (payload.state === "needs_review") {
		if (
			!Array.isArray(payload.reasons) ||
			payload.reasons.length === 0 ||
			Object.hasOwn(payload, "owner_resolution_digest")
		)
			throw new Error("owner_resolution_response_invalid");
		return payload;
	}
	if (
		(payload.state !== "ready" && payload.state !== "restored") ||
		!isHash(payload.owner_resolution_digest)
	)
		throw new Error("owner_resolution_response_invalid");
	if (payload.state === "restored") validateReceipts(payload);
	if (!Array.isArray(payload.reasons) || payload.reasons.length !== 0)
		throw new Error("owner_resolution_response_invalid");
	return payload;
}

export async function scopedResolutionReview(
	opts: ResolutionOptions,
	body: Record<string, unknown>,
	post: PostReview,
): Promise<Record<string, unknown>> {
	const scopedBody = { ...body, purpose: "existing_account_owner", resolution_scope: SCOPE };
	const preview = validatePreview(await post(scopedBody), opts);
	if (opts.confirmOwnerResolutionDigest === undefined) return preview;
	if (
		preview.state === "needs_review" ||
		preview.owner_resolution_digest !== opts.confirmOwnerResolutionDigest
	)
		throw new Error("review_stale: preview changed or needs review");
	opts.assertBeforeOwnerResolutionConfirm?.();
	try {
		const result = await post({
			...scopedBody,
			confirm_owner_resolution_digest: opts.confirmOwnerResolutionDigest,
		});
		validateEcho(result, opts);
		if (
			result.state !== "ready" ||
			result.owner_resolution_digest !== opts.confirmOwnerResolutionDigest
		)
			throw new Error("owner_resolution_response_invalid");
		validateReceipts(result);
		return result;
	} catch (error) {
		// Only an explicit stale denial proves that this confirmation was rejected.
		if (
			error instanceof Error &&
			"status" in error &&
			error.status === 409 &&
			"code" in error &&
			error.code === "review_stale"
		)
			throw error;
		throw new Error("owner_resolution_outcome_unknown: preview status before confirming again");
	}
}
