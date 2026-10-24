import { afterEach, beforeEach, expect, vi } from "vitest";
import { otherKey } from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { browserConfig } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	advance,
	attempt,
	backendTest,
	finalize,
	type LinkFixture,
	NOW,
} from "./coordinator-auth-link-test-fixtures.js";
import { review } from "./coordinator-auth-store-test-fixtures.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

const actor = "actor-current";
const adminSecret = "synthetic-admin-secret";
const signer = {
	groupId: "group-a",
	deviceId: "device-a",
	publicKey: CANONICAL_PUBLIC_KEY,
	fingerprint: "a".repeat(64),
};
const groups = ["group-a", "group-b"] as const;
const linkTables = [
	"coordinator_auth_controller_attestations",
	"coordinator_auth_link_audit_log",
	"coordinator_auth_link_attempts",
	"coordinator_auth_browser_transactions",
	"coordinator_auth_account_links",
];
const peer = {
	...signer,
	deviceId: "device-original",
	publicKey: otherKey,
	fingerprint: "b".repeat(64),
};

async function seedAccess(f: LinkFixture) {
	await f.store.enrollDevice(signer.groupId, peer);
	f.db
		.prepare(`INSERT INTO coordinator_identity_group_grants
		(coordinator_id,identity_id,group_id,status,revision,source_kind,source_receipt_id,created_at)
		VALUES (?, 'actor-old-a', 'group-a', 'active', 1, 'controller_attestation', 'old-receipt', 'created')`)
		.run(f.cfg.coordinatorId);
	for (const kind of ["team", "project"]) {
		const scopeId = `scope-${kind}`;
		await f.store.createScope({
			scopeId,
			kind,
			groupId: signer.groupId,
			coordinatorId: f.cfg.coordinatorId,
			label: `Synthetic ${kind}`,
			membershipEpoch: 1,
		});
		for (const deviceId of [peer.deviceId, signer.deviceId]) {
			await f.store.grantScopeMembership({
				scopeId,
				deviceId,
				effectId: `grant:${kind}:${deviceId}`,
				membershipEpoch: 1,
			});
		}
		expect(
			await f.store.revokeScopeMembership({
				scopeId,
				deviceId: signer.deviceId,
				effectId: `exclude:${kind}`,
				membershipEpoch: 2,
			}),
		).toBe(true);
	}
}

async function expectPeerOnlyAccess(f: LinkFixture) {
	for (const kind of ["team", "project"]) {
		const access = await f.store.getScopeAuthorization({
			groupId: signer.groupId,
			scopeId: `scope-${kind}`,
		});
		expect(access).toMatchObject({ kind: "authorized" });
		if (access.kind !== "authorized") throw new Error("fixture access unavailable");
		expect(access.members.map(({ membership }) => membership.device_id)).toEqual([peer.deviceId]);
		expect(await f.store.listScopeMemberships(`scope-${kind}`, true)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ device_id: signer.deviceId, status: "revoked" }),
				expect.objectContaining({ device_id: peer.deviceId, status: "active" }),
			]),
		);
	}
}

async function expectClaimDenied(f: LinkFixture) {
	const before = snapshot(f);
	for (const groupId of groups) {
		const claim = { signer: { ...signer, groupId }, identityId: actor };
		expect(await f.store.readAuthDeviceClaimReadiness(claim, f.cfg)).toEqual({
			kind: "unavailable",
		});
		expect(
			await f.store.createAuthLinkAttempt(
				attempt({
					signer: claim.signer,
					authority: { kind: "device_claim", identityId: actor },
				}),
				f.cfg,
			),
		).toMatchObject({ kind: "rejected" });
	}
	expect(snapshot(f)).toEqual(before);
}

