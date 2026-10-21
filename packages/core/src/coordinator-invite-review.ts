import { hostname } from "node:os";
import Sqlite from "better-sqlite3";
import {
	decodeInvitePayload,
	extractInvitePayload,
	type InvitePayload,
} from "./coordinator-invites.js";
import {
	type CoordinatorRecipientInviteKind,
	recipientInviteAuthoritativeIdentityId,
} from "./coordinator-store-contract.js";
import { resolveDbPath } from "./db.js";
import { readCodememConfigFile, readCodememConfigFileAtPath } from "./observer-config.js";
import { friendlyDeviceName, normalizeIdentityDisplayName } from "./project-invite-identity.js";
import {
	assertAddDeviceIdentityAdoptionAllowed,
	previewRecipientPolicyOnboardingFromReviewedIntent,
	type RecipientPolicyOnboardingPreviewV1,
	type RecipientPolicyReviewedIntentPreviewRequestV1,
} from "./recipient-policy-onboarding.js";
import {
	type RecipientReviewedIntentV1,
	verifyRecipientReviewedIntent,
} from "./recipient-reviewed-intent.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { requestJson } from "./sync-http-client.js";
import { loadPublicKey, loadRuntimeSigningPublicKey } from "./sync-identity.js";

export interface CoordinatorInviteProfileOptions {
	recipientActorId?: string | null;
	recipientDisplayName?: string | null;
	deviceDisplayName?: string | null;
}

export interface CoordinatorInviteReviewOptions extends CoordinatorInviteProfileOptions {
	inviteValue: string;
	dbPath?: string | null;
	keysDir?: string | null;
	configPath?: string | null;
}

export interface CoordinatorInviteReview {
	status: "review";
	coordinator_url: string;
	group_id: string;
	kind: string;
	target_identity_id: string;
	recipient_display_name: string;
	device_id: string;
	device_display_name: string;
	device_key_fingerprint: string;
	journey: RecipientPolicyOnboardingPreviewV1["journey"];
	team: RecipientPolicyOnboardingPreviewV1["team"];
	projects: RecipientPolicyOnboardingPreviewV1["projects"];
	excluded_projects: RecipientPolicyOnboardingPreviewV1["excludedProjects"];
	reviewed_onboarding_digest: string;
}

export function decodeInviteForImport(inviteValue: string): InvitePayload {
	try {
		return decodeInvitePayload(extractInvitePayload(inviteValue));
	} catch {
		throw new Error("invite_invalid");
	}
}

export function isRecipientInvite(payload: InvitePayload): boolean {
	return payload.kind === "team_member" || payload.kind === "add_device";
}

/** Share identity and name normalization between review and acceptance. */
export function resolveInviteProfile(
	payload: InvitePayload,
	config: Record<string, unknown>,
	deviceId: string,
	opts: CoordinatorInviteProfileOptions,
) {
	const recipientInvite = isRecipientInvite(payload);
	const fallbackDeviceName = friendlyDeviceName({
		explicitName: String(config.sync_device_name ?? ""),
		osName: hostname(),
		fallbackSeed: deviceId,
	});
	const recipientActorId = resolveInviteActor(payload, config, deviceId, opts);
	let recipientDisplayName =
		String(opts.recipientDisplayName ?? config.actor_display_name ?? deviceId).trim() || deviceId;
	let displayName = recipientDisplayName;
	if (payload.operation_id || recipientInvite) {
		recipientDisplayName =
			payload.kind === "add_device"
				? ""
				: normalizeIdentityDisplayName(
						String(opts.recipientDisplayName ?? config.actor_display_name ?? fallbackDeviceName),
						"recipient_display_name",
					);
		displayName = normalizeIdentityDisplayName(
			String(opts.deviceDisplayName ?? fallbackDeviceName),
			"device_display_name",
		);
	}
	return { recipientActorId, recipientDisplayName, displayName };
}

function resolveInviteActor(
	payload: InvitePayload,
	config: Record<string, unknown>,
	deviceId: string,
	opts: CoordinatorInviteProfileOptions,
): string {
	const explicit = String(opts.recipientActorId ?? "").trim();
	const configured = String(config.actor_id ?? "").trim();
	if (!isRecipientInvite(payload)) return explicit || configured || `local:${deviceId}`;
	const authoritative = recipientInviteAuthoritativeIdentityId({
		kind: payload.kind as CoordinatorRecipientInviteKind,
		assigned_identity_id: payload.assigned_identity_id,
		target_identity_id: payload.target_identity_id,
	});
	if (
		!authoritative ||
		(explicit && explicit !== authoritative) ||
		(configured && configured !== authoritative && configured !== `local:${deviceId}`)
	)
		throw new Error("invite_identity_conflict");
	return authoritative;
}

