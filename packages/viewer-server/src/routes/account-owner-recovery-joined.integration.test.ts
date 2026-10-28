import { deepStrictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect } from "@codemem/core";
import { expect, it, vi } from "vitest";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "../../../core/src/coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "../../../core/src/recipient-policy-identifiers.js";
import {
	recoveryAssociationFiles,
	recoveryFixture,
	recoveryTests,
} from "../../test/owner-recovery-service-fixture.js";
import { createAccountContextReader } from "../account/context.js";
import { createAccountLinkRegistry } from "../account/link-registry.js";
import { createAccountOwnerRecoveryService } from "../account/owner-recovery-service.js";
import type { RecoveryPreview, RecoveryProfile } from "../account/owner-recovery-types.js";
import { createApp } from "../index.js";

recoveryTests();
const LOCAL = "http://127.0.0.1:7441";
const BASE = "/api/account/owner-recovery";
const GROUPS = ["group-a", "group-b"];
type Fixture = Awaited<ReturnType<typeof recoveryFixture>>;

// Use the existing persisted manifest shape, replacing C with exactly two A/B histories.
function conflictingHistory(f: Fixture) {
	const row = f.db
		.prepare("SELECT manifest_json FROM coordinator_legacy_team_completions")
		.get() as {
		manifest_json: string;
	};
	const original = JSON.parse(row.manifest_json);
	f.db.exec("DELETE FROM coordinator_legacy_team_completions");
	for (const [index, groupId] of GROUPS.entries()) {
		const identityId = index === 0 ? "identity-a" : "identity-b";
		const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
			...original,
			candidate_ref: legacyTeamCandidateId(original.coordinator_id, groupId),
			team_id: `historical-team-${index}`,
			memberships: [{ identity_id: identityId, role: "member" }],
			device_decisions: original.device_decisions.map((decision: Record<string, unknown>) => ({
				...decision,
				identity_id: identityId,
			})),
		});
		f.db
			.prepare(`INSERT INTO coordinator_legacy_team_completions
			(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
			VALUES (?,?,1,?,?,?)`)
			.run(
				groupId,
				manifest.candidate_ref,
				canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
				manifest.completed_at,
				manifest.completed_at,
			);
	}
}

