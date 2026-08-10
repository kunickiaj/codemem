import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import {
	coordinatorCreateAddDeviceInviteAction,
	coordinatorCreateGroupAction,
	coordinatorCreateInviteAction,
	coordinatorCreateScopeAction,
	coordinatorDisableDeviceAction,
	coordinatorEnableDeviceAction,
	coordinatorEnrollDeviceAction,
	coordinatorGrantScopeMembershipAction,
	coordinatorImportInviteAction,
	coordinatorListConsumedTeamInvitesAction,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	coordinatorListReviewedRecipientInviteEvidenceAction,
	coordinatorListScopeMembershipsAction,
	coordinatorListScopesAction,
	coordinatorRemoveDeviceAction,
	coordinatorRenameDeviceAction,
	coordinatorRevokeScopeMembershipAction,
	coordinatorUpdateScopeAction,
	isPeerTrustBindingCompatible,
} from "./coordinator-actions.js";
import { encodeInvitePayload } from "./coordinator-invites.js";
import { connect } from "./db.js";
import { initDatabase } from "./maintenance.js";
import { readCodememConfigFileAtPath, writeCodememConfigFile } from "./observer-config.js";
import {
	isProjectSyncEnablementError,
	PROJECT_INVITE_PENDING_STATUS,
	PROJECT_SYNC_ENABLEMENT_FAILED,
	PROJECT_SYNC_ENABLEMENT_FAILURE_DETAIL,
	ProjectSyncEnablementError,
} from "./project-invite-acceptance.js";
import { previewRecipientPolicyOnboardingFromReviewedIntent } from "./recipient-policy-onboarding.js";
import {
	canonicalRecipientReviewedIntentJson,
	type RecipientReviewedIntentV1,
	recipientReviewedIntentDigest,
} from "./recipient-reviewed-intent.js";
import { managedProjectScopeId, shareProjectSetDigest } from "./share-operation.js";
import { verifySignature } from "./sync-auth.js";
import { ensureDeviceIdentity, fingerprintPublicKey, loadPublicKey } from "./sync-identity.js";

type TeamReviewedIntent = Extract<RecipientReviewedIntentV1, { journey: "team" }>;
type AddDeviceReviewedIntent = Extract<RecipientReviewedIntentV1, { journey: "add_device" }>;

function teamReviewedIntent(teamId = "policy-team-1"): TeamReviewedIntent {
	return {
		version: 1,
		journey: "team",
		team: { teamId, displayName: "Product", futureProjectsInherit: true },
		projects: [],
		excludedProjects: [],
	};
}

function addDeviceReviewedIntent(identityId: string): AddDeviceReviewedIntent {
	return {
		version: 1,
		journey: "add_device",
		targetIdentity: { identityId, displayName: "Existing Person" },
		projects: [],
		excludedProjects: [],
	};
}

function reviewedOnboardingDigestForRecipientInvite(opts: {
	dbPath: string;
	keysDir: string;
	invitationId: string;
	identityId: string;
	deviceDisplayName: string;
	reviewedIntent: RecipientReviewedIntentV1;
}): string {
	initDatabase(opts.dbPath);
	const conn = connect(opts.dbPath);
	let deviceId = "";
	try {
		[deviceId] = ensureDeviceIdentity(conn, { keysDir: opts.keysDir });
	} finally {
		conn.close();
	}
	const devicePublicKey = loadPublicKey(opts.keysDir);
	if (!devicePublicKey) throw new Error("test public key missing");
	const base = {
		version: 1 as const,
		invitationId: opts.invitationId,
		identityId: opts.identityId,
		deviceId,
		devicePublicKey,
		deviceDisplayName: opts.deviceDisplayName,
	};
	const request =
		opts.reviewedIntent.journey === "team"
			? { ...base, journey: "team" as const, teamId: opts.reviewedIntent.team.teamId }
			: { ...base, journey: "add_device" as const };
	return previewRecipientPolicyOnboardingFromReviewedIntent(opts.reviewedIntent, request)
		.reviewedOnboardingDigest;
}