export function recipientInviteOnboardingRequest(opts: {
	payload: InvitePayload;
	identityId: string;
	deviceId: string;
	publicKey: string;
	deviceDisplayName: string;
}): RecipientPolicyReviewedIntentPreviewRequestV1 {
	const base = {
		version: 1 as const,
		invitationId: String(opts.payload.token),
		identityId: opts.identityId,
		deviceId: opts.deviceId,
		devicePublicKey: opts.publicKey,
		deviceDisplayName: opts.deviceDisplayName,
	};
	return opts.payload.kind === "team_member"
		? { ...base, journey: "team", teamId: String(opts.payload.policy_team_id ?? "") }
		: { ...base, journey: "add_device" };
}

export async function previewValidatedRecipientInvite(opts: {
	payload: InvitePayload;
	response: Record<string, unknown> | null;
	identityId: string;
	deviceId: string;
	publicKey: string;
	deviceDisplayName: string;
	recipientDisplayName: string;
	requireResponseIdentity?: boolean;
}): Promise<{
	reviewedIntent: RecipientReviewedIntentV1;
	preview: RecipientPolicyOnboardingPreviewV1;
	persistedRecipientDisplayName: string;
}> {
	const responseDigest = String(opts.response?.reviewed_preview_digest ?? "").trim();
	const authoritative = (value: Record<string, unknown> | InvitePayload | null) =>
		recipientInviteAuthoritativeIdentityId({
			kind: opts.payload.kind as CoordinatorRecipientInviteKind,
			assigned_identity_id: value?.assigned_identity_id,
			target_identity_id: value?.target_identity_id,
		});
	const identityId = authoritative(opts.payload);
	if (
		String(opts.response?.kind ?? "").trim() !== opts.payload.kind ||
		!identityId ||
		opts.identityId !== identityId ||
		authoritative(opts.response) !== identityId ||
		(opts.requireResponseIdentity &&
			String(opts.response?.identity_id ?? "").trim() !== identityId) ||
		responseDigest !== String(opts.payload.reviewed_preview_digest ?? "").trim() ||
		(opts.payload.kind === "team_member" &&
			String(opts.response?.policy_team_id ?? "").trim() !==
				String(opts.payload.policy_team_id ?? "").trim())
	) {
		throw new Error("recipient_invite_intent_mismatch");
	}
	let reviewedIntent: RecipientReviewedIntentV1;
	try {
		reviewedIntent = await verifyRecipientReviewedIntent(opts.response?.reviewed_intent, {
			target:
				opts.payload.kind === "team_member"
					? { kind: "team_member", policyTeamId: String(opts.payload.policy_team_id ?? "").trim() }
					: {
							kind: "add_device",
							targetIdentityId: String(opts.payload.target_identity_id ?? "").trim(),
						},
			digest: responseDigest,
		});
	} catch {
		throw new Error("recipient_invite_intent_mismatch");
	}
	const preview = previewRecipientPolicyOnboardingFromReviewedIntent(
		reviewedIntent,
		recipientInviteOnboardingRequest(opts),
	);
	return {
		reviewedIntent,
		preview,
		persistedRecipientDisplayName:
			reviewedIntent.journey === "add_device"
				? reviewedIntent.targetIdentity.displayName
				: opts.recipientDisplayName,
	};
}

function stripInviteTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === "/") end--;
	return value.slice(0, end);
}

export function inviteImportTransportError(error: unknown): Error {
	const name = typeof error === "object" && error && "name" in error ? String(error.name) : "";
	const message = error instanceof Error ? error.message : String(error ?? "");
	if (name === "TimeoutError" || /timed? out/i.test(message)) {
		return new Error(
			"Invite import timed out contacting the coordinator. Check network access and try again.",
		);
	}
	if (name === "TypeError" || /fetch failed|network/i.test(message)) {
		return new Error(
			"Invite import could not reach the coordinator. Check network access and use the original coordinator URL; redirects are not accepted.",
		);
	}
	return new Error(
		"Invite import transport failed. Check coordinator access and retry using the original URL; redirects are not accepted.",
	);
}

