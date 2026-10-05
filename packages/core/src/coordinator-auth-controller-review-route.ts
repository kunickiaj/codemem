import type { Context } from "hono";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import {
	type CoordinatorAuthControllerStore,
	type CoordinatorAuthControllerVerifiedSnapshot,
	captureVerifiedSnapshot,
	isAuthControllerId,
} from "./coordinator-auth-controller.js";
import type {
	CoordinatorEnrollment,
	CoordinatorInvite,
	CoordinatorStore,
} from "./coordinator-store-contract.js";

export type CoordinatorControllerReviewStore = CoordinatorStore &
	Pick<CoordinatorAuthControllerStore, "createAuthControllerAttestation">;
export interface CoordinatorControllerReviewDeps {
	config: CoordinatorAuthBrowserConfig;
	storeFactory: () => CoordinatorControllerReviewStore;
	adminSecret: () => string | null;
	readRequestBytes: (c: Context, maxBytes: number) => Promise<Uint8Array | null>;
	parseJsonObject: (raw: Uint8Array) => Record<string, unknown> | null;
	rateLimitedResponse: (
		c: Context,
		key: string,
		options: { authenticated: boolean },
	) => Response | null;
}
interface ReviewInput {
	group_id: string;
	device_id: string;
	identity_id: string;
	fingerprint: string;
	confirm_evidence_digest?: string;
}
export type CoordinatorControllerReviewReason =
	| "group_unavailable"
	| "enrollment_unavailable"
	| "key_mismatch"
	| "enrollment_identity_mismatch"
	| "invite_identity_mismatch"
	| "invite_evidence_invalid";