async function seedHistory(f: LinkFixture, decision: "included" | "excluded" = "included") {
	for (const [index, groupId] of groups.entries()) {
		const oldActor = index === 0 ? "actor-old-a" : "actor-old-b";
		await f.store.createGroup(groupId);
		await f.store.enrollDevice(groupId, signer);
		const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
			version: 1,
			coordinator_id: f.cfg.coordinatorId,
			candidate_ref: legacyTeamCandidateId(f.cfg.coordinatorId, groupId),
			candidate_digest: "a".repeat(64),
			team_id: `team-${index}`,
			team_digest: "b".repeat(64),
			source_digest: "c".repeat(64),
			finish_digest: "d".repeat(64),
			access_delta_digest: "e".repeat(64),
			team: {
				display_name: `Synthetic Team ${index}`,
				policy_revision: "f".repeat(64),
				device_eligibility_mode: "reviewed_allowlist",
			},
			memberships: decision === "included" ? [{ identity_id: oldActor, role: "member" }] : [],
			device_decisions: [
				{
					device_id: signer.deviceId,
					key_fingerprint: signer.fingerprint,
					enabled: true,
					identity_id: decision === "included" ? oldActor : null,
					decision,
				},
			],
			project_mappings: [],
			project_recipients: [],
			completed_at: "2026-10-01T00:00:00.000Z",
		});
		f.db
			.prepare(`INSERT INTO coordinator_legacy_team_completions
			(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
			VALUES (?,?,?,?,?,?)`)
			.run(
				groupId,
				manifest.candidate_ref,
				1,
				canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
				manifest.completed_at,
				manifest.completed_at,
			);
	}
}

function snapshot(f: LinkFixture, except: string[] = []) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables
		.filter(({ name }) => !except.includes(name))
		.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}

function appFor(f: LinkFixture) {
	return createCoordinatorApp({
		storeFactory: () => f.store,
		requestVerifier: async () => false,
		runtime: { adminSecret: () => adminSecret, now: () => new Date(NOW).toISOString() },
		authLink: { config: browserConfig, storeFactory: () => f.store },
	});
}

async function seedOriginalAccount(f: LinkFixture) {
	f.db
		.prepare("UPDATE enrolled_devices SET identity_id='actor-old-a' WHERE device_id=?")
		.run(peer.deviceId);
	expect(
		await f.store.createAuthControllerAttestation(
			review({
				...peer,
				attestationId: "original-attestation",
				identityId: "actor-old-a",
			}),
		),
	).toMatchObject({ kind: "created" });
	await advance(
		f,
		"oidc_verified",
		attempt({
			signer: peer,
			attemptId: "original-attempt",
			runtimeVerifierHash: "2".repeat(64),
		}),
		"1".repeat(64),
	);
	expect(
		await f.store.confirmAuthLinkAttempt(
			{
				attemptId: "original-attempt",
				browserTransactionHash: "1".repeat(64),
				completionSecretHash: "3".repeat(64),
			},
			f.cfg,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await f.store.finalizeAuthLinkAttempt(
			finalize({
				signer: peer,
				deviceId: peer.deviceId,
				fingerprint: peer.fingerprint,
				identityId: "actor-old-a",
				attemptId: "original-attempt",
				runtimeVerifierHash: "2".repeat(64),
				completionSecretHash: "3".repeat(64),
			}),
			f.cfg,
		),
	).toMatchObject({ kind: "applied" });
}

function reviewRequest(
	app: ReturnType<typeof appFor>,
	options: { groupId?: string; digest?: string; credential?: string | null } = {},
) {
	return app.request("/v1/admin/auth-controller-reviews", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-Codemem-Admin-Actor": actor,
			...(options.credential === null
				? {}
				: {
						"X-Codemem-Coordinator-Admin": options.credential ?? adminSecret,
					}),
		},
		body: JSON.stringify({
			group_id: options.groupId ?? signer.groupId,
			device_id: signer.deviceId,
			identity_id: actor,
			fingerprint: signer.fingerprint,
			...(options.digest ? { confirm_evidence_digest: options.digest } : {}),
		}),
	});
}