export async function inspectRecipientInvite(
	coordinatorUrl: string,
	token: string,
): Promise<Record<string, unknown> | null> {
	let status: number;
	let inspection: Record<string, unknown> | null;
	try {
		[status, inspection] = await requestJson(
			"POST",
			`${stripInviteTrailingSlashes(coordinatorUrl)}/v1/invites/inspect`,
			{ body: { token }, timeoutS: 10, redirect: "error" },
		);
	} catch (error) {
		throw inviteImportTransportError(error);
	}
	if (status >= 200 && status < 300) return inspection;
	const detail = inspection?.error;
	if (
		typeof detail === "string" &&
		[
			"invite_already_bound",
			"invite_expired",
			"invite_invalid",
			"recipient_invite_review_unavailable",
		].includes(detail)
	)
		throw new Error(detail);
	throw new Error(`Invite inspection failed (${status}).`);
}

function readReviewDevice(db: Sqlite.Database, keysDir: string | undefined) {
	const rows = db
		.prepare("SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 2")
		.all() as Array<{ device_id: string; public_key: string; fingerprint: string }>;
	const row = rows[0];
	if (rows.length !== 1 || !row) throw new Error("invite_review_profile_required");
	const publicKey = loadPublicKey(keysDir);
	const signingKey = loadRuntimeSigningPublicKey(db, { deviceId: row.device_id, keysDir });
	if (
		!publicKey ||
		!signingKey ||
		fingerprintPublicKey(publicKey) !== row.fingerprint ||
		fingerprintPublicKey(signingKey) !== row.fingerprint
	)
		throw new Error("invite_review_profile_required");
	return { deviceId: row.device_id, publicKey, fingerprint: row.fingerprint };
}

function readReviewProfile(
	opts: CoordinatorInviteReviewOptions,
	payload: InvitePayload,
	config: Record<string, unknown>,
) {
	const keysDir = opts.keysDir ?? (process.env.CODEMEM_KEYS_DIR?.trim() || undefined);
	let db: Sqlite.Database;
	try {
		db = new Sqlite(resolveDbPath(opts.dbPath ?? undefined), {
			readonly: true,
			fileMustExist: true,
		});
	} catch {
		throw new Error("invite_review_profile_required");
	}
	let device: ReturnType<typeof readReviewDevice>;
	let profile: ReturnType<typeof resolveInviteProfile>;
	try {
		try {
			device = readReviewDevice(db, keysDir);
		} catch {
			throw new Error("invite_review_profile_required");
		}
		profile = resolveInviteProfile(payload, config, device.deviceId, opts);
		assertAddDeviceIdentityAdoptionAllowed(db, profile.recipientActorId, device.deviceId);
	} finally {
		db.close();
	}
	return { device, profile };
}

/** Inspect without consuming the invitation or creating/repairing the local profile. */
export async function coordinatorReviewInviteAction(
	opts: CoordinatorInviteReviewOptions,
): Promise<CoordinatorInviteReview> {
	const payload = decodeInviteForImport(opts.inviteValue);
	if (!isRecipientInvite(payload)) throw new Error("recipient_invite_review_required");
	const coordinatorUrl = String(payload.coordinator_url ?? "").trim();
	if (!coordinatorUrl) throw new Error("invite_invalid");
	const config = opts.configPath
		? readCodememConfigFileAtPath(opts.configPath)
		: readCodememConfigFile();
	const existingCoordinator = stripInviteTrailingSlashes(
		String(config.sync_coordinator_url ?? "").trim(),
	);
	if (existingCoordinator && existingCoordinator !== stripInviteTrailingSlashes(coordinatorUrl))
		throw new Error("invite_coordinator_conflict");
	const { device, profile } = readReviewProfile(opts, payload, config);
	const response = await inspectRecipientInvite(coordinatorUrl, String(payload.token));
	const { preview, persistedRecipientDisplayName } = await previewValidatedRecipientInvite({
		payload,
		response,
		identityId: profile.recipientActorId,
		deviceId: device.deviceId,
		publicKey: device.publicKey,
		deviceDisplayName: profile.displayName,
		recipientDisplayName: profile.recipientDisplayName,
	});
	return {
		status: "review",
		coordinator_url: coordinatorUrl,
		group_id: String(payload.group_id),
		kind: payload.kind,
		target_identity_id: profile.recipientActorId,
		recipient_display_name: persistedRecipientDisplayName,
		device_id: device.deviceId,
		device_display_name: preview.binding.deviceDisplayName,
		device_key_fingerprint: preview.binding.deviceKeyFingerprint,
		journey: preview.journey,
		team: preview.team,
		projects: preview.projects,
		excluded_projects: preview.excludedProjects,
		reviewed_onboarding_digest: preview.reviewedOnboardingDigest,
	};
}