export interface CoordinatorControllerReviewPreview {
	state: "ready" | "needs_review";
	reasons: CoordinatorControllerReviewReason[];
	coordinator_id: string;
	evidence_digest?: string;
	enrollment: {
		device_id: string;
		display_name: string | null;
		fingerprint: string;
		identity_label: "none" | "matches";
	} | null;
	reviewed_invites: { invite_id: string; kind: "team_member" | "add_device" }[];
	reviewed_invite_count: number;
}
const PATH = "/v1/admin/auth-controller-reviews";
const FIELDS = ["group_id", "device_id", "identity_id", "fingerprint"] as const;
const ALLOWED_FIELDS: readonly string[] = [...FIELDS, "confirm_evidence_digest"];
function isHash(value: unknown): value is string {
	return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
function captureInput(data: Record<string, unknown> | null): ReviewInput | null {
	if (!data || Array.isArray(data)) return null;
	const keys = Reflect.ownKeys(data);
	if (keys.some((key) => typeof key !== "string" || !ALLOWED_FIELDS.includes(key))) return null;
	const copy: Record<string, string> = {};
	for (const key of keys) {
		if (typeof key !== "string") return null;
		const field = Object.getOwnPropertyDescriptor(data, key);
		if (!field || !Object.hasOwn(field, "value") || typeof field.value !== "string") return null;
		copy[key] = field.value;
	}
	if (!FIELDS.every((key) => Object.hasOwn(copy, key))) return null;
	const { group_id, device_id, identity_id, fingerprint } = copy;
	if (
		!isAuthControllerId(group_id) ||
		!isAuthControllerId(device_id) ||
		!isAuthControllerId(identity_id) ||
		!isHash(fingerprint)
	)
		return null;
	if (Object.hasOwn(copy, "confirm_evidence_digest") && !isHash(copy.confirm_evidence_digest))
		return null;
	const input: ReviewInput = {
		group_id,
		device_id,
		identity_id,
		fingerprint,
	};
	if (Object.hasOwn(copy, "confirm_evidence_digest"))
		input.confirm_evidence_digest = copy.confirm_evidence_digest;
	return input;
}
async function digestBytes(value: string): Promise<ArrayBuffer> {
	return globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}
async function hash(value: unknown): Promise<string> {
	const bytes = await digestBytes(JSON.stringify(value));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function authenticate(
	provided: string | undefined,
	configured: string | null,
): Promise<boolean> {
	if (!configured || !provided || provided.length > 8192) return false;
	// Native verification compares fixed-length MACs; no JS secret-string comparison.
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
function boundInvites(
	invites: CoordinatorInvite[],
	enrollment: CoordinatorEnrollment,
): CoordinatorInvite[] {
	return invites
		.filter(
			(invite) =>
				invite.group_id === enrollment.group_id &&
				invite.revoked_at === null &&
				!!invite.consumed_at &&
				(invite.invite_kind === "team_member" || invite.invite_kind === "add_device") &&
				invite.bound_device_id === enrollment.device_id &&
				invite.bound_public_key === enrollment.public_key &&
				invite.bound_fingerprint === enrollment.fingerprint,
		)
		.map((invite) => ({ ...invite }))
		.sort((a, b) => (a.invite_id < b.invite_id ? -1 : Number(a.invite_id > b.invite_id)));
}
function inviteIdentityMatches(invite: CoordinatorInvite, identityId: string): boolean {
	const authoritative =
		invite.invite_kind === "team_member" ? invite.assigned_identity_id : invite.target_identity_id;
	return authoritative === identityId && invite.recipient_actor_id === identityId;
}
function enrollmentReasons(
	enrollment: CoordinatorEnrollment | null,
	input: ReviewInput,
): CoordinatorControllerReviewReason[] {
	if (enrollment?.enabled !== 1) return ["enrollment_unavailable"];
	const reasons: CoordinatorControllerReviewReason[] = [];
	if (enrollment.fingerprint !== input.fingerprint) reasons.push("key_mismatch");
	if (enrollment.identity_id !== null && enrollment.identity_id !== input.identity_id)
		reasons.push("enrollment_identity_mismatch");
	return reasons;
}
async function preview(
	store: CoordinatorControllerReviewStore,
	input: ReviewInput,
	coordinatorId: string,
) {
	const groupResult = await store.getGroup(input.group_id);
	const group = groupResult ? { ...groupResult } : null;
	const enrollmentResult = await store.getEnrollment(input.group_id, input.device_id);
	const enrollment = enrollmentResult ? { ...enrollmentResult } : null;
	const reasons = enrollmentReasons(enrollment, input);
	if (!group || group.archived_at !== null) reasons.push("group_unavailable");
	const bound = enrollment ? boundInvites(await store.listInvites(input.group_id), enrollment) : [];
	if (bound.some((invite) => !inviteIdentityMatches(invite, input.identity_id)))
		reasons.push("invite_identity_mismatch");
	if (bound.some((invite) => !isHash(invite.reviewed_preview_digest)))
		reasons.push("invite_evidence_invalid");
	const invites = bound.filter((invite) => isHash(invite.reviewed_preview_digest));
	const verifiedSnapshot = verifiedInviteSnapshot(enrollment, invites);
	addSnapshotReasons(verifiedSnapshot, reasons);
	const result: CoordinatorControllerReviewPreview = {
		state: reasons.length ? "needs_review" : "ready",
		reasons,
		coordinator_id: coordinatorId,
		enrollment: null,
		reviewed_invite_count: invites.length,
		// Ten references fit the action's 16 KiB limit even with 256-character Unicode IDs.
		reviewed_invites: invites.slice(0, 10).map((invite) => ({
			invite_id: invite.invite_id,
			kind: invite.invite_kind as "team_member" | "add_device",
		})),
	};
	if (enrollment && !reasons.includes("enrollment_identity_mismatch"))
		result.enrollment = {
			device_id: enrollment.device_id,
			display_name: enrollment.display_name?.slice(0, 256) ?? null,
			fingerprint: enrollment.fingerprint,
			identity_label: enrollment.identity_id === null ? "none" : "matches",
		};
	if (result.state === "ready" && enrollment)
		result.evidence_digest = await hash([
			"codemem-controller-review-v1",
			coordinatorId,
			input.group_id,
			enrollment.device_id,
			enrollment.public_key,
			enrollment.fingerprint,
			input.identity_id,
			enrollment.identity_id,
			invites.map((invite) => [
				invite.invite_id,
				invite.invite_kind,
				invite.recipient_actor_id,
				invite.assigned_identity_id,
				invite.target_identity_id,
				invite.reviewed_preview_digest,
			]),
		]);
	return { result, enrollment, verifiedSnapshot };
}
function addSnapshotReasons(
	snapshot: CoordinatorAuthControllerVerifiedSnapshot,
	reasons: CoordinatorControllerReviewReason[],
): void {
	if (!captureVerifiedSnapshot(snapshot)) reasons.push("invite_evidence_invalid");
}
function verifiedInviteSnapshot(
	enrollment: CoordinatorEnrollment | null,
	invites: CoordinatorInvite[],
): CoordinatorAuthControllerVerifiedSnapshot {
	return {
		enrollmentIdentityId: enrollment?.identity_id ?? null,
		invites: invites.map((invite) => ({
			inviteId: invite.invite_id,
			kind: invite.invite_kind as "team_member" | "add_device",
			actorId: invite.recipient_actor_id as string,
			assignedIdentityId: invite.assigned_identity_id ?? null,
			targetIdentityId: invite.target_identity_id ?? null,
			digest: invite.reviewed_preview_digest as string,
		})),
	};
}
async function applyReview(
	c: Context,
	store: CoordinatorControllerReviewStore,
	input: ReviewInput,
	coordinatorId: string,
): Promise<Response> {
	const { result, enrollment, verifiedSnapshot } = await preview(store, input, coordinatorId);
	if (input.confirm_evidence_digest === undefined) return c.json(result);
	if (result.state !== "ready" || !enrollment || !result.evidence_digest)
		return c.json({ error: "needs_review", ...result }, 409);
	if (input.confirm_evidence_digest !== result.evidence_digest)
		return c.json({ error: "review_stale" }, 409);
	const attestationId = `controller-v1:${await hash([coordinatorId, input.group_id, input.device_id, input.fingerprint])}`;
	const reviewReceiptId = `review-v1:${await hash([attestationId, input.identity_id, result.evidence_digest])}`;
	const created = await store.createAuthControllerAttestation({
		attestationId,
		coordinatorId,
		identityId: input.identity_id,
		groupId: input.group_id,
		deviceId: input.device_id,
		publicKey: enrollment.public_key,
		fingerprint: enrollment.fingerprint,
		reviewReceiptId,
		evidenceDigest: result.evidence_digest,
		verifiedSnapshot,
	});
	if (created.kind === "rejected") {
		if (created.error === "enrollment_mismatch" || created.error === "review_stale")
			return c.json({ error: "review_stale" }, 409);
		if (created.error === "attestation_conflict" || created.error === "attestation_revoked")
			return c.json({ error: "already_reviewed_or_needs_review" }, 409);
		return c.json({ error: "review_unavailable" }, 403);
	}
	const row = created.attestation;
	return c.json(
		{
			state: created.kind,
			coordinator_id: row.coordinator_id,
			group_id: row.group_id,
			device_id: row.device_id,
			fingerprint: row.fingerprint,
			identity_id: row.identity_id,
			created_at: row.created_at,
		},
		created.kind === "created" ? 201 : 200,
	);
}
async function handleReview(c: Context, deps: CoordinatorControllerReviewDeps): Promise<Response> {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	c.header("X-Content-Type-Options", "nosniff");
	let store: CoordinatorControllerReviewStore | undefined;
	try {
		try {
			const provided = c.req.header("X-Codemem-Coordinator-Admin");
			const configured = deps.adminSecret();
			if (!(await authenticate(provided, configured))) {
				return (
					deps.rateLimitedResponse(c, "controller-review:anonymous", { authenticated: false }) ??
					c.json({ error: "unauthorized" }, 401)
				);
			}
			const limited = deps.rateLimitedResponse(c, "controller-review:admin", {
				authenticated: true,
			});
			if (limited) return limited;
			const raw = await deps.readRequestBytes(c, 4096);
			if (!raw) return c.json({ error: "body_too_large" }, 413);
			const input = captureInput(deps.parseJsonObject(raw));
			if (!input) return c.json({ error: "review_invalid_input" }, 400);
			store = deps.storeFactory();
			return await applyReview(c, store, input, deps.config.coordinatorId);
		} finally {
			await store?.close();
		}
	} catch {
		return c.json({ error: "review_unavailable" }, 503);
	}
}
/** Existing configured admin authority only; local evidence is not an authentication proof. */
export function registerCoordinatorAuthControllerReviewRoutes(
	app: { post(path: string, handler: (c: Context) => Promise<Response>): unknown },
	deps: CoordinatorControllerReviewDeps,
): void {
	if (!deps.config.enabled) return;
	const { enabled, coordinatorId, issuer, revision, redirectUri } = deps.config;
	const captured = {
		...deps,
		config: Object.freeze({ enabled, coordinatorId, issuer, revision, redirectUri }),
	};
	app.post(PATH, (c) => handleReview(c, captured));
}