async function viewer(f: Fixture) {
	const captured = f.readContext("group-a");
	if (!("context" in captured) || !captured.context) throw new Error("Missing fixture context");
	const readContext = createAccountContextReader({
		getProfile: () => f.profile,
		readConfig: () => f.config,
		keysDir: f.keysDir,
		configPath: captured.context.configPath,
	});
	const registry = createAccountLinkRegistry({ readContext, link: f.link });
	const service = createAccountOwnerRecoveryService({ ...f.serviceOptions, readContext, registry });
	f.cleanup(() => registry.close());
	f.cleanup(() => service.close());
	const app = createApp({
		accountLink: {
			readContext,
			registry,
			ownerRecovery: service,
			getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
		},
	});
	const session = await app.request(`${LOCAL}/api/account/session`, {
		headers: { Host: "127.0.0.1:7441" },
	});
	expect(session.status).toBe(200);
	const { csrfToken } = await session.json();
	const headers = {
		Host: "127.0.0.1:7441",
		Origin: LOCAL,
		"X-Codemem-Account-Csrf": csrfToken,
		"Content-Type": "application/json",
	};
	return {
		readContext,
		async close() {
			await service.close();
			await registry.close();
		},
		send: (path: string, body?: unknown) =>
			app.request(`${LOCAL}${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
	};
}

async function setup() {
	const f = await recoveryFixture({ fact: false, groups: GROUPS, maintainedReview: true });
	conflictingHistory(f);
	vi.stubGlobal("fetch", f.transport);
	const app = await viewer(f);
	const response = await app.send(BASE);
	expect(response.status).toBe(200);
	const { profile } = (await response.json()) as { profile: RecoveryProfile };
	const selection = { profile, existingOwnerId: "identity-a", groups: GROUPS };
	const local = connect(f.dbPath);
	try {
		expect(local.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 1 });
	} finally {
		local.close();
	}
	return { f, app, selection };
}

async function preview(
	app: Awaited<ReturnType<typeof viewer>>,
	selection: unknown,
	purpose = "review",
) {
	const response = await app.send(`${BASE}/preview`, {
		...(selection as object),
		purpose,
		requestId: `joined-${purpose}`,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as RecoveryPreview;
}

function retainedBytes(f: Fixture) {
	return recoveryAssociationFiles(f.directory).map((path) => [path, readFileSync(path)]);
}

function withoutResolutions(f: Fixture) {
	return f.snapshot().filter(([name]) => name !== "coordinator_legacy_owner_resolutions");
}

async function expectOnlyFirstGroupConfirmation(f: Fixture) {
	const reviews = await Promise.all(
		f.requests
			.filter((request) => new URL(request.url).pathname === "/v1/admin/auth-controller-reviews")
			.map((request) => request.clone().json() as Promise<Record<string, unknown>>),
	);
	expect(reviews.filter((body) => Object.hasOwn(body, "confirm_owner_resolution_digest"))).toEqual([
		expect.objectContaining({ group_id: "group-a" }),
	]);
	// B has only its explicitly requested original preview, never a fresh digest or confirmation.
	expect(reviews.filter((body) => body.group_id === "group-b")).toEqual([
		expect.not.objectContaining({ confirm_owner_resolution_digest: expect.anything() }),
	]);
}

async function expectSeparateOwnerDisplay(
	app: Awaited<ReturnType<typeof viewer>>,
	groupId: string,
) {
	const response = await app.send(`/api/account/link-status?group_id=${groupId}`);
	expect(response.status).toBe(200);
	const view = await response.json();
	expect(view).toMatchObject({
		local: { identityId: "identity-b" },
		accountOwner: { identityId: "identity-a", memoryActorId: "identity-b" },
		remote: { kind: "not_checked" },
		ownerProjection: {
			status: { state: "owner_confirmed", profileState: "linked", ownerIdentity: "identity-a" },
		},
		canLink: false,
	});
	expect(view).not.toHaveProperty("managementActions");
	expect(view).not.toHaveProperty("unlinkTarget");
	expect(app.readContext(groupId)).toMatchObject({ context: { identityId: "identity-b" } });
}

it("confirms conflicting A/B history without changing authored data or access, then displays A after restart and no-admin import", async () => {
	// Arrange: A already has a real linked account; B authored the nonempty local database.
	const { f, app, selection } = await setup();
	const beforeLocal = f.immutableSnapshot();
	const beforeRemote = f.snapshot();
	const beforeAccessAndHistory = withoutResolutions(f);
	const review = await preview(app, selection);
	expect(review.history.complete).toBe(true);
	expect(review.history.rows.filter((row) => row.relation === "exact_subject")).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				groupId: "group-a",
				identityId: "identity-a",
				assignment: "included",
			}),
			expect.objectContaining({
				groupId: "group-b",
				identityId: "identity-b",
				assignment: "included",
			}),
		]),
	);
	expect(review.groupPreviews).toMatchObject(GROUPS.map((groupId) => ({ groupId, action: "new" })));
	expect(retainedBytes(f)).toEqual([]);
	expect(f.snapshot()).toEqual(beforeRemote);

	// Act: explicit confirmation is the only write; new instances read the retained generation.
	const confirmed = await app.send(`${BASE}/confirm`, {
		preview: review,
		approvalDigest: review.approvalDigest,
	});
	expect(confirmed.status).toBe(200);
	const confirmation = await confirmed.json();
	await expectOnlyFirstGroupConfirmation(f);
	expect(confirmation, JSON.stringify(confirmation.groups)).toMatchObject({
		groups: GROUPS.map((groupId) => ({ groupId, status: "confirmed" })),
	});
	const facts = f.db
		.prepare("SELECT * FROM coordinator_legacy_owner_resolutions ORDER BY resolution_id")
		.all() as Array<Record<string, string>>;
	expect(facts).toHaveLength(1);
	const fact = facts[0];
	if (!fact) throw new Error("Missing original resolution receipt");
	const proofCalls = f.readRemoteReceiptStatus.mock.calls.map(([input]) => input);
	expect(proofCalls.map((input) => input.groupId)).toEqual(GROUPS);
	expect(proofCalls[1]?.receipt).toEqual(proofCalls[0]?.receipt);
	expect(fact).toMatchObject({
		owner_identity_id: "identity-a",
		source_group_id: "retained-source",
		source_attestation_id: f.proof.controller.attestation_id,
		source_review_receipt_id: f.proof.controller.review_receipt_id,
		source_evidence_digest: f.proof.controller.evidence_digest,
	});
	const retained = retainedBytes(f);
	expect(retained).toHaveLength(2);
	await app.close();
	f.setAdmin(null);
	const restarted = await viewer(f);
	for (const groupId of GROUPS) await expectSeparateOwnerDisplay(restarted, groupId);
	const beforeImport = f.snapshot();
	const reply = {
		version: 1,
		purpose: "existing_account_owner",
		scope: "historical_included_owner_labels_only",
		coordinatorOrigin: selection.profile.coordinatorOrigin,
		coordinatorId: selection.profile.coordinatorId,
		deviceId: f.deviceId,
		fingerprint: f.fingerprint,
		ownerIdentityId: "identity-a",
		groups: GROUPS.map((groupId) => ({
			groupId,
			attestationId: fact.source_attestation_id,
			reviewReceiptId: fact.source_review_receipt_id,
			reviewEvidenceDigest: fact.source_evidence_digest,
			resolutionId: fact.resolution_id,
			resolutionEvidenceDigest: fact.resolution_evidence_digest,
		})),
	};
	const recoveredProfile = await restarted.send(BASE);
	const { profile } = await recoveredProfile.json();
	const imported = await restarted.send(`${BASE}/import`, {
		selection: { ...selection, profile },
		replyText: JSON.stringify(reply),
	});

	// Assert: signed receipt verification adds display metadata, never actor or sharing authority.
	expect(imported.status).toBe(200);
	expect(await imported.json()).toMatchObject({
		groups: GROUPS.map((groupId) => ({ groupId, status: "confirmed" })),
	});
	await restarted.close();
	const importedRestart = await viewer(f);
	for (const groupId of GROUPS) await expectSeparateOwnerDisplay(importedRestart, groupId);
	deepStrictEqual(retainedBytes(f), retained);
	expect(f.snapshot()).toEqual(beforeImport);
	expect(withoutResolutions(f)).toEqual(beforeAccessAndHistory);
	deepStrictEqual(f.immutableSnapshot(), beforeLocal);
	expect(f.link).not.toHaveBeenCalled();
});

it.each([
	"unavailable",
	"owner",
	"group",
	"device",
	"fingerprint",
	"coordinator",
	"profile",
	"actor",
	"shutdown",
] as const)(
	"does not retain B or send another mutation when carried receipt proof has %s failure",
	async (failure) => {
		// Arrange: A uses the genuine signed receipt; B must independently prove the same receipt.
		const { f, app, selection } = await setup();
		const review = await preview(app, selection);
		const beforeRemote = withoutResolutions(f);
		let expectedLocal = f.immutableSnapshot();
		const readReceipt = f.readRemoteReceiptStatus.getMockImplementation();
		if (!readReceipt) throw new Error("Missing signed receipt reader");
		f.readRemoteReceiptStatus.mockImplementation(async (input) => {
			if (input.groupId !== "group-b") return readReceipt(input);
			// A must already be published before its receipt is eligible to carry.
			expect(f.association("group-a")).toMatchObject({ ownerIdentityId: "identity-a" });
			expect(f.association("group-b")).toBeNull();
			if (failure === "unavailable")
				return { kind: "unavailable", code: "coordinator_unreachable" };
			const result = await readReceipt(input);
			expect(result).toMatchObject({
				kind: "owner_status",
				status: { groupId: "group-b", state: "owner_confirmed" },
			});
			if (result.kind !== "owner_status") throw new Error("Missing genuine B receipt proof");
			const mutations = {
				owner: { ownerIdentity: "identity-other" },
				group: { groupId: "group-a" },
				device: { deviceId: "other-device" },
				fingerprint: { fingerprint: "e".repeat(64) },
				coordinator: { coordinatorId: "other-coordinator" },
				profile: { profileState: "unavailable", profile: null },
			};
			if (failure === "actor") {
				f.profile.identityId = "identity-next";
				f.config.actor_id = "identity-next";
				expectedLocal = f.immutableSnapshot();
			} else if (failure === "shutdown") await app.close();
			else Object.assign(result.status, mutations[failure]);
			return result;
		});

		// Act: the original complete selected-group consent authorizes only qualified proof reads for B.
		const response = await app.send(`${BASE}/confirm`, {
			preview: review,
			approvalDigest: review.approvalDigest,
		});
		const result = await response.json();

		// Assert: no second write, no unqualified publication, and A's success survives B's failure.
		expect(response.status).toBe(200);
		await expectOnlyFirstGroupConfirmation(f);
		expect(f.readRemoteReceiptStatus.mock.calls.map(([input]) => input.groupId)).toEqual(GROUPS);
		const calls = f.readRemoteReceiptStatus.mock.calls;
		expect(calls[1]?.[0].receipt).toEqual(calls[0]?.[0].receipt);
		expect(result.groups).toMatchObject([
			{ groupId: "group-a", status: "confirmed" },
			{ groupId: "group-b", status: expect.stringMatching(/^(failed|unknown)$/) },
		]);
		expect(retainedBytes(f)).toHaveLength(1);
		expect(f.association("group-b")).toBeNull();
		deepStrictEqual(f.immutableSnapshot(), expectedLocal);
		expect(withoutResolutions(f)).toEqual(beforeRemote);
		expect(
			f.db.prepare("SELECT COUNT(*) AS n FROM coordinator_legacy_owner_resolutions").get(),
		).toEqual({ n: 1 });
		expect(f.link).not.toHaveBeenCalled();
	},
);

it("keeps a committed but unverified outcome unknown; repeated status and stale restart consent cannot publish", async () => {
	// Arrange: the remote confirmation is real; only its final receipt read becomes unavailable.
	const { f, app, selection } = await setup();
	const review = await preview(app, selection);
	const beforeLocal = f.immutableSnapshot();
	const beforeAccessAndHistory = withoutResolutions(f);
	f.readRemoteReceiptStatus.mockResolvedValue({
		kind: "unavailable",
		code: "coordinator_unreachable",
	});
	// Act
	const result = await app.send(`${BASE}/confirm`, {
		preview: review,
		approvalDigest: review.approvalDigest,
	});
	expect(result.status).toBe(200);
	expect(await result.json()).toMatchObject({
		groups: GROUPS.map((groupId) => ({ groupId, status: "unknown" })),
	});
	// An unverified A receipt is never eligible to carry to B, even though its fact exists remotely.
	expect(f.readRemoteReceiptStatus.mock.calls.map(([input]) => input.groupId)).toEqual(["group-a"]);
	expect(retainedBytes(f)).toEqual([]);
	const committed = f.snapshot();
	await app.close();
	const restarted = await viewer(f);
	const statusReview = await preview(restarted, selection, "check_status");
	await preview(restarted, selection, "check_status");
	const denied = await restarted.send(`${BASE}/confirm`, {
		preview: review,
		approvalDigest: review.approvalDigest,
	});
	const statusDenied = await restarted.send(`${BASE}/confirm`, {
		preview: statusReview,
		approvalDigest: statusReview.approvalDigest,
	});
	const status = await restarted.send("/api/account/link-status?group_id=group-a");
	// Assert: a new process has neither old consent nor permission to convert a status check into confirmation.
	expect([400, 409]).toContain(denied.status);
	expect([400, 409]).toContain(statusDenied.status);
	expect(status.status).toBe(200);
	const actorView = await status.json();
	expect(actorView.local.identityId).toBe("identity-b");
	expect(actorView.accountOwner).toBeUndefined();
	expect(retainedBytes(f)).toEqual([]);
	expect(f.snapshot()).toEqual(committed);
	expect(withoutResolutions(f)).toEqual(beforeAccessAndHistory);
	deepStrictEqual(f.immutableSnapshot(), beforeLocal);
	expect(f.link).not.toHaveBeenCalled();
});