function status(f: LinkFixture, groupId = signer.groupId) {
	return f.store.readAccountLinkStatus({ ...signer, groupId }, f.cfg, { identityId: actor });
}

const required = { state: "review_required", authority: null, identityId: null, account: null };

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = backendTest(backend);
	test(`${backend} requires separate explicit controller review after two completed legacy assignments`, async ({
		fixture: f,
	}) => {
		// Arrange: exact same enabled device/key, two different old actors, third current actor.
		await seedHistory(f);
		vi.spyOn(f.store, "close").mockResolvedValue(undefined);
		const app = appFor(f);
		const before = snapshot(f);
		const stable = snapshot(f, [
			"coordinator_auth_controller_attestations",
			"coordinator_auth_link_audit_log",
			"coordinator_auth_link_attempts",
			"coordinator_auth_browser_transactions",
			"coordinator_auth_account_links",
		]);

		// Act / Assert: history never creates claims, ownership, grants, or account authority.
		for (const groupId of groups) {
			expect(await status(f, groupId)).toMatchObject(required);
			expect(
				await f.store.readAuthDeviceClaimReadiness(
					{
						signer: { ...signer, groupId },
						identityId: actor,
					},
					f.cfg,
				),
			).toEqual({ kind: "unavailable" });
			expect(
				await f.store.createAuthLinkAttempt(
					attempt({
						signer: { ...signer, groupId },
						authority: { kind: "device_claim", identityId: actor },
					}),
					f.cfg,
				),
			).toMatchObject({ kind: "rejected" });
			expect(
				await f.store.createAuthLinkAttempt(attempt({ signer: { ...signer, groupId } }), f.cfg),
			).toMatchObject({ kind: "rejected" });
			const preview = await reviewRequest(app, { groupId });
			expect(preview.status).toBe(200);
			expect(await preview.json()).toMatchObject({
				state: "ready",
				enrollment: { identity_label: "none" },
			});
			expect(await status(f, groupId)).toMatchObject(required);
		}
		const preview = await (await reviewRequest(app)).json();
		const unauthorized = await reviewRequest(app, {
			digest: preview.evidence_digest,
			credential: null,
		});
		expect(unauthorized.status).toBe(401);
		expect(snapshot(f)).toEqual(before);

		// Act: only the explicit admin+digest commit supplies current controller authority.
		const committed = await reviewRequest(app, { digest: preview.evidence_digest });
		// Assert: this attestation is not a device claim or a grant, and is group-specific.
		expect(committed.status).toBe(201);
		const receipt = await committed.json();
		expect(receipt).toMatchObject({ state: "created", identity_id: actor, group_id: "group-a" });
		expect(f.db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all()).toEqual([
			expect.objectContaining({
				attestation_id: receipt.attestation_id,
				identity_id: actor,
				group_id: "group-a",
				device_id: signer.deviceId,
				public_key: signer.publicKey,
				fingerprint: signer.fingerprint,
			}),
		]);
		expect(await status(f)).toMatchObject({
			state: "unlinked",
			authority: "controller_attestation",
			identityId: actor,
			account: null,
		});
		expect(await status(f, "group-b")).toMatchObject(required);
		expect(
			snapshot(f, ["coordinator_auth_controller_attestations", "coordinator_auth_link_audit_log"]),
		).toEqual(
			before.filter(
				([name]) =>
					!["coordinator_auth_controller_attestations", "coordinator_auth_link_audit_log"].includes(
						name as string,
					),
			),
		);

		// Act: reuse the maintained browser-start/consume/verified/confirm/finalize store ceremony.
		await advance(f, "confirmed", attempt({ signer }));
		const linked = await f.store.finalizeAuthLinkAttempt(
			finalize({ signer, identityId: actor }),
			f.cfg,
		);
		// Assert: no completion/enrollment/membership/project/grant/ownership bytes change.
		expect(linked).toMatchObject({ kind: "applied", status: { state: "finalized" } });
		expect(await status(f)).toMatchObject({
			state: "linked",
			authority: "controller_attestation",
			identityId: actor,
		});
		expect(await status(f, "group-b")).toMatchObject(required);
		expect(f.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([
			expect.objectContaining({
				identity_id: actor,
				authority_kind: "controller_attestation",
				device_claim_id: null,
			}),
		]);
		expect(
			snapshot(f, [
				"coordinator_auth_controller_attestations",
				"coordinator_auth_link_audit_log",
				"coordinator_auth_link_attempts",
				"coordinator_auth_browser_transactions",
				"coordinator_auth_account_links",
			]),
		).toEqual(stable);
	});

	test(`${backend} excluded Team history permits reviewed ownership but never restores access or self-service claims`, async ({
		fixture: f,
	}) => {
		// Arrange: Team exclusion is not a coordinator-wide device/key revocation.
		// Protocol: device-claim-only checks; controller storage: review grants no permissions.
		await seedHistory(f, "excluded");
		await seedAccess(f);
		vi.spyOn(f.store, "close").mockResolvedValue(undefined);
		const app = appFor(f);
		const stable = snapshot(f, linkTables);
		await expectPeerOnlyAccess(f);
		await expectClaimDenied(f);
		expect(await status(f)).toMatchObject(required);

		// Act: explicit operator review establishes only the current controller Identity.
		const preview = await (await reviewRequest(app)).json();
		const committed = await reviewRequest(app, { digest: preview.evidence_digest });
		// Assert: real revoked membership records stay revoked; unrelated access stays active.
		expect(committed.status).toBe(201);
		expect(await status(f)).toMatchObject({
			state: "unlinked",
			authority: "controller_attestation",
			identityId: actor,
		});
		await expectClaimDenied(f);
		await expectPeerOnlyAccess(f);
		expect(snapshot(f, linkTables)).toEqual(stable);

		// Act: complete the attested account link without treating it as Team admission.
		await advance(f, "confirmed", attempt({ signer }));
		const linked = await f.store.finalizeAuthLinkAttempt(
			finalize({ signer, identityId: actor }),
			f.cfg,
		);
		// Assert: completion bytes, exclusions, enrollments, grants and access remain unchanged.
		expect(linked).toMatchObject({ kind: "applied", status: { state: "finalized" } });
		expect(await status(f)).toMatchObject({
			state: "linked",
			authority: "controller_attestation",
			identityId: actor,
		});
		await expectClaimDenied(f);
		await expectPeerOnlyAccess(f);
		expect(await status(f, "group-b")).toMatchObject(required);
		expect(snapshot(f, linkTables)).toEqual(stable);
	});

	test.for(["same-account", "distinct-account"] as const)(
		`${backend} current actor review respects original Identity account ownership with %s`,
		async (account, { fixture: f }) => {
			// Arrange: the original device already linked an account to the old canonical Identity.
			await seedHistory(f);
			await seedAccess(f);
			await seedOriginalAccount(f);
			const originalLinks = f.db.prepare("SELECT * FROM coordinator_auth_account_links").all();
			const originalAttempts = f.db
				.prepare("SELECT * FROM coordinator_auth_link_attempts WHERE attempt_id='original-attempt'")
				.all();
			const stable = snapshot(f, linkTables);
			vi.spyOn(f.store, "close").mockResolvedValue(undefined);
			const app = appFor(f);
			const preview = await (await reviewRequest(app)).json();
			expect((await reviewRequest(app, { digest: preview.evidence_digest })).status).toBe(201);
			expect(await status(f)).toMatchObject({
				state: "unlinked",
				identityId: actor,
				authority: "controller_attestation",
			});
			await advance(f, "confirmed", attempt({ signer }), undefined, {
				subject: account === "same-account" ? "opaque-subject-a" : "synthetic-distinct-subject",
			});
			const beforeFinalize = snapshot(f);

			// Act: admin review cannot move an already-bound provider subject to a different Identity.
			const result = await f.store.finalizeAuthLinkAttempt(
				finalize({ signer, identityId: actor }),
				f.cfg,
			);
			// Assert: distinct account succeeds, same account fails atomically without merging history.
			if (account === "same-account") {
				expect(result).toEqual({ kind: "rejected", error: "link_conflict" });
				expect(snapshot(f)).toEqual(beforeFinalize);
				expect(await status(f)).toMatchObject({
					state: "unlinked",
					identityId: actor,
					account: null,
				});
				expect(f.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual(
					originalLinks,
				);
			} else {
				expect(result).toMatchObject({ kind: "applied", status: { state: "finalized" } });
				expect(await status(f)).toMatchObject({ state: "linked", identityId: actor });
				expect(
					f.db
						.prepare("SELECT * FROM coordinator_auth_account_links WHERE identity_id=?")
						.all(actor),
				).toEqual([
					expect.objectContaining({ subject: "synthetic-distinct-subject", identity_id: actor }),
				]);
			}
			expect(
				f.db
					.prepare("SELECT * FROM coordinator_auth_account_links WHERE identity_id='actor-old-a'")
					.all(),
			).toEqual(originalLinks);
			expect(
				f.db
					.prepare(
						"SELECT * FROM coordinator_auth_link_attempts WHERE attempt_id='original-attempt'",
					)
					.all(),
			).toEqual(originalAttempts);
			expect(
				await f.store.readAccountLinkStatus(peer, f.cfg, { identityId: "actor-old-a" }),
			).toMatchObject({
				state: "linked",
				identityId: "actor-old-a",
				authority: "controller_attestation",
			});
			await expectPeerOnlyAccess(f);
			expect(snapshot(f, linkTables)).toEqual(stable);
		},
	);

	test.for(["revoked-key", "revoked-device", "conflicting-invite"] as const)(
		`${backend} operator review cannot unblock %s history`,
		async (control, { fixture: f }) => {
			// Arrange: change only the named disqualifying control on the same two-group fixture.
			await seedHistory(f);
			vi.spyOn(f.store, "close").mockResolvedValue(undefined);
			if (control === "revoked-key" || control === "revoked-device") {
				expect(await f.store.createDeviceRevocation(signer)).toMatchObject({ kind: "revoked" });
				// Isolate each global tombstone so neither case can pass on the other check.
				f.db
					.prepare("DELETE FROM coordinator_device_revocations WHERE subject_kind=?")
					.run(control === "revoked-key" ? "device_id" : "ed25519_key");
			}
			if (control === "conflicting-invite") {
				const invite = await f.store.createInvite({
					groupId: signer.groupId,
					policy: "auto",
					expiresAt: "2030-01-01T00:00:00Z",
				});
				f.db
					.prepare(`UPDATE coordinator_invites SET invite_kind='team_member',
					consumed_at='consumed', bound_device_id=?, bound_public_key=?, bound_fingerprint=?,
					recipient_actor_id='actor-old-a', assigned_identity_id='actor-old-a', reviewed_preview_digest=?
					WHERE invite_id=?`)
					.run(
						signer.deviceId,
						signer.publicKey,
						signer.fingerprint,
						"c".repeat(64),
						invite.invite_id,
					);
			}
			const before = snapshot(f);
			const app = appFor(f);
			// Act: even a syntactically valid confirmation must not bypass these controls.
			const preview = await (await reviewRequest(app)).json();
			const committed = await reviewRequest(app, {
				digest: preview.evidence_digest ?? "b".repeat(64),
			});
			const result = await status(f);
			// Assert
			expect(committed.status).toBeGreaterThanOrEqual(400);
			expect(result).toMatchObject(required);
			expect(snapshot(f)).toEqual(before);
		},
	);
}