describe("coordinator local admin actions", () => {
	let tmpDir: string;
	let dbPath: string;
	let prevConfigPath: string | undefined;
	let prevDbPath: string | undefined;
	let prevKeysDir: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "coord-actions-test-"));
		dbPath = join(tmpDir, "coordinator.sqlite");
		prevConfigPath = process.env.CODEMEM_CONFIG;
		prevDbPath = process.env.CODEMEM_DB;
		prevKeysDir = process.env.CODEMEM_KEYS_DIR;
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (prevConfigPath == null) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevConfigPath;
		if (prevDbPath == null) delete process.env.CODEMEM_DB;
		else process.env.CODEMEM_DB = prevDbPath;
		if (prevKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
		else process.env.CODEMEM_KEYS_DIR = prevKeysDir;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates and lists groups", async () => {
		const group = await coordinatorCreateGroupAction({
			groupId: "team-a",
			displayName: "Team A",
			dbPath,
		});
		expect(group.group_id).toBe("team-a");
		expect(await coordinatorListGroupsAction({ dbPath })).toEqual([
			expect.objectContaining({ group_id: "team-a", display_name: "Team A" }),
		]);
	});

	it("enrolls and lists devices for an existing group", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const enrollment = await coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			displayName: "Laptop",
			dbPath,
		});
		expect(enrollment.device_id).toBe("device-1");
		expect(await coordinatorListDevicesAction({ groupId: "team-a", dbPath })).toEqual([
			expect.objectContaining({ device_id: "device-1", display_name: "Laptop" }),
		]);
	});

	it("retries Team onboarding without optional display names for older coordinators", async () => {
		const actionDbPath = join(tmpDir, "legacy-coordinator-team.sqlite");
		const keysDir = join(tmpDir, "legacy-coordinator-team-keys");
		const configPath = join(tmpDir, "legacy-coordinator-team-config.json");
		const identityId = "identity-team";
		const reviewedIntent = teamReviewedIntent("team-a");
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		const capturedBodies: Record<string, unknown>[] = [];
		const acceptedResponse = {
			ok: true,
			status: "accepted",
			kind: "team_member",
			group_id: "coordinator-a",
			identity_id: identityId,
			policy_team_id: "team-a",
			assigned_identity_id: identityId,
			reviewed_preview_digest: reviewedDigest,
			reviewed_intent: reviewedIntent,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body =
					init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "{}";
				const parsed = JSON.parse(body) as Record<string, unknown>;
				capturedBodies.push(parsed);
				return parsed.recipient_display_name
					? new Response(JSON.stringify({ error: "unexpected_recipient_invite_fields" }), {
							status: 400,
						})
					: new Response(JSON.stringify(acceptedResponse), { status: 200 });
			}),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "team_member",
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token: "legacy-coordinator-team-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			policy_team_id: "team-a",
			assigned_identity_id: identityId,
			reviewed_preview_digest: reviewedDigest,
		});
		const reviewedOnboardingDigest = reviewedOnboardingDigestForRecipientInvite({
			dbPath: actionDbPath,
			keysDir,
			invitationId: "legacy-coordinator-team-token",
			identityId,
			deviceDisplayName: "Recipient laptop",
			reviewedIntent,
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				recipientDisplayName: "Brian Example",
				deviceDisplayName: "Recipient laptop",
				reviewedOnboardingDigest,
			}),
		).resolves.toMatchObject({ status: "accepted", identity_id: identityId });
		expect(capturedBodies).toHaveLength(3);
		expect(capturedBodies[1]).toMatchObject({
			invite_kind: "team_member",
			identity_id: identityId,
			recipient_display_name: "Brian Example",
			device_display_name: "Recipient laptop",
		});
		expect(capturedBodies[2]).toMatchObject({
			token: "legacy-coordinator-team-token",
			device_id: capturedBodies[1]?.device_id,
			public_key: capturedBodies[1]?.public_key,
			fingerprint: capturedBodies[1]?.fingerprint,
			invite_kind: "team_member",
			identity_id: identityId,
		});
		expect(capturedBodies[2]).not.toHaveProperty("recipient_display_name");
		expect(capturedBodies[2]).not.toHaveProperty("device_display_name");
	});

	it.each([
		"operation",
		"group",
		"digest",
		"tampered_project",
	] as const)("rejects an accepted Project intent with a %s mismatch before projection persistence", async (mismatch) => {
		const actionDbPath = join(tmpDir, `project-accepted-${mismatch}.sqlite`);
		const keysDir = join(tmpDir, `project-accepted-${mismatch}-keys`);
		const configPath = join(tmpDir, `project-accepted-${mismatch}-config.json`);
		const operationId = `share_${"9".repeat(40)}`;
		const project = {
			canonical_identity: "https://git.example.invalid/acme/alpha.git",
			display_name: "alpha",
			existing_memory_count: 1,
		};
		const digest = shareProjectSetDigest([
			{
				canonicalIdentity: project.canonical_identity,
				displayName: project.display_name,
				identitySource: "git_remote",
				existingMemoryCount: project.existing_memory_count,
			},
		]);
		const acceptedProjectIntent = {
			operation_id: mismatch === "operation" ? `share_${"8".repeat(40)}` : operationId,
			reviewed_project_set_digest: mismatch === "digest" ? "7".repeat(64) : digest,
			projects:
				mismatch === "tampered_project" ? [{ ...project, existing_memory_count: 2 }] : [project],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "accepted",
							group_id: mismatch === "group" ? "team-b" : "team-a",
							operation_id: operationId,
							trust_state: "pending_inviter_device",
							bootstrap_grant_id: null,
							inviter_device: null,
							accepted_project_intent: acceptedProjectIntent,
						}),
						{ status: 200 },
					),
			),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: "https://coord.example.test",
			group_id: "team-a",
			policy: "auto_admit",
			token: `project-${mismatch}-token`,
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: "Team A",
			operation_id: operationId,
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				recipientActorId: "identity-recipient",
				recipientDisplayName: "Recipient",
				deviceDisplayName: "Recipient laptop",
			}),
		).rejects.toThrow("accepted_project_intent");
		const db = connect(actionDbPath);
		try {
			expect(
				db.prepare("SELECT COUNT(*) FROM recipient_managed_project_projections").pluck().get(),
			).toBe(0);
			expect(db.prepare("SELECT COUNT(*) FROM actors").pluck().get()).toBe(0);
		} finally {
			db.close();
		}
	});

	it.each([
		{},
		{ items: null },
		{ items: "not-a-list" },
		{ items: [null] },
	])("rejects malformed remote device lists: %j", async (payload) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify(payload), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		await expect(
			coordinatorListDevicesAction({
				groupId: "team-a",
				remoteUrl: "https://coord.example.test",
				adminSecret: "secret",
			}),
		).rejects.toThrow("coordinator_device_list_malformed");
	});

	it("normalizes omitted nullable fields from legacy remote device lists", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							items: [
								{
									group_id: "team-a",
									device_id: "device-with-name",
									public_key: "pk-with-name",
									fingerprint: "fp-with-name",
									display_name: "Legacy device",
									enabled: 1,
									created_at: "2026-07-26T00:00:00.000Z",
								},
								{
									group_id: "team-a",
									device_id: "device-without-name",
									public_key: "pk-without-name",
									fingerprint: "fp-without-name",
									enabled: 1,
									created_at: "2026-07-26T00:00:00.000Z",
								},
								{
									group_id: "team-a",
									device_id: "device-with-identity",
									public_key: "pk-with-identity",
									fingerprint: "fp-with-identity",
									identity_id: "identity-1",
									display_name: "Identified device",
									enabled: 1,
									created_at: "2026-07-26T00:00:00.000Z",
								},
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);

		await expect(
			coordinatorListDevicesAction({
				groupId: "team-a",
				remoteUrl: "https://coord.example.test",
				adminSecret: "secret",
			}),
		).resolves.toEqual([
			{
				group_id: "team-a",
				device_id: "device-with-name",
				public_key: "pk-with-name",
				fingerprint: "fp-with-name",
				identity_id: null,
				display_name: "Legacy device",
				enabled: 1,
				created_at: "2026-07-26T00:00:00.000Z",
			},
			{
				group_id: "team-a",
				device_id: "device-without-name",
				public_key: "pk-without-name",
				fingerprint: "fp-without-name",
				identity_id: null,
				display_name: null,
				enabled: 1,
				created_at: "2026-07-26T00:00:00.000Z",
			},
			{
				group_id: "team-a",
				device_id: "device-with-identity",
				public_key: "pk-with-identity",
				fingerprint: "fp-with-identity",
				identity_id: "identity-1",
				display_name: "Identified device",
				enabled: 1,
				created_at: "2026-07-26T00:00:00.000Z",
			},
		]);
	});

	it.each([
		{ identity_id: "" },
		{ identity_id: 0 },
		{ display_name: 0 },
		{ display_name: false },
	])("rejects malformed non-null nullable remote device fields: %j", async (override) => {
		const device = {
			group_id: "team-a",
			device_id: "device-1",
			public_key: "pk-1",
			fingerprint: "fp-1",
			identity_id: null,
			display_name: null,
			enabled: 1,
			created_at: "2026-07-26T00:00:00.000Z",
			...override,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ items: [device] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		await expect(
			coordinatorListDevicesAction({
				groupId: "team-a",
				remoteUrl: "https://coord.example.test",
				adminSecret: "secret",
			}),
		).rejects.toThrow("coordinator_device_list_malformed");
	});

	it("lists only consumed Team invites without tokens", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const reviewedIntent = teamReviewedIntent();
		const reviewedPreviewDigest = await recipientReviewedIntentDigest(reviewedIntent);
		const created = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "https://coord.example.test",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
			inviteKind: "team_member",
			policyTeamId: "policy-team-1",
			reviewedPreviewDigest,
			reviewedIntent,
		});
		await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "https://coord.example.test",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		const payload = created.payload as Record<string, unknown>;
		const identityId = String(payload.assigned_identity_id);
		const publicKey = "public-key-team-1";
		const store = new BetterSqliteCoordinatorStore(dbPath);
		try {
			await store.consumeRecipientInvite({
				token: String(payload.token),
				inviteKind: "team_member",
				identityId,
				deviceId: "device-team-1",
				publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				recipientDisplayName: "Brian Example",
				deviceDisplayName: "Brian's MacBook",
				now: "2026-07-26T00:00:00.000Z",
			});
		} finally {
			await store.close();
		}

		expect(await coordinatorListConsumedTeamInvitesAction({ groupId: "team-a", dbPath })).toEqual([
			{
				invite_id: created.invite_id,
				group_id: "team-a",
				policy_team_id: "policy-team-1",
				assigned_identity_id: identityId,
				recipient_actor_id: identityId,
				recipient_display_name: "Brian Example",
				recipient_device_display_name: "Brian's MacBook",
				bound_device_id: "device-team-1",
				consumed_at: "2026-07-26T00:00:00.000Z",
			},
		]);
		expect(
			await coordinatorListReviewedRecipientInviteEvidenceAction({ groupId: "team-a", dbPath }),
		).toEqual([
			{
				invite_id: created.invite_id,
				group_id: "team-a",
				invite_kind: "team_member",
				policy_team_id: "policy-team-1",
				assigned_identity_id: identityId,
				recipient_actor_id: identityId,
				bound_device_id: "device-team-1",
				bound_public_key: publicKey,
				bound_fingerprint: fingerprintPublicKey(publicKey),
				consumed_at: "2026-07-26T00:00:00.000Z",
				reviewed_preview_digest: reviewedPreviewDigest,
			},
		]);
	});

	it("validates consumed add-device evidence against its reviewed target Identity", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const identityId = "identity-existing-1";
		const reviewedIntent = addDeviceReviewedIntent(identityId);
		const reviewedPreviewDigest = await recipientReviewedIntentDigest(reviewedIntent);
		const created = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "https://coord.example.test",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
			inviteKind: "add_device",
			targetIdentityId: identityId,
			reviewedPreviewDigest,
			reviewedIntent,
		});
		const payload = created.payload as Record<string, unknown>;
		const publicKey = "public-key-add-device-1";
		const store = new BetterSqliteCoordinatorStore(dbPath);
		try {
			await store.consumeRecipientInvite({
				token: String(payload.token),
				inviteKind: "add_device",
				identityId,
				deviceId: "device-add-1",
				publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				now: "2026-07-26T00:00:00.000Z",
			});
		} finally {
			await store.close();
		}

		await expect(
			coordinatorListReviewedRecipientInviteEvidenceAction({ groupId: "team-a", dbPath }),
		).resolves.toEqual([
			{
				invite_id: created.invite_id,
				group_id: "team-a",
				invite_kind: "add_device",
				target_identity_id: identityId,
				recipient_actor_id: identityId,
				bound_device_id: "device-add-1",
				bound_public_key: publicKey,
				bound_fingerprint: fingerprintPublicKey(publicKey),
				consumed_at: "2026-07-26T00:00:00.000Z",
				reviewed_preview_digest: reviewedPreviewDigest,
			},
		]);
	});

	it("fails closed for remote unreviewed or kind-inconsistent recipient evidence", async () => {
		const teamIntent = teamReviewedIntent();
		const teamDigest = await recipientReviewedIntentDigest(teamIntent);
		const addDeviceIntent = addDeviceReviewedIntent("identity-existing-1");
		const addDeviceDigest = await recipientReviewedIntentDigest(addDeviceIntent);
		const base = {
			group_id: "team-a",
			consumed_at: "2026-07-26T00:00:00Z",
			bound_public_key: "public-key-1",
			bound_fingerprint: fingerprintPublicKey("public-key-1"),
			revoked_at: null,
		};
		const team = {
			...base,
			invite_id: "invite-team-1",
			invite_kind: "team_member",
			policy_team_id: "policy-team-1",
			target_identity_id: null,
			assigned_identity_id: "identity:abcdefghijklmnopqr",
			recipient_actor_id: "identity:abcdefghijklmnopqr",
			bound_device_id: "device-team-1",
			reviewed_preview_digest: teamDigest,
			reviewed_intent_json: canonicalRecipientReviewedIntentJson(teamIntent),
		};
		const addDevice = {
			...base,
			invite_id: "invite-add-1",
			invite_kind: "add_device",
			policy_team_id: null,
			target_identity_id: "identity-existing-1",
			assigned_identity_id: null,
			recipient_actor_id: "identity-existing-1",
			bound_device_id: "device-add-1",
			reviewed_preview_digest: addDeviceDigest,
			reviewed_intent_json: canonicalRecipientReviewedIntentJson(addDeviceIntent),
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							items: [
								team,
								addDevice,
								{
									...team,
									invite_id: "revoked-team",
									revoked_at: "2026-07-27T00:00:00.000Z",
								},
								{
									...base,
									invite_id: "legacy-consumed",
									invite_kind: "legacy_enrollment",
									bound_device_id: "device-legacy",
								},
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);
		await expect(
			coordinatorListReviewedRecipientInviteEvidenceAction({
				groupId: "team-a",
				remoteUrl: "https://coord.example.test",
				adminSecret: "secret",
			}),
		).resolves.toHaveLength(2);

		for (const invalid of [
			{ ...team, reviewed_intent_json: null },
			{ ...team, reviewed_preview_digest: "b".repeat(64) },
			{ ...team, bound_device_id: null },
			{ ...team, bound_device_id: "d".repeat(257) },
			{ ...team, bound_fingerprint: "wrong-fingerprint" },
			{ ...team, recipient_actor_id: "identity:otherotherotherother" },
			{ ...addDevice, recipient_actor_id: "identity-other" },
		]) {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(JSON.stringify({ items: [invalid] }), {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
				),
			);
			await expect(
				coordinatorListReviewedRecipientInviteEvidenceAction({
					groupId: "team-a",
					remoteUrl: "https://coord.example.test",
					adminSecret: "secret",
				}),
			).rejects.toThrow("coordinator_reviewed_recipient_invite_invalid");
		}

		for (const malformed of [{}, { items: null }, { items: "not-a-list" }, { items: [null] }]) {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(JSON.stringify(malformed), {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
				),
			);
			await expect(
				coordinatorListReviewedRecipientInviteEvidenceAction({
					groupId: "team-a",
					remoteUrl: "https://coord.example.test",
					adminSecret: "secret",
				}),
			).rejects.toThrow("coordinator_invite_list_malformed");
		}
	});

	it.each([
		"device_id",
		"identity_id",
	] as const)("rejects overlong remote device %s values", async (field) => {
		const device = {
			group_id: "team-a",
			device_id: "device-1",
			public_key: "pk-1",
			fingerprint: "fp-1",
			identity_id: "identity-1",
			display_name: null,
			enabled: 1,
			created_at: "2026-07-26T00:00:00.000Z",
			[field]: "x".repeat(257),
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ items: [device] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		await expect(
			coordinatorListDevicesAction({
				groupId: "team-a",
				remoteUrl: "https://coord.example.test",
				adminSecret: "secret",
			}),
		).rejects.toThrow("coordinator_device_list_malformed");
	});

	it("serializes only exact, well-formed remote device presence capability fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							items: [
								{
									group_id: "team-a",
									device_id: "device-fresh",
									public_key: "pk-fresh",
									fingerprint: "fp-fresh",
									identity_id: null,
									display_name: null,
									enabled: 1,
									created_at: "2026-07-26T00:00:00.000Z",
									presence_expires_at: "2026-07-27T00:00:00.000Z",
									presence_capabilities: {
										sync_capability: "scoped",
										sync_features: ["reassign_scope"],
										token: "must-not-cross-capability-boundary",
									},
									token: "must-not-cross-action-boundary",
								},
								{
									group_id: "team-a",
									device_id: "device-legacy",
									public_key: "pk-legacy",
									fingerprint: "fp-legacy",
									identity_id: null,
									display_name: null,
									enabled: 1,
									created_at: "2026-07-26T00:00:00.000Z",
									presence_expires_at: "2026-07-27T00:00:00.000Z",
									presence_capabilities: ["malformed"],
								},
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);

		const devices = await coordinatorListDevicesAction({
			groupId: "team-a",
			remoteUrl: "https://coord.example.test",
			adminSecret: "secret",
		});
		expect(devices[0]).toMatchObject({
			presence_expires_at: "2026-07-27T00:00:00.000Z",
			presence_capabilities: {
				sync_capability: "scoped",
				sync_features: ["reassign_scope"],
			},
		});
		expect(devices[0]).not.toHaveProperty("token");
		expect(devices[0]?.presence_capabilities).not.toHaveProperty("token");
		expect(devices[1]).not.toHaveProperty("presence_expires_at");
		expect(devices[1]).not.toHaveProperty("presence_capabilities");
	});

	it("validates remote consumed Team invite identity bindings", async () => {
		const valid = {
			invite_id: "invite-team-1",
			group_id: "team-a",
			invite_kind: "team_member",
			policy_team_id: "policy-team-1",
			assigned_identity_id: "identity:abcdefghijklmnopqr",
			recipient_actor_id: "identity:abcdefghijklmnopqr",
			recipient_display_name: "Brian Example",
			recipient_device_display_name: "Brian's MacBook",
			bound_device_id: "device-team-1",
			consumed_at: "2026-07-26T00:00:00.000Z",
		};
		const expected = {
			invite_id: valid.invite_id,
			group_id: valid.group_id,
			policy_team_id: valid.policy_team_id,
			assigned_identity_id: valid.assigned_identity_id,
			recipient_actor_id: valid.recipient_actor_id,
			recipient_display_name: valid.recipient_display_name,
			recipient_device_display_name: valid.recipient_device_display_name,
			bound_device_id: valid.bound_device_id,
			consumed_at: valid.consumed_at,
		};
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						items: [
							valid,
							{ ...valid, invite_id: "pending-team", consumed_at: null },
							{ ...valid, invite_id: "legacy", invite_kind: "legacy_enrollment" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			coordinatorListConsumedTeamInvitesAction({
				groupId: "team-a",
				remoteUrl: "https://coord.example.test/",
				adminSecret: "secret",
			}),
		).resolves.toEqual([expected]);
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://coord.example.test/v1/admin/invites?group_id=team-a",
		);
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
			"X-Codemem-Coordinator-Admin": "secret",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							items: [{ ...valid, consumed_at: "2026-07-26T00:00:00Z" }],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);
		await expect(
			coordinatorListConsumedTeamInvitesAction({
				groupId: "team-a",
				remoteUrl: "https://coord.example.test",
				adminSecret: "secret",
			}),
		).resolves.toEqual([{ ...expected, consumed_at: "2026-07-26T00:00:00Z" }]);

		for (const invalid of [
			{ ...valid, recipient_actor_id: "identity:stuvwxyzABCDEFGH12" },
			{ ...valid, assigned_identity_id: ` ${valid.assigned_identity_id}` },
			{ ...valid, recipient_actor_id: `${valid.recipient_actor_id} ` },
			{ ...valid, invite_id: ` ${valid.invite_id}` },
			{ ...valid, policy_team_id: `${valid.policy_team_id} ` },
			{ ...valid, policy_team_id: "p".repeat(257) },
			{ ...valid, bound_device_id: ` ${valid.bound_device_id}` },
			{ ...valid, bound_device_id: "d".repeat(257) },
			{ ...valid, consumed_at: "2026-07-26T00:00:00.00Z" },
			{
				...valid,
				assigned_identity_id: "identity-team-1",
				recipient_actor_id: "identity-team-1",
			},
		]) {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(JSON.stringify({ items: [invalid] }), {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
				),
			);
			await expect(
				coordinatorListConsumedTeamInvitesAction({
					groupId: "team-a",
					remoteUrl: "https://coord.example.test",
					adminSecret: "secret",
				}),
			).rejects.toThrow("coordinator_consumed_team_invite_invalid");
		}

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							items: [
								{
									...valid,
									recipient_display_name: "Brian\u0000",
									recipient_device_display_name: "x".repeat(121),
								},
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);
		await expect(
			coordinatorListConsumedTeamInvitesAction({
				groupId: "team-a",
				remoteUrl: "https://coord.example.test",
				adminSecret: "secret",
			}),
		).resolves.toEqual([
			{
				invite_id: valid.invite_id,
				group_id: valid.group_id,
				policy_team_id: valid.policy_team_id,
				assigned_identity_id: valid.assigned_identity_id,
				recipient_actor_id: valid.recipient_actor_id,
				bound_device_id: valid.bound_device_id,
				consumed_at: valid.consumed_at,
			},
		]);

		for (const malformed of [{}, { items: null }, { items: "not-a-list" }, { items: [null] }]) {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(JSON.stringify(malformed), {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
				),
			);
			await expect(
				coordinatorListConsumedTeamInvitesAction({
					groupId: "team-a",
					remoteUrl: "https://coord.example.test",
					adminSecret: "secret",
				}),
			).rejects.toThrow("coordinator_invite_list_malformed");
		}
	});

	it("renames, disables, and removes devices", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		await coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			dbPath,
		});
		expect(
			await coordinatorRenameDeviceAction({
				groupId: "team-a",
				deviceId: "device-1",
				displayName: "Work Laptop",
				dbPath,
			}),
		).toEqual(expect.objectContaining({ display_name: "Work Laptop" }));
		expect(
			await coordinatorDisableDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath }),
		).toBe(true);
		expect(await coordinatorListDevicesAction({ groupId: "team-a", dbPath })).toEqual([]);
		expect(
			await coordinatorListDevicesAction({ groupId: "team-a", includeDisabled: true, dbPath }),
		).toEqual([expect.objectContaining({ device_id: "device-1", enabled: 0 })]);
		expect(
			await coordinatorRemoveDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath }),
		).toBe(true);
		expect(
			await coordinatorListDevicesAction({ groupId: "team-a", includeDisabled: true, dbPath }),
		).toEqual([]);
	});

	it("returns the renamed disabled device instead of null", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		await coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			dbPath,
		});
		await coordinatorDisableDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath });
		await expect(
			coordinatorRenameDeviceAction({
				groupId: "team-a",
				deviceId: "device-1",
				displayName: "Disabled Laptop",
				dbPath,
			}),
		).resolves.toEqual(
			expect.objectContaining({
				device_id: "device-1",
				display_name: "Disabled Laptop",
				enabled: 0,
			}),
		);
	});

	it("re-enables a disabled device", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		await coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			dbPath,
		});
		await coordinatorDisableDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath });
		expect(await coordinatorListDevicesAction({ groupId: "team-a", dbPath })).toEqual([]);
		expect(
			await coordinatorEnableDeviceAction({ groupId: "team-a", deviceId: "device-1", dbPath }),
		).toBe(true);
		expect(await coordinatorListDevicesAction({ groupId: "team-a", dbPath })).toEqual([
			expect.objectContaining({ device_id: "device-1", enabled: 1 }),
		]);
	});

	it("returns false when enabling a missing device", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		expect(
			await coordinatorEnableDeviceAction({ groupId: "team-a", deviceId: "missing", dbPath }),
		).toBe(false);
	});

	it("rejects enrollment into a missing group", async () => {
		await expect(
			coordinatorEnrollDeviceAction({
				groupId: "missing",
				deviceId: "device-1",
				fingerprint: "fp-1",
				publicKey: "pk-1",
				dbPath,
			}),
		).rejects.toThrow("Group not found: missing");
	});

	it("creates, updates, lists, grants, and revokes local Sharing domain memberships", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		await coordinatorEnrollDeviceAction({
			groupId: "team-a",
			deviceId: "device-1",
			fingerprint: "fp-1",
			publicKey: "pk-1",
			dbPath,
		});
		const created = await coordinatorCreateScopeAction({
			groupId: "team-a",
			scopeId: "scope-acme",
			label: "Acme Work",
			kind: "team",
			coordinatorId: "coord-a",
			membershipEpoch: 2,
			dbPath,
		});
		expect(created).toEqual(
			expect.objectContaining({
				scope_id: "scope-acme",
				label: "Acme Work",
				group_id: "team-a",
				membership_epoch: 2,
			}),
		);
		expect(await coordinatorListScopesAction({ groupId: "team-a", dbPath })).toEqual([
			expect.objectContaining({ scope_id: "scope-acme" }),
		]);
		expect(
			await coordinatorListScopeMembershipsAction({
				groupId: "team-a",
				scopeId: "scope-acme",
				dbPath,
			}),
		).toEqual([]);
		const updated = await coordinatorUpdateScopeAction({
			groupId: "team-a",
			scopeId: "scope-acme",
			label: "Acme Engineering",
			membershipEpoch: 3,
			dbPath,
		});
		expect(updated).toEqual(
			expect.objectContaining({ label: "Acme Engineering", membership_epoch: 3 }),
		);

		const grant = await coordinatorGrantScopeMembershipAction({
			effectId: "actions:team-a:scope-acme:device-1:grant:3",
			groupId: "team-a",
			scopeId: "scope-acme",
			deviceId: "device-1",
			role: "admin",
			membershipEpoch: 3,
			actorId: "admin-alice",
			dbPath,
		});
		expect(grant).toEqual(
			expect.objectContaining({
				scope_id: "scope-acme",
				device_id: "device-1",
				role: "admin",
				status: "active",
			}),
		);
		expect(
			await coordinatorListScopeMembershipsAction({
				groupId: "team-a",
				scopeId: "scope-acme",
				dbPath,
			}),
		).toEqual([expect.objectContaining({ device_id: "device-1", status: "active" })]);
		expect(
			await coordinatorRevokeScopeMembershipAction({
				effectId: "actions:team-a:scope-acme:device-1:revoke:4",
				groupId: "team-a",
				scopeId: "scope-acme",
				deviceId: "device-1",
				actorId: "admin-bob",
				dbPath,
			}),
		).toBe(true);
		expect(
			await coordinatorListScopeMembershipsAction({
				groupId: "team-a",
				scopeId: "scope-acme",
				dbPath,
			}),
		).toEqual([]);
		expect(
			await coordinatorListScopeMembershipsAction({
				groupId: "team-a",
				scopeId: "scope-acme",
				includeRevoked: true,
				dbPath,
			}),
		).toEqual([expect.objectContaining({ device_id: "device-1", status: "revoked" })]);
		const auditStore = new BetterSqliteCoordinatorStore(dbPath);
		try {
			expect(await auditStore.listScopeMembershipAuditEvents({ scopeId: "scope-acme" })).toEqual([
				expect.objectContaining({
					action: "grant",
					device_id: "device-1",
					membership_epoch: 3,
					actor_type: "admin",
					actor_id: "admin-alice",
				}),
				expect.objectContaining({
					action: "revoke",
					device_id: "device-1",
					status: "revoked",
					previous_membership_epoch: 3,
					actor_type: "admin",
					actor_id: "admin-bob",
				}),
			]);
		} finally {
			await auditStore.close();
		}
	});

	it("rejects local Sharing domain actions for missing groups or scopes", async () => {
		await expect(
			coordinatorCreateScopeAction({
				groupId: "missing",
				scopeId: "scope-acme",
				label: "Acme Work",
				dbPath,
			}),
		).rejects.toThrow("Group not found: missing");
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		expect(
			await coordinatorUpdateScopeAction({
				groupId: "team-a",
				scopeId: "missing-scope",
				label: "Nope",
				dbPath,
			}),
		).toBeNull();
		await expect(
			coordinatorListScopeMembershipsAction({
				groupId: "team-a",
				scopeId: "missing-scope",
				dbPath,
			}),
		).rejects.toThrow("Scope not found: missing-scope");
		await expect(
			coordinatorGrantScopeMembershipAction({
				effectId: "actions:missing-scope:grant",
				groupId: "team-a",
				scopeId: "missing-scope",
				deviceId: "device-1",
				dbPath,
			}),
		).rejects.toThrow("Scope not found: missing-scope");
	});

	it("sends remote Sharing domain admin requests with the admin secret", async () => {
		const prevAdminSecret = process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
		process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = "secret";
		const scope = {
			scope_id: "scope-acme",
			label: "Acme Work",
			kind: "team",
			authority_type: "coordinator",
			coordinator_id: "coord-a",
			group_id: "team-a",
			manifest_issuer_device_id: null,
			membership_epoch: 2,
			manifest_hash: null,
			status: "active",
			created_at: "2026-03-28T00:00:00Z",
			updated_at: "2026-03-28T00:00:00Z",
		};
		const membership = {
			scope_id: "scope-acme",
			device_id: "device-1",
			role: "member",
			status: "active",
			membership_epoch: 2,
			coordinator_id: "coord-a",
			group_id: "team-a",
			manifest_issuer_device_id: null,
			manifest_hash: null,
			signed_manifest_json: null,
			updated_at: "2026-03-28T00:00:00Z",
		};
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			expect(init?.headers).toMatchObject({ "X-Codemem-Coordinator-Admin": "secret" });
			if (path.endsWith("/scopes") && init?.method === "GET") {
				return new Response(JSON.stringify({ items: [scope] }), { status: 200 });
			}
			if (path.endsWith("/scopes") && init?.method === "POST") {
				return new Response(JSON.stringify({ ok: true, scope }), { status: 201 });
			}
			if (path.endsWith("/members") && init?.method === "POST") {
				return new Response(JSON.stringify({ ok: true, membership }), { status: 201 });
			}
			if (path.endsWith("/revoke") && init?.method === "POST") {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
		});
		vi.stubGlobal("fetch", fetchMock);

		try {
			expect(
				await coordinatorListScopesAction({
					groupId: "team-a",
					includeInactive: true,
					remoteUrl: "https://coord.example.test/",
				}),
			).toEqual([scope]);
			expect(
				await coordinatorCreateScopeAction({
					groupId: "team-a",
					scopeId: "scope-acme",
					label: "Acme Work",
					remoteUrl: "https://coord.example.test/",
				}),
			).toEqual(scope);
			expect(
				await coordinatorGrantScopeMembershipAction({
					effectId: "actions:remote:grant",
					groupId: "team-a",
					scopeId: "scope-acme",
					deviceId: "device-1",
					remoteUrl: "https://coord.example.test/",
				}),
			).toEqual(membership);
			expect(
				await coordinatorRevokeScopeMembershipAction({
					effectId: "actions:remote:revoke",
					groupId: "team-a",
					scopeId: "scope-acme",
					deviceId: "device-1",
					remoteUrl: "https://coord.example.test/",
				}),
			).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(4);
		} finally {
			if (prevAdminSecret == null) delete process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET;
			else process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = prevAdminSecret;
		}
	});

	it("maps remote missing Sharing domain membership revokes to false", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "membership_not_found" }), { status: 404 }),
			),
		);

		expect(
			await coordinatorRevokeScopeMembershipAction({
				effectId: "actions:remote:missing-revoke",
				groupId: "team-a",
				scopeId: "scope-acme",
				deviceId: "device-1",
				remoteUrl: "https://coord.example.test",
				adminSecret: "secret",
			}),
		).toBe(false);
	});

	it("warns when local invite coordinator URL looks private-only", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "http://100.103.98.49:7347",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([
			"Invite uses a CGNAT/Tailscale-style coordinator IP address. This can be correct for Tailnet-only teams, but other teammates may not be able to join unless they share that network.",
		]);
	});

	it("does not warn for public-looking invite coordinator URLs", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "https://coord.example.test",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([]);
	});

	it("stores canonical reviewed intent for local recipient invites without embedding it in links", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const reviewedIntent = teamReviewedIntent();
		const digest = await recipientReviewedIntentDigest(reviewedIntent);
		await expect(
			coordinatorCreateInviteAction({
				groupId: "team-a",
				coordinatorUrl: "https://coord.example.test",
				policy: "auto_admit",
				ttlHours: 24,
				dbPath,
				inviteKind: "team_member",
				policyTeamId: "policy-team-1",
				reviewedPreviewDigest: digest,
			}),
		).rejects.toThrow("recipient_invite_review_unavailable");
		const result = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "https://coord.example.test",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
			inviteKind: "team_member",
			policyTeamId: "policy-team-1",
			reviewedPreviewDigest: digest,
			reviewedIntent,
		});
		const payload = result.payload as Record<string, unknown>;
		expect(payload).not.toHaveProperty("reviewed_intent");
		expect(String(result.link)).not.toContain("reviewed_intent");

		const store = new BetterSqliteCoordinatorStore(dbPath);
		try {
			const inspected = await store.inspectRecipientInvite({
				token: String(payload.token),
				now: new Date().toISOString(),
			});
			expect(inspected?.reviewed_intent).toEqual(reviewedIntent);
		} finally {
			await store.close();
		}
	});

	it("sends canonical reviewed intent when creating remote recipient invites", async () => {
		const reviewedIntent = teamReviewedIntent();
		const digest = await recipientReviewedIntentDigest(reviewedIntent);
		let requestBody: Record<string, unknown> | null = null;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body =
					init?.body instanceof Uint8Array
						? Buffer.from(init.body).toString("utf8")
						: String(init?.body ?? "{}");
				requestBody = JSON.parse(body) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						invite: {
							invite_id: "invite-team-1",
							invite_kind: "team_member",
							policy_team_id: "policy-team-1",
							assigned_identity_id: "identity-assigned-team",
							reviewed_preview_digest: digest,
						},
						payload: {
							kind: "team_member",
							policy_team_id: "policy-team-1",
							assigned_identity_id: "identity-assigned-team",
							reviewed_preview_digest: digest,
						},
						encoded: "digest-only",
						link: "https://coord.example.test/invite#digest-only",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);

		const result = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "https://coord.example.test",
			policy: "auto_admit",
			ttlHours: 24,
			remoteUrl: "https://coord.example.test",
			adminSecret: "secret",
			inviteKind: "team_member",
			policyTeamId: "policy-team-1",
			reviewedPreviewDigest: digest,
			reviewedIntent,
		});

		expect(requestBody).toMatchObject({ reviewed_intent: reviewedIntent });
		expect(result.payload).not.toHaveProperty("reviewed_intent");
	});

	it("signs the exact identity-owned add-device invite body without admin or target fields", async () => {
		const keysDir = join(tmpDir, "signed-add-device-keys");
		const identityDbPath = join(tmpDir, "signed-add-device.sqlite");
		initDatabase(identityDbPath);
		const identityDb = connect(identityDbPath);
		let deviceId = "";
		try {
			[deviceId] = ensureDeviceIdentity(identityDb, { keysDir });
		} finally {
			identityDb.close();
		}
		const reviewedIntent = addDeviceReviewedIntent("identity-owner");
		const digest = await recipientReviewedIntentDigest(reviewedIntent);
		let requestBody: Record<string, unknown> | null = null;
		let requestHeaders = new Headers();
		let transmittedBody = Buffer.alloc(0);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				expect(url).toBe("https://coord.example.test/v1/invites/add-device");
				requestHeaders = new Headers(init?.headers);
				transmittedBody =
					init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
				requestBody = JSON.parse(transmittedBody.toString("utf8")) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						invite: {
							invite_id: "invite-device-1",
							invite_kind: "add_device",
							target_identity_id: "identity-owner",
							reviewed_preview_digest: digest,
						},
						payload: {
							kind: "add_device",
							target_identity_id: "identity-owner",
							reviewed_preview_digest: digest,
						},
						encoded: "digest-only",
						link: "codemem://join?invite=digest-only",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);

		const result = await coordinatorCreateAddDeviceInviteAction({
			groupId: "team-a",
			coordinatorUrl: "https://coord.example.test",
			ttlHours: 24,
			deviceId,
			keysDir,
			reviewedPreviewDigest: digest,
			reviewedIntent,
		});

		expect(requestBody).toMatchObject({
			group_id: "team-a",
			reviewed_preview_digest: digest,
			reviewed_intent: reviewedIntent,
		});
		expect(requestBody).not.toHaveProperty("target_identity_id");
		expect(requestBody).not.toHaveProperty("invite_kind");
		expect(requestHeaders.get("X-Opencode-Device")).toBe(deviceId);
		expect(requestHeaders.get("X-Opencode-Signature")).toMatch(/^v2:/u);
		expect(requestHeaders.has("X-Codemem-Coordinator-Admin")).toBe(false);
		expect(
			verifySignature({
				method: "POST",
				pathWithQuery: "/v1/invites/add-device",
				timestamp: String(requestHeaders.get("X-Opencode-Timestamp")),
				nonce: String(requestHeaders.get("X-Opencode-Nonce")),
				signature: String(requestHeaders.get("X-Opencode-Signature")),
				publicKey: String(loadPublicKey(keysDir)),
				deviceId,
				bodyBytes: transmittedBody,
			}),
		).toBe(true);
		expect(result).toMatchObject({
			invite_id: "invite-device-1",
			invite_kind: "add_device",
			target_identity_id: "identity-owner",
			link: "codemem://join?invite=digest-only",
		});
	});

	it("surfaces signed add-device coordinator authorization failures without admin fallback", async () => {
		const keysDir = join(tmpDir, "signed-add-device-error-keys");
		const identityDbPath = join(tmpDir, "signed-add-device-error.sqlite");
		initDatabase(identityDbPath);
		const identityDb = connect(identityDbPath);
		let deviceId = "";
		try {
			[deviceId] = ensureDeviceIdentity(identityDb, { keysDir });
		} finally {
			identityDb.close();
		}
		const reviewedIntent = addDeviceReviewedIntent("identity-owner");
		const digest = await recipientReviewedIntentDigest(reviewedIntent);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "identity_binding_required" }), { status: 403 }),
			),
		);

		await expect(
			coordinatorCreateAddDeviceInviteAction({
				groupId: "team-a",
				coordinatorUrl: "https://coord.example.test",
				ttlHours: 24,
				deviceId,
				keysDir,
				reviewedPreviewDigest: digest,
				reviewedIntent,
			}),
		).rejects.toThrow("Remote coordinator request failed (403): identity_binding_required");
	});

	it("imports invites using CODEMEM_DB and CODEMEM_KEYS_DIR when flags are omitted", async () => {
		const envDbPath = join(tmpDir, "env-mem.sqlite");
		const envKeysDir = join(tmpDir, "env-keys");
		process.env.CODEMEM_DB = envDbPath;
		process.env.CODEMEM_KEYS_DIR = envKeysDir;
		const capturedBodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body =
					init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "{}";
				capturedBodies.push(JSON.parse(body) as Record<string, unknown>);
				return new Response(JSON.stringify({ ok: true, status: "enrolled" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);

		const invite = encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: "https://coord.example.test",
			group_id: "team-a",
			policy: "auto_admit",
			token: "invite-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: "Team A",
		});

		await coordinatorImportInviteAction({ inviteValue: invite });
		const persistedConfig = readCodememConfigFileAtPath(String(process.env.CODEMEM_CONFIG));
		expect(persistedConfig).not.toHaveProperty("sync_enabled");
		expect(persistedConfig).not.toHaveProperty("sync_host");
		expect(persistedConfig).not.toHaveProperty("sync_port");
		expect(persistedConfig).not.toHaveProperty("sync_interval_s");

		const publicKey = loadPublicKey(envKeysDir);
		expect(publicKey).toBeTruthy();
		const conn = connect(envDbPath);
		try {
			expect(
				conn.prepare("SELECT COUNT(1) AS total FROM sync_device").get() as { total?: number },
			).toMatchObject({ total: 1 });
		} finally {
			conn.close();
		}
		expect(capturedBodies).toEqual([
			expect.objectContaining({
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(String(publicKey)),
			}),
		]);
	});

	it("falls back to the local actor identity and accepts additive accepted-intent fields", async () => {
		const actionDbPath = join(tmpDir, "project-invite.sqlite");
		const keysDir = join(tmpDir, "project-keys");
		const capturedBodies: Record<string, unknown>[] = [];
		const operationId = `share_${"a".repeat(40)}`;
		const inviterPublicKey = "ssh-ed25519 inviter-public-key";
		const project = {
			canonical_identity: "https://git.example.invalid/acme/alpha.git",
			display_name: "alpha",
			existing_memory_count: 0,
		};
		const reviewedProjectSetDigest = shareProjectSetDigest([
			{
				canonicalIdentity: project.canonical_identity,
				displayName: project.display_name,
				identitySource: "git_remote",
				existingMemoryCount: project.existing_memory_count,
			},
		]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body =
					init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "{}";
				capturedBodies.push(JSON.parse(body) as Record<string, unknown>);
				return new Response(
					JSON.stringify({
						ok: true,
						status: "accepted",
						group_id: "team-a",
						operation_id: operationId,
						trust_state: "bootstrap_grant_created",
						bootstrap_grant_id: "grant-1",
						inviter_device: {
							device_id: "inviter-device",
							public_key: inviterPublicKey,
							fingerprint: fingerprintPublicKey(inviterPublicKey),
							display_name: "Adam's Mac",
						},
						accepted_project_intent: {
							operation_id: operationId,
							reviewed_project_set_digest: reviewedProjectSetDigest,
							projects: [{ ...project, future_project_metadata: "ignored" }],
							future_intent_metadata: { version: 2 },
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: "https://coord.example.test",
			group_id: "team-a",
			policy: "auto_admit",
			token: "project-invite-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: "Team A",
			operation_id: operationId,
		});

		const imported = await coordinatorImportInviteAction({
			inviteValue: invite,
			dbPath: actionDbPath,
			keysDir,
		});

		const body = capturedBodies[0];
		expect(imported).toMatchObject({
			status: PROJECT_INVITE_PENDING_STATUS,
			setup_state: "pending_inviter",
			sync_enabled: true,
		});
		expect(body?.recipient_actor_id).toBe(`local:${body?.device_id}`);
		expect(body?.recipient_display_name).toEqual(expect.any(String));
		expect(body?.device_display_name).toEqual(expect.any(String));
		const conn = connect(actionDbPath);
		try {
			expect(
				conn
					.prepare(`SELECT name, pinned_fingerprint, public_key, pending_bootstrap_grant_id,
						discovered_via_group_id FROM sync_peers WHERE peer_device_id = 'inviter-device'`)
					.get(),
			).toEqual({
				name: "Adam's Mac",
				pinned_fingerprint: fingerprintPublicKey(inviterPublicKey),
				public_key: inviterPublicKey,
				pending_bootstrap_grant_id: "grant-1",
				discovered_via_group_id: "team-a",
			});
			expect(
				conn
					.prepare("SELECT display_name, is_local, status FROM actors WHERE actor_id = ?")
					.get(body?.recipient_actor_id),
			).toMatchObject({ is_local: 1, status: "active" });
			expect(
				conn
					.prepare(`SELECT canonical_project_identity, display_name, managed_scope_id,
					coordinator_id, group_id, recipient_identity_id, accepting_device_id,
					source_operation_id, reviewed_project_set_digest, status
				 FROM recipient_managed_project_projections`)
					.get(),
			).toEqual({
				canonical_project_identity: project.canonical_identity,
				display_name: project.display_name,
				managed_scope_id: managedProjectScopeId("team-a", project.canonical_identity),
				coordinator_id: "https://coord.example.test",
				group_id: "team-a",
				recipient_identity_id: body?.recipient_actor_id,
				accepting_device_id: body?.device_id,
				source_operation_id: operationId,
				reviewed_project_set_digest: reviewedProjectSetDigest,
				status: "active",
			});
			expect(conn.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
			expect(conn.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get()).toBe(0);
		} finally {
			conn.close();
		}
		expect(readCodememConfigFileAtPath(String(process.env.CODEMEM_CONFIG))).toMatchObject({
			sync_enabled: true,
			sync_host: "0.0.0.0",
			sync_port: 7337,
			sync_interval_s: 120,
		});
	});

	it("recovers idempotently when a consumed project invite initially cannot enable sync", async () => {
		const actionDbPath = join(tmpDir, "project-invite-config-failure.sqlite");
		const keysDir = join(tmpDir, "project-invite-config-failure-keys");
		const configParent = join(tmpDir, "blocked-config-parent");
		const configPath = join(configParent, "config.json");
		const operationId = `share_${"f".repeat(40)}`;
		const inviterPublicKey = "ssh-ed25519 inviter-public-key";
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						status: "accepted",
						operation_id: operationId,
						trust_state: "bootstrap_grant_created",
						bootstrap_grant_id: "grant-1",
						inviter_device: {
							device_id: "inviter-device",
							public_key: inviterPublicKey,
							fingerprint: fingerprintPublicKey(inviterPublicKey),
						},
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: "https://coord.example.test",
			group_id: "team-a",
			policy: "auto_admit",
			token: "project-invite-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: "Team A",
			operation_id: operationId,
		});

		writeFileSync(configParent, "not-a-directory", "utf8");
		let failure: unknown;
		try {
			await coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				recipientActorId: "actor-brian",
				recipientDisplayName: "Brian",
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ProjectSyncEnablementError);
		expect(isProjectSyncEnablementError(failure)).toBe(true);
		expect(isProjectSyncEnablementError(new Error(PROJECT_SYNC_ENABLEMENT_FAILURE_DETAIL))).toBe(
			false,
		);
		expect(failure).toMatchObject({
			code: PROJECT_SYNC_ENABLEMENT_FAILED,
			detail: PROJECT_SYNC_ENABLEMENT_FAILURE_DETAIL,
			message: PROJECT_SYNC_ENABLEMENT_FAILURE_DETAIL,
		});

		rmSync(configParent);
		const retried = await coordinatorImportInviteAction({
			inviteValue: invite,
			dbPath: actionDbPath,
			keysDir,
			configPath,
			recipientActorId: "actor-brian",
			recipientDisplayName: "Brian",
		});

		expect(retried).toMatchObject({
			status: PROJECT_INVITE_PENDING_STATUS,
			groups: ["team-a"],
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(readCodememConfigFileAtPath(configPath)).toMatchObject({
			sync_enabled: true,
			sync_coordinator_groups: ["team-a"],
		});
		const conn = connect(actionDbPath);
		try {
			expect(
				conn.prepare("SELECT COUNT(1) AS total FROM actors WHERE actor_id = ?").get("actor-brian"),
			).toEqual({ total: 1 });
			expect(
				conn
					.prepare(`SELECT COUNT(1) AS total FROM sync_peers
					 WHERE peer_device_id = ? AND pending_bootstrap_grant_id = ?`)
					.get("inviter-device", "grant-1"),
			).toEqual({ total: 1 });
			expect(
				conn.prepare("SELECT COUNT(*) FROM recipient_managed_project_projections").pluck().get(),
			).toBe(0);
		} finally {
			conn.close();
		}
	});

	it.each([
		{ kind: "team_member" as const, targetId: "team-a" },
		{ kind: "add_device" as const, targetId: "identity-existing" },
	])("requires a reviewed onboarding digest before consuming a $kind invite", async (testCase) => {
		const actionDbPath = join(tmpDir, `${testCase.kind}-missing-review.sqlite`);
		const keysDir = join(tmpDir, `${testCase.kind}-missing-review-keys`);
		const reviewedIntent =
			testCase.kind === "team_member"
				? teamReviewedIntent(testCase.targetId)
				: addDeviceReviewedIntent(testCase.targetId);
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const invite = encodeInvitePayload({
			v: 1,
			kind: testCase.kind,
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token: `${testCase.kind}-missing-review-token`,
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			...(testCase.kind === "team_member"
				? { policy_team_id: testCase.targetId, assigned_identity_id: "identity-team" }
				: { target_identity_id: testCase.targetId }),
			reviewed_preview_digest: reviewedDigest,
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
			}),
		).rejects.toThrow("reviewed_onboarding_digest_required");
		expect(fetchMock).not.toHaveBeenCalled();
		const conn = connect(actionDbPath);
		try {
			expect(conn.prepare("SELECT COUNT(*) FROM actors").pluck().get()).toBe(0);
			expect(conn.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
			expect(conn.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get()).toBe(0);
		} finally {
			conn.close();
		}
	});

	it("adopts the add-device target identity on a fresh profile", async () => {
		const actionDbPath = join(tmpDir, "fresh-add-device.sqlite");
		const keysDir = join(tmpDir, "fresh-add-device-keys");
		const configPath = join(tmpDir, "fresh-add-device-config.json");
		const targetIdentityId = "identity-existing";
		const reviewedIntent = addDeviceReviewedIntent(targetIdentityId);
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		const capturedBodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body =
					init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "{}";
				capturedBodies.push(JSON.parse(body) as Record<string, unknown>);
				return new Response(
					JSON.stringify({
						ok: true,
						status: "accepted",
						kind: "add_device",
						group_id: "coordinator-a",
						identity_id: targetIdentityId,
						policy_team_id: null,
						target_identity_id: targetIdentityId,
						reviewed_preview_digest: reviewedDigest,
						reviewed_intent: reviewedIntent,
					}),
					{ status: 200 },
				);
			}),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "add_device",
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token: "fresh-add-device-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			target_identity_id: targetIdentityId,
			reviewed_preview_digest: reviewedDigest,
		});
		const reviewedOnboardingDigest = reviewedOnboardingDigestForRecipientInvite({
			dbPath: actionDbPath,
			keysDir,
			invitationId: "fresh-add-device-token",
			identityId: targetIdentityId,
			deviceDisplayName: "Recipient laptop",
			reviewedIntent,
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				recipientDisplayName: "Existing Person",
				deviceDisplayName: "Recipient laptop",
				reviewedOnboardingDigest,
			}),
		).resolves.toEqual({
			group_id: "coordinator-a",
			coordinator_url: "https://coord.example.test",
			status: "accepted",
			invite_kind: "add_device",
			identity_id: targetIdentityId,
			inviter_peer_linked: false,
			policy_team_id: null,
			target_identity_id: targetIdentityId,
			reviewed_preview_digest: reviewedDigest,
			sync_enabled: true,
		});
		expect(capturedBodies).toHaveLength(2);
		expect(capturedBodies[0]).toEqual({ token: "fresh-add-device-token" });
		expect(capturedBodies[1]).toMatchObject({
			identity_id: targetIdentityId,
			recipient_display_name: "Existing Person",
			device_display_name: "Recipient laptop",
		});
		expect(readCodememConfigFileAtPath(configPath)).toMatchObject({
			actor_id: targetIdentityId,
		});
		const conn = connect(actionDbPath);
		try {
			expect(conn.prepare("SELECT identity_id FROM identity_devices").get()).toEqual({
				identity_id: targetIdentityId,
			});
		} finally {
			conn.close();
		}
	});

	it("binds add-device bootstrap trust to the coordinator response, not mutable invite metadata", async () => {
		const actionDbPath = join(tmpDir, "authoritative-add-device-inviter.sqlite");
		const keysDir = join(tmpDir, "authoritative-add-device-inviter-keys");
		const configPath = join(tmpDir, "authoritative-add-device-inviter-config.json");
		const targetIdentityId = "identity-existing";
		const inviterPublicKey = "ssh-ed25519 authoritative-inviter-key";
		const reviewedIntent = addDeviceReviewedIntent(targetIdentityId);
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		const capturedBodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body =
					init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "{}";
				capturedBodies.push(JSON.parse(body) as Record<string, unknown>);
				return new Response(
					JSON.stringify({
						ok: true,
						status: "accepted",
						kind: "add_device",
						group_id: "coordinator-a",
						identity_id: targetIdentityId,
						target_identity_id: targetIdentityId,
						bootstrap_grant_id: "grant-authoritative",
						inviter_device: {
							device_id: "authoritative-inviter",
							public_key: inviterPublicKey,
							fingerprint: fingerprintPublicKey(inviterPublicKey),
							display_name: "Existing laptop",
						},
						reviewed_preview_digest: reviewedDigest,
						reviewed_intent: reviewedIntent,
					}),
					{ status: 200 },
				);
			}),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "add_device",
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token: "authoritative-add-device-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			target_identity_id: targetIdentityId,
			inviter_device_id: "tampered-inviter",
			reviewed_preview_digest: reviewedDigest,
		});
		const reviewedOnboardingDigest = reviewedOnboardingDigestForRecipientInvite({
			dbPath: actionDbPath,
			keysDir,
			invitationId: "authoritative-add-device-token",
			identityId: targetIdentityId,
			deviceDisplayName: "Recipient laptop",
			reviewedIntent,
		});

		const importOptions = {
			inviteValue: invite,
			dbPath: actionDbPath,
			keysDir,
			configPath,
			deviceDisplayName: "Recipient laptop",
			reviewedOnboardingDigest,
		};
		await expect(coordinatorImportInviteAction(importOptions)).resolves.toMatchObject({
			inviter_peer_linked: true,
		});
		const conn = connect(actionDbPath);
		try {
			expect(
				conn
					.prepare(`SELECT peer_device_id, pinned_fingerprint, public_key,
						pending_bootstrap_grant_id FROM sync_peers`)
					.all(),
			).toEqual([
				{
					peer_device_id: "authoritative-inviter",
					pinned_fingerprint: fingerprintPublicKey(inviterPublicKey),
					public_key: inviterPublicKey,
					pending_bootstrap_grant_id: "grant-authoritative",
				},
			]);
		} finally {
			conn.close();
		}
	});

	it("refuses to replace claimed-local or incompatible inviter trust", () => {
		const actionDbPath = join(tmpDir, "inviter-trust-conflicts.sqlite");
		const conn = connect(actionDbPath);
		try {
			conn
				.prepare(`INSERT INTO sync_peers(
				peer_device_id, claimed_local_actor, pinned_fingerprint, public_key, created_at
			) VALUES ('claimed-local', 1, NULL, NULL, ?),
				('incompatible', 0, 'old-fingerprint', 'old-key', ?),
				('unbound', 0, NULL, NULL, ?)`)
				.run("2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z");
			conn
				.prepare(`INSERT INTO actors(
				 actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
				 ) VALUES ('identity-local', 'Local Identity', 1, 'active', NULL, ?, ?)`)
				.run("2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z");
			conn
				.prepare(`INSERT INTO sync_peers(
				 peer_device_id, claimed_local_actor, actor_id, created_at
				 ) VALUES ('local-actor', 0, 'identity-local', ?)`)
				.run("2026-07-27T00:00:00.000Z");

			expect(isPeerTrustBindingCompatible(conn, "claimed-local", "new-key", "new-fp")).toBe(false);
			expect(isPeerTrustBindingCompatible(conn, "local-actor", "new-key", "new-fp")).toBe(false);
			expect(isPeerTrustBindingCompatible(conn, "incompatible", "new-key", "new-fp")).toBe(false);
			expect(isPeerTrustBindingCompatible(conn, "unbound", "new-key", "new-fp")).toBe(true);
			expect(isPeerTrustBindingCompatible(conn, "missing", "new-key", "new-fp")).toBe(true);
		} finally {
			conn.close();
		}
	});

	it("propagates add-device self-acceptance rejection without local persistence", async () => {
		const actionDbPath = join(tmpDir, "add-device-self-acceptance.sqlite");
		const keysDir = join(tmpDir, "add-device-self-acceptance-keys");
		const configPath = join(tmpDir, "add-device-self-acceptance-config.json");
		const targetIdentityId = "identity-existing";
		const token = "add-device-self-acceptance-token";
		const originalConfig = { sync_coordinator_groups: ["existing-group"] };
		writeCodememConfigFile(originalConfig, configPath);
		const reviewedIntent = addDeviceReviewedIntent(targetIdentityId);
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		const reviewedOnboardingDigest = reviewedOnboardingDigestForRecipientInvite({
			dbPath: actionDbPath,
			keysDir,
			invitationId: token,
			identityId: targetIdentityId,
			deviceDisplayName: "Existing laptop",
			reviewedIntent,
		});
		const inspection = {
			kind: "add_device",
			group_id: "coordinator-a",
			identity_id: targetIdentityId,
			target_identity_id: targetIdentityId,
			reviewed_preview_digest: reviewedDigest,
			reviewed_intent: reviewedIntent,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) =>
				String(url).endsWith("/v1/invites/inspect")
					? new Response(JSON.stringify(inspection), { status: 200 })
					: new Response(JSON.stringify({ error: "add_device_invite_self_acceptance_forbidden" }), {
							status: 409,
						}),
			),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "add_device",
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token,
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			target_identity_id: targetIdentityId,
			reviewed_preview_digest: reviewedDigest,
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				deviceDisplayName: "Existing laptop",
				reviewedOnboardingDigest,
			}),
		).rejects.toThrow(/^add_device_invite_self_acceptance_forbidden$/u);
		const conn = connect(actionDbPath);
		try {
			expect(conn.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
			expect(conn.prepare("SELECT COUNT(*) FROM sync_peers").pluck().get()).toBe(0);
			expect(conn.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
		} finally {
			conn.close();
		}
		expect(readCodememConfigFileAtPath(configPath)).toEqual(originalConfig);
	});

	it("does not adopt the add-device target when the config write fails and converges on retry", async () => {
		const actionDbPath = join(tmpDir, "add-device-config-failure.sqlite");
		const keysDir = join(tmpDir, "add-device-config-failure-keys");
		const blockedParent = join(tmpDir, "blocked-config-parent");
		const configPath = join(blockedParent, "config.json");
		const targetIdentityId = "identity-existing";
		const reviewedIntent = addDeviceReviewedIntent(targetIdentityId);
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		writeFileSync(blockedParent, "not a directory", "utf8");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: true,
							status: "accepted",
							kind: "add_device",
							group_id: "coordinator-a",
							identity_id: targetIdentityId,
							policy_team_id: null,
							target_identity_id: targetIdentityId,
							reviewed_preview_digest: reviewedDigest,
							reviewed_intent: reviewedIntent,
						}),
						{ status: 200 },
					),
			),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "add_device",
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token: "add-device-config-failure-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			target_identity_id: targetIdentityId,
			reviewed_preview_digest: reviewedDigest,
		});
		const reviewedOnboardingDigest = reviewedOnboardingDigestForRecipientInvite({
			dbPath: actionDbPath,
			keysDir,
			invitationId: "add-device-config-failure-token",
			identityId: targetIdentityId,
			deviceDisplayName: "Recipient laptop",
			reviewedIntent,
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				deviceDisplayName: "Recipient laptop",
				reviewedOnboardingDigest,
			}),
		).rejects.toThrow();
		const failed = connect(actionDbPath);
		try {
			expect(failed.prepare("SELECT COUNT(*) FROM actors").pluck().get()).toBe(0);
			expect(failed.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
		} finally {
			failed.close();
		}

		rmSync(blockedParent);
		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				deviceDisplayName: "Recipient laptop",
				reviewedOnboardingDigest,
			}),
		).resolves.toMatchObject({ status: "accepted", identity_id: targetIdentityId });
		expect(readCodememConfigFileAtPath(configPath)).toMatchObject({ actor_id: targetIdentityId });
		const retried = connect(actionDbPath);
		try {
			expect(retried.prepare("SELECT identity_id FROM identity_devices").pluck().get()).toBe(
				targetIdentityId,
			);
		} finally {
			retried.close();
		}
	});

	it("restores bootstrap config when add-device local commit fails and converges on retry", async () => {
		const actionDbPath = join(tmpDir, "add-device-commit-failure.sqlite");
		const keysDir = join(tmpDir, "add-device-commit-failure-keys");
		const configPath = join(tmpDir, "add-device-commit-failure-config.json");
		const targetIdentityId = "identity-existing";
		const reviewedIntent = addDeviceReviewedIntent(targetIdentityId);
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		initDatabase(actionDbPath);
		const setup = connect(actionDbPath);
		let bootstrapIdentityId = "";
		try {
			const [deviceId] = ensureDeviceIdentity(setup, { keysDir });
			bootstrapIdentityId = `local:${deviceId}`;
			setup
				.prepare(`INSERT INTO actors(
					actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
				) VALUES (?, 'Ada', 1, 'active', NULL, ?, ?)`)
				.run(bootstrapIdentityId, "2026-07-23T00:00:00.000Z", "2026-07-23T00:00:00.000Z");
			setup.exec(`CREATE TRIGGER fail_add_device_binding BEFORE INSERT ON identity_devices
				BEGIN SELECT RAISE(ABORT, 'test identity-device failure'); END`);
		} finally {
			setup.close();
		}
		const originalConfig = {
			actor_id: bootstrapIdentityId,
			actor_display_name: "Ada",
			sync_coordinator_groups: ["existing-group"],
		};
		writeCodememConfigFile(originalConfig, configPath);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: true,
							status: "accepted",
							kind: "add_device",
							group_id: "coordinator-a",
							identity_id: targetIdentityId,
							policy_team_id: null,
							target_identity_id: targetIdentityId,
							reviewed_preview_digest: reviewedDigest,
							reviewed_intent: reviewedIntent,
						}),
						{ status: 200 },
					),
			),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "add_device",
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token: "add-device-commit-failure-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			target_identity_id: targetIdentityId,
			reviewed_preview_digest: reviewedDigest,
		});
		const reviewedOnboardingDigest = reviewedOnboardingDigestForRecipientInvite({
			dbPath: actionDbPath,
			keysDir,
			invitationId: "add-device-commit-failure-token",
			identityId: targetIdentityId,
			deviceDisplayName: "Recipient laptop",
			reviewedIntent,
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				deviceDisplayName: "Recipient laptop",
				reviewedOnboardingDigest,
			}),
		).rejects.toThrow("onboarding_intent_conflict");
		expect(readCodememConfigFileAtPath(configPath)).toEqual(originalConfig);
		const failed = connect(actionDbPath);
		try {
			expect(
				failed.prepare("SELECT actor_id, is_local, status, merged_into_actor_id FROM actors").all(),
			).toEqual([
				{
					actor_id: bootstrapIdentityId,
					is_local: 1,
					status: "active",
					merged_into_actor_id: null,
				},
			]);
			expect(failed.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
			failed.exec("DROP TRIGGER fail_add_device_binding");
		} finally {
			failed.close();
		}

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				deviceDisplayName: "Recipient laptop",
				reviewedOnboardingDigest,
			}),
		).resolves.toMatchObject({ status: "accepted", identity_id: targetIdentityId });
		expect(readCodememConfigFileAtPath(configPath)).toMatchObject({ actor_id: targetIdentityId });
		const retried = connect(actionDbPath);
		try {
			expect(retried.prepare("SELECT identity_id FROM identity_devices").pluck().get()).toBe(
				targetIdentityId,
			);
		} finally {
			retried.close();
		}
	});

	it("rejects a configured add-device identity conflict before fetch or onboarding writes", async () => {
		const actionDbPath = join(tmpDir, "conflicting-add-device.sqlite");
		const keysDir = join(tmpDir, "conflicting-add-device-keys");
		const configPath = join(tmpDir, "conflicting-add-device-config.json");
		const originalConfig = {
			actor_id: "identity-configured",
			sync_coordinator_groups: ["existing-group"],
		};
		writeCodememConfigFile(originalConfig, configPath);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "add_device",
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token: "conflicting-add-device-token",
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			target_identity_id: "identity-target",
			reviewed_preview_digest: "coordinator-review",
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
			}),
		).rejects.toThrow("invite_identity_conflict");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(readCodememConfigFileAtPath(configPath)).toEqual(originalConfig);
		const conn = connect(actionDbPath);
		try {
			expect(conn.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
		} finally {
			conn.close();
		}
	});

	it.each([
		{
			label: "Team",
			kind: "team_member" as const,
			identityId: "identity-team",
			initialConfig: {
				sync_coordinator_groups: ["existing-group", "coordinator-a", "existing-group"],
				sync_coordinator_group: "legacy-group",
			},
			expectedGroups: ["existing-group", "coordinator-a"],
		},
		{
			label: "add-device",
			kind: "add_device" as const,
			identityId: "identity-add-device",
			initialConfig: { sync_coordinator_group: "existing-group" },
			expectedGroups: ["existing-group", "coordinator-a"],
		},
	])("persists and deduplicates coordinator config after $label onboarding", async (testCase) => {
		const actionDbPath = join(tmpDir, `${testCase.kind}-config.sqlite`);
		const keysDir = join(tmpDir, `${testCase.kind}-config-keys`);
		const configPath = join(tmpDir, `${testCase.kind}-config.json`);
		writeCodememConfigFile(testCase.initialConfig, configPath);
		const reviewedIntent =
			testCase.kind === "team_member"
				? teamReviewedIntent("team-a")
				: addDeviceReviewedIntent(testCase.identityId);
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		const capturedBodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				const body =
					init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "{}";
				capturedBodies.push(JSON.parse(body) as Record<string, unknown>);
				return new Response(
					JSON.stringify({
						ok: true,
						status: "accepted",
						kind: testCase.kind,
						group_id: "coordinator-a",
						identity_id: testCase.identityId,
						policy_team_id: testCase.kind === "team_member" ? "team-a" : null,
						target_identity_id: testCase.kind === "add_device" ? testCase.identityId : null,
						assigned_identity_id: testCase.kind === "team_member" ? testCase.identityId : null,
						reviewed_preview_digest: reviewedDigest,
						reviewed_intent: reviewedIntent,
					}),
					{ status: 200 },
				);
			}),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: testCase.kind,
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token: `${testCase.kind}-config-token`,
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			...(testCase.kind === "team_member"
				? { policy_team_id: "team-a", assigned_identity_id: testCase.identityId }
				: { target_identity_id: testCase.identityId }),
			reviewed_preview_digest: reviewedDigest,
		});
		const reviewedOnboardingDigest = reviewedOnboardingDigestForRecipientInvite({
			dbPath: actionDbPath,
			keysDir,
			invitationId: `${testCase.kind}-config-token`,
			identityId: testCase.identityId,
			deviceDisplayName: "Recipient laptop",
			reviewedIntent,
		});

		const result = await coordinatorImportInviteAction({
			inviteValue: invite,
			dbPath: actionDbPath,
			keysDir,
			configPath,
			recipientActorId: testCase.identityId,
			recipientDisplayName: "  Brian   Example  ",
			deviceDisplayName: "Recipient laptop",
			reviewedOnboardingDigest,
		});
		expect(result).toMatchObject({ status: "accepted", sync_enabled: true });
		await coordinatorImportInviteAction({
			inviteValue: invite,
			dbPath: actionDbPath,
			keysDir,
			configPath,
			recipientActorId: testCase.identityId,
			recipientDisplayName: "  Brian   Example  ",
			deviceDisplayName: "Recipient laptop",
			reviewedOnboardingDigest,
		});
		const joinBodies = capturedBodies.filter((body) => body.invite_kind === testCase.kind);
		expect(joinBodies).toHaveLength(2);
		expect(joinBodies[0]).toMatchObject({
			recipient_display_name: "Brian Example",
			device_display_name: "Recipient laptop",
		});

		const persistedConfig = readCodememConfigFileAtPath(configPath);
		expect(persistedConfig).toMatchObject({
			actor_id: testCase.identityId,
			sync_enabled: true,
			sync_host: "0.0.0.0",
			sync_port: 7337,
			sync_interval_s: 120,
			sync_coordinator_url: "https://coord.example.test",
			sync_coordinator_groups: testCase.expectedGroups,
			sync_coordinator_group: "existing-group",
		});
		const conn = connect(actionDbPath);
		try {
			expect(conn.prepare("SELECT COUNT(*) FROM actors").pluck().get()).toBe(1);
			expect(conn.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(1);
			expect(conn.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
			expect(conn.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(
				testCase.kind === "team_member" ? 1 : 0,
			);
			expect(conn.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get()).toBe(
				testCase.kind === "team_member" ? 1 : 0,
			);
		} finally {
			conn.close();
		}
	});

	it.each([
		{ kind: "team_member" as const, identityId: "identity-team", targetId: "team-a" },
		{
			kind: "add_device" as const,
			identityId: "identity-add-device",
			targetId: "identity-add-device",
		},
	])("rejects stale $kind onboarding before consuming the invite or mutating local state", async (testCase) => {
		const actionDbPath = join(tmpDir, `${testCase.kind}-stale-preflight.sqlite`);
		const keysDir = join(tmpDir, `${testCase.kind}-stale-preflight-keys`);
		const configPath = join(tmpDir, `${testCase.kind}-stale-preflight-config.json`);
		const originalConfig = {
			actor_id: testCase.identityId,
			sync_coordinator_groups: ["existing-group"],
		};
		writeCodememConfigFile(originalConfig, configPath);
		const reviewedIntent =
			testCase.kind === "team_member"
				? teamReviewedIntent(testCase.targetId)
				: addDeviceReviewedIntent(testCase.targetId);
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		const validOnboardingDigest = reviewedOnboardingDigestForRecipientInvite({
			dbPath: actionDbPath,
			keysDir,
			invitationId: `${testCase.kind}-stale-token`,
			identityId: testCase.identityId,
			deviceDisplayName: "Recipient laptop",
			reviewedIntent,
		});
		const localSnapshot = () => {
			const db = connect(actionDbPath);
			try {
				return JSON.stringify(
					Object.fromEntries(
						[
							"actors",
							"sync_device",
							"identity_devices",
							"policy_teams",
							"policy_team_memberships",
							"project_recipients",
						].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
					),
				);
			} finally {
				db.close();
			}
		};
		const beforeDb = localSnapshot();
		const requestedUrls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const requestedUrl = String(url);
				requestedUrls.push(requestedUrl);
				if (!requestedUrl.endsWith("/v1/invites/inspect")) {
					throw new Error(`unexpected request: ${requestedUrl}`);
				}
				return new Response(
					JSON.stringify({
						kind: testCase.kind,
						policy_team_id: testCase.kind === "team_member" ? testCase.targetId : undefined,
						assigned_identity_id: testCase.kind === "team_member" ? testCase.identityId : undefined,
						target_identity_id: testCase.kind === "add_device" ? testCase.targetId : undefined,
						reviewed_preview_digest: reviewedDigest,
						reviewed_intent: reviewedIntent,
						bound: false,
					}),
					{ status: 200 },
				);
			}),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: testCase.kind,
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token: `${testCase.kind}-stale-token`,
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			...(testCase.kind === "team_member"
				? {
						policy_team_id: testCase.targetId,
						assigned_identity_id: testCase.identityId,
					}
				: { target_identity_id: testCase.targetId }),
			reviewed_preview_digest: reviewedDigest,
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				recipientActorId: testCase.identityId,
				deviceDisplayName: "Recipient laptop",
				reviewedOnboardingDigest: `${validOnboardingDigest}-stale`,
			}),
		).rejects.toThrow("reviewed_onboarding_stale");
		expect(requestedUrls).toEqual(["https://coord.example.test/v1/invites/inspect"]);
		expect(localSnapshot()).toBe(beforeDb);
		expect(readCodememConfigFileAtPath(configPath)).toEqual(originalConfig);
	});

	it.each([
		{ label: "kind", responseOverride: { kind: "add_device" } },
		{ label: "target ID", responseOverride: { policy_team_id: "team-other" } },
		{ label: "reviewed digest", responseOverride: { reviewed_preview_digest: "f".repeat(64) } },
	])("rejects a mismatched $label returned by recipient invite inspection without local mutation", async (testCase) => {
		// Arrange
		const actionDbPath = join(
			tmpDir,
			`recipient-invite-${testCase.label.replaceAll(" ", "-")}.sqlite`,
		);
		const keysDir = join(tmpDir, `recipient-invite-${testCase.label.replaceAll(" ", "-")}-keys`);
		const configPath = join(
			tmpDir,
			`recipient-invite-${testCase.label.replaceAll(" ", "-")}-config.json`,
		);
		const identityId = "identity-recipient";
		const originalConfig = {
			actor_id: identityId,
			sync_coordinator_groups: ["existing-group"],
		};
		writeCodememConfigFile(originalConfig, configPath);
		initDatabase(actionDbPath);
		const setup = connect(actionDbPath);
		try {
			ensureDeviceIdentity(setup, { keysDir });
		} finally {
			setup.close();
		}
		const localSnapshot = () => {
			const db = connect(actionDbPath);
			try {
				return JSON.stringify(
					Object.fromEntries(
						[
							"actors",
							"sync_device",
							"identity_devices",
							"policy_teams",
							"policy_team_memberships",
							"project_recipients",
						].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
					),
				);
			} finally {
				db.close();
			}
		};
		const beforeDb = localSnapshot();
		const reviewedIntent = teamReviewedIntent("team-a");
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							ok: true,
							status: "accepted",
							kind: "team_member",
							group_id: "coordinator-a",
							identity_id: identityId,
							policy_team_id: "team-a",
							target_identity_id: null,
							assigned_identity_id: identityId,
							reviewed_preview_digest: reviewedDigest,
							reviewed_intent: reviewedIntent,
							...testCase.responseOverride,
						}),
						{ status: 200 },
					),
			),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: "team_member",
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token: `recipient-${testCase.label}-token`,
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			policy_team_id: "team-a",
			assigned_identity_id: identityId,
			reviewed_preview_digest: reviewedDigest,
		});

		// Act
		const acceptance = coordinatorImportInviteAction({
			inviteValue: invite,
			dbPath: actionDbPath,
			keysDir,
			configPath,
			recipientActorId: identityId,
			recipientDisplayName: "Recipient",
			deviceDisplayName: "Recipient laptop",
			reviewedOnboardingDigest: `recipient-onboarding-preview-v1:${"a".repeat(64)}`,
		});

		// Assert
		await expect(acceptance).rejects.toThrow("recipient_invite_intent_mismatch");
		expect(localSnapshot()).toBe(beforeDb);
		expect(readCodememConfigFileAtPath(configPath)).toEqual(originalConfig);
	});

	it.each([
		{
			kind: "team_member" as const,
			targetId: "team-a",
			identityId: "identity-recipient-team",
		},
		{
			kind: "add_device" as const,
			targetId: "identity-recipient-device",
			identityId: "identity-recipient-device",
		},
	])("rejects a conflicting $kind response Identity after valid inspection without local persistence", async (testCase) => {
		const actionDbPath = join(tmpDir, `recipient-post-join-${testCase.kind}-mismatch.sqlite`);
		const keysDir = join(tmpDir, `recipient-post-join-${testCase.kind}-mismatch-keys`);
		const configPath = join(tmpDir, `recipient-post-join-${testCase.kind}-mismatch-config.json`);
		const token = `recipient-post-join-${testCase.kind}-mismatch-token`;
		const originalConfig = {
			actor_id: testCase.identityId,
			sync_coordinator_groups: ["existing-group"],
		};
		writeCodememConfigFile(originalConfig, configPath);
		const reviewedIntent =
			testCase.kind === "team_member"
				? teamReviewedIntent(testCase.targetId)
				: addDeviceReviewedIntent(testCase.targetId);
		const reviewedDigest = await recipientReviewedIntentDigest(reviewedIntent);
		const reviewedOnboardingDigest = reviewedOnboardingDigestForRecipientInvite({
			dbPath: actionDbPath,
			keysDir,
			invitationId: token,
			identityId: testCase.identityId,
			deviceDisplayName: "Recipient laptop",
			reviewedIntent,
		});
		const validResponse = {
			ok: true,
			status: "accepted",
			kind: testCase.kind,
			group_id: "coordinator-a",
			identity_id: testCase.identityId,
			policy_team_id: testCase.kind === "team_member" ? testCase.targetId : null,
			target_identity_id: testCase.kind === "add_device" ? testCase.targetId : null,
			assigned_identity_id: testCase.kind === "team_member" ? testCase.identityId : null,
			reviewed_preview_digest: reviewedDigest,
			reviewed_intent: reviewedIntent,
		};
		const requestedUrls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL) => {
				const requestedUrl = String(url);
				requestedUrls.push(requestedUrl);
				return new Response(
					JSON.stringify(
						requestedUrl.endsWith("/v1/invites/inspect")
							? validResponse
							: { ...validResponse, identity_id: "identity-other" },
					),
					{ status: 200 },
				);
			}),
		);
		const invite = encodeInvitePayload({
			v: 1,
			kind: testCase.kind,
			coordinator_url: "https://coord.example.test",
			group_id: "coordinator-a",
			policy: "auto_admit",
			token,
			expires_at: "2099-01-01T00:00:00.000Z",
			team_name: null,
			...(testCase.kind === "team_member"
				? {
						policy_team_id: testCase.targetId,
						assigned_identity_id: testCase.identityId,
					}
				: { target_identity_id: testCase.targetId }),
			reviewed_preview_digest: reviewedDigest,
		});

		await expect(
			coordinatorImportInviteAction({
				inviteValue: invite,
				dbPath: actionDbPath,
				keysDir,
				configPath,
				recipientActorId: testCase.identityId,
				recipientDisplayName: "Recipient",
				deviceDisplayName: "Recipient laptop",
				reviewedOnboardingDigest,
			}),
		).rejects.toThrow("recipient_invite_intent_mismatch");
		expect(requestedUrls).toEqual([
			"https://coord.example.test/v1/invites/inspect",
			"https://coord.example.test/v1/join",
		]);
		const db = connect(actionDbPath);
		try {
			expect(db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
			expect(db.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get()).toBe(0);
			expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
		} finally {
			db.close();
		}
		expect(readCodememConfigFileAtPath(configPath)).toEqual(originalConfig);
	});

	it("warns when local invite coordinator URL uses private IPv6 space", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "http://[fd7a:115c:a1e0::1234]:7347",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([
			"Invite uses a ULA/Tailnet-style coordinator IPv6 address. This can be correct for private-network teams, but other teammates may not be able to join unless they share that network.",
		]);
	});

	it("warns when local invite coordinator URL uses link-local IPv6 space", async () => {
		await coordinatorCreateGroupAction({ groupId: "team-a", dbPath });
		const invite = await coordinatorCreateInviteAction({
			groupId: "team-a",
			coordinatorUrl: "http://[fe80::1]:7347",
			policy: "auto_admit",
			ttlHours: 24,
			dbPath,
		});
		expect(invite.warnings).toEqual([
			"Invite uses a link-local coordinator IPv6 address. It usually only works on the same local network segment.",
		]);
	});
});
