import { expect } from "vitest";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import {
	insertOwnership,
	OWNERSHIP_TABLE,
	ownedRow,
} from "./coordinator-device-ownership-test-harness.js";
import type {
	RevocationFixture,
	revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import { pendingJoin } from "./coordinator-join-revocation-test-harness.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import { OWNED_DENIAL } from "./shared-owned-device-enrollment-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

type Writer = "enroll" | "add_device" | "team_member" | "project" | "join";
type Target = Writer | "enable";
type Transition = "disable" | "remove" | "last group recreate" | "history cleanup";
type Evidence = "ID" | "incoming key" | "current key";
type Test = ReturnType<typeof revocationHarness>;
const writers: Writer[] = ["enroll", "add_device", "team_member", "project", "join"];
const browserHash = "c".repeat(64);
const completionHash = "d".repeat(64);
const transitions: Transition[] = ["disable", "remove", "last group recreate", "history cleanup"];

// The snapshot includes every application table, not just expected writer effects.
// Entries provide their schema's table names; no schema or snapshot framework is added.
export type LifecycleFixture = RevocationFixture & {
	tables: string[];
	reopen?: () => Promise<void>;
};
export async function lifecycleSnapshot(f: LifecycleFixture) {
	return Promise.all(f.tables.map(f.rows));
}
export async function lifecycleOperation(
	f: RevocationFixture,
	writer: Target,
): Promise<{ method: string; args: unknown[] }> {
	if (writer === "enable")
		return { method: "setDeviceEnabled", args: [f.input.groupId, f.input.deviceId, true] };
	if (writer === "enroll") {
		await f.store.createGroup(f.input.groupId);
		return {
			method: "enrollDevice",
			args: [f.input.groupId, { ...f.input, identityId: "recipient-identity" }],
		};
	}
	if (writer === "project") {
		const { input } = await projectInvite(f);
		return { method: "consumeProjectInvite", args: [input] };
	}
	if (writer === "join") {
		const { options } = await pendingJoin(f);
		return { method: "reviewJoinRequest", args: [options] };
	}
	const { input } = await recipientInvite(f, writer);
	return { method: "consumeRecipientInvite", args: [input] };
}
export async function lifecycleWriter(f: RevocationFixture, writer: Target) {
	const operation = await lifecycleOperation(f, writer);
	return () => {
		switch (operation.method) {
			case "setDeviceEnabled":
				return f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, true);
			case "enrollDevice":
				return f.store.enrollDevice(
					f.input.groupId,
					operation.args[1] as Parameters<typeof f.store.enrollDevice>[1],
				);
			case "consumeProjectInvite":
				return f.store.consumeProjectInvite(
					operation.args[0] as Parameters<typeof f.store.consumeProjectInvite>[0],
				);
			case "reviewJoinRequest":
				return f.store.reviewJoinRequest(
					operation.args[0] as Parameters<typeof f.store.reviewJoinRequest>[0],
				);
			case "consumeRecipientInvite":
				return f.store.consumeRecipientInvite(
					operation.args[0] as Parameters<typeof f.store.consumeRecipientInvite>[0],
				);
			default:
				throw new Error("Unknown lifecycle fixture writer");
		}
	};
}
export async function lifecycleBinding(f: RevocationFixture, evidence: Evidence) {
	// Deliberately raw retained denial evidence: never a positive owner credential.
	await insertOwnership(
		{ store: f.store, exec: f.exec, query: async () => [] },
		{
			...ownedRow,
			device_id: evidence === "ID" ? f.input.deviceId : "retained-other-device",
			key_id: evidence === "ID" ? "b".repeat(64) : ownedRow.key_id,
			identity_id: "recipient-identity",
		},
	);
}
async function transition(f: RevocationFixture, action: Transition) {
	// Reset only labels shared by the existing invite fixture seeds, not authority.
	await f.exec(
		"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id IN (?, ?)",
		f.input.deviceId,
		`${f.input.deviceId}-seed`,
	);
	if (action === "remove" || action === "last group recreate") {
		await f.store.removeDevice(f.input.groupId, f.input.deviceId);
		if (action === "last group recreate") {
			await f.store.removeDevice(f.input.groupId, `${f.input.deviceId}-seed`);
			await f.exec("DELETE FROM groups WHERE group_id = ?", f.input.groupId);
			await f.store.createGroup(f.input.groupId);
		}
		return;
	}
	await f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, false);
	// Human labels are not owner proof. A null legacy label permits each clean
	// writer control to reach its actual admission guard rather than tuple conflict.
	if (action === "history cleanup") {
		expect(
			await f.store.renameDevice(f.input.groupId, f.input.deviceId, "Renamed owner label"),
		).toBe(true);
		for (const table of [
			"coordinator_auth_sessions",
			"coordinator_auth_session_receipts",
			"coordinator_auth_link_attempts",
			"coordinator_auth_link_audit_log",
		])
			await f.exec(`DELETE FROM ${table}`);
	}
}
function eligible(target: Target, action: Transition, evidence: Evidence) {
	const retainsEnrollment = action === "disable" || action === "history cleanup";
	if (target === "enable") return retainsEnrollment && evidence !== "incoming key";
	if (evidence === "current key")
		return retainsEnrollment && (target === "enroll" || target === "join");
	return true;
}
async function arrangeLifecycle(
	f: LifecycleFixture,
	source: Writer,
	target: Target,
	action: Transition,
	evidence: Evidence,
	owned: boolean,
) {
	f.input.fingerprint = fingerprintPublicKey(f.input.publicKey);
	await (await lifecycleWriter(f, source))();
	if (owned) await lifecycleBinding(f, evidence);
	await transition(f, action);
	const candidate = { ...f, input: { ...f.input } };
	if (evidence === "incoming key") {
		candidate.input.deviceId += "-new-id";
		candidate.input.publicKey = `${CANONICAL_PUBLIC_KEY} lifecycle-alias`;
	}
	if (evidence === "current key") candidate.input.publicKey = UNRELATED_PUBLIC_KEY;
	candidate.input.fingerprint = fingerprintPublicKey(candidate.input.publicKey);
	const run = await lifecycleWriter(candidate, target);
	// Reopening belongs to the fixture: SQLite entries close and reopen a real file.
	// Native pool entries omit this hook; they do not pretend to cold-restart D1.
	await f.reopen?.();
	candidate.store = f.store;
	return run;
}
export function registerOwnershipWriterLifecycle(test: Test) {
	for (const source of writers) {
		for (const target of [...writers, "enable"] as Target[]) {
			if (source === target) continue;
			registerWriterPair(test, source, target);
		}
	}
	registerRetryLifecycle(test);
	registerRevocationPriority(test);
	registerSeparateAuthorityCleanup(test);
}
function registerWriterPair(test: Test, source: Writer, target: Target) {
	for (const action of transitions) {
		for (const evidence of ["ID", "incoming key", "current key"] as Evidence[]) {
			if (!eligible(target, action, evidence)) continue;
			for (const owned of [false, true]) {
				test(`${source} -> ${target}: ${action}, ${evidence}, ${owned ? "retained denial" : "clean control"}`, async ({
					fixture,
				}) => {
					// Arrange: enrollment comes from another real writer before the raw binding.
					const f = fixture as LifecycleFixture;
					const run = await arrangeLifecycle(f, source, target, action, evidence, owned);
					const before = await lifecycleSnapshot(f);
					// Act
					const pending = run();
					// Assert: exact denial leaves every actual row unchanged after planned cleanup.
					if (owned) {
						await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
						expect(await lifecycleSnapshot(f)).toEqual(before);
						return;
					}
					await pending;
					await assertCleanEnrollment(f, evidence, target);
					expect(await f.rows(OWNERSHIP_TABLE)).toEqual([]);
				});
			}
		}
	}
}
async function assertCleanEnrollment(f: LifecycleFixture, evidence: Evidence, target: Target) {
	const deviceId = evidence === "incoming key" ? `${f.input.deviceId}-new-id` : f.input.deviceId;
	let publicKey = f.input.publicKey;
	if (evidence === "incoming key") publicKey = `${CANONICAL_PUBLIC_KEY} lifecycle-alias`;
	if (evidence === "current key" && target !== "enable") publicKey = UNRELATED_PUBLIC_KEY;
	expect(await f.store.getEnrollment(f.input.groupId, deviceId)).toMatchObject({
		enabled: 1,
		public_key: publicKey,
	});
}
type RetryWriter = "add_device" | "team_member" | "project";
type RetryStage = "retry" | "identity repair" | "grant recovery";
async function arrangeRetry(
	f: LifecycleFixture,
	writer: RetryWriter,
	stage: RetryStage,
	owned: boolean,
) {
	f.input.fingerprint = fingerprintPublicKey(f.input.publicKey);
	await (await lifecycleWriter(f, "enroll"))();
	await f.exec(
		"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
		f.input.deviceId,
	);
	const run = await lifecycleWriter(f, writer);
	if (stage === "grant recovery")
		await f.store.setDeviceEnabled(f.input.groupId, `${f.input.deviceId}-seed`, false);
	await run();
	if (owned) await lifecycleBinding(f, "ID");
	if (stage === "identity repair")
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
			f.input.deviceId,
		);
	if (stage === "grant recovery")
		await f.store.setDeviceEnabled(f.input.groupId, `${f.input.deviceId}-seed`, true);
	await f.reopen?.();
	return run;
}
function registerRetryLifecycle(test: Test) {
	for (const writer of ["add_device", "team_member", "project"] as const) {
		for (const stage of ["retry", "identity repair", "grant recovery"] as const) {
			for (const owned of [false, true]) {
				test(`enroll -> ${writer} ${stage} after retained lifecycle, owned=${owned}`, async ({
					fixture,
				}) => {
					// Arrange: another writer creates the initial tuple, then a clean consume commits.
					const f = fixture as LifecycleFixture;
					const run = await arrangeRetry(f, writer, stage, owned);
					const before = await lifecycleSnapshot(f);
					// Act
					const pending = run();
					// Assert
					if (owned) {
						await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
						expect(await lifecycleSnapshot(f)).toEqual(before);
					} else expect(await pending).toMatchObject({ status: "existing" });
				});
			}
		}
	}
}
function registerRevocationPriority(test: Test) {
	for (const target of [...writers, "enable"] as Target[]) {
		test(`retained ownership never masks revocation for ${target} after cleanup`, async ({
			fixture,
		}) => {
			// Arrange: R and ownership remain independent after transient history is removed.
			const f = fixture as LifecycleFixture;
			f.input.fingerprint = fingerprintPublicKey(f.input.publicKey);
			await (await lifecycleWriter(f, "enroll"))();
			const run = await lifecycleWriter(f, target);
			expect(await f.store.createDeviceRevocation(f.input)).toMatchObject({ kind: "revoked" });
			await lifecycleBinding(f, "ID");
			await transition(f, "history cleanup");
			await f.reopen?.();
			const before = await lifecycleSnapshot(f);
			// Act
			const pending = run();
			// Assert
			if (target === "enable") expect(await pending).toBe(false);
			else await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(await lifecycleSnapshot(f)).toEqual(before);
		});
	}
}
async function separateAuthority(f: LifecycleFixture) {
	const signer = { ...f.input };
	// Keep this shared setup Worker-safe; the older auth fixtures import SQLite.
	const cfg = {
		coordinatorId: "coordinator-a",
		issuer: "https://accounts.example.test",
		revision: "a".repeat(64),
		enabled: true,
	};
	const evidence = {
		...signer,
		coordinatorId: cfg.coordinatorId,
		identityId: "identity-a",
		attestationId: "attestation-a",
		reviewReceiptId: "receipt-a",
		evidenceDigest: "b".repeat(64),
	};
	expect(await f.store.createAuthControllerAttestation(evidence)).toMatchObject({
		kind: "created",
	});
	expect(await f.store.issueIdentityGroupGrantFromControllerAttestation(evidence)).toMatchObject({
		kind: "created",
	});
	expect(
		await f.store.createAuthLinkAttempt(
			{
				signer,
				attemptId: "attempt-a",
				runtimeVerifierHash: "b".repeat(64),
				loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
			},
			cfg,
		),
	).toMatchObject({
		kind: "created",
	});
	await f.store.claimAuthLinkAttempt(
		{ attemptId: "attempt-a", browserTransactionHash: browserHash },
		cfg,
	);
	await f.store.recordAuthLinkOidcVerified(
		{
			attemptId: "attempt-a",
			browserTransactionHash: browserHash,
			account: { issuer: cfg.issuer, subject: "opaque-subject-a" },
		},
		cfg,
	);
	await f.store.confirmAuthLinkAttempt(
		{
			attemptId: "attempt-a",
			browserTransactionHash: browserHash,
			completionSecretHash: completionHash,
		},
		cfg,
	);
	await finalizeAuthoritySession(f, cfg);
}
async function finalizeAuthoritySession(f: LifecycleFixture, cfg: CoordinatorAuthLinkConfig) {
	const signer = { ...f.input };
	expect(
		await f.store.finalizeAuthLinkAttempt(
			{
				purpose: "coordinator-account-link-v1",
				coordinatorId: cfg.coordinatorId,
				identityId: "identity-a",
				attemptId: "attempt-a",
				runtimeVerifierHash: "b".repeat(64),
				completionSecretHash: completionHash,
				signer,
				groupId: signer.groupId,
				deviceId: signer.deviceId,
				fingerprint: signer.fingerprint,
			},
			cfg,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await f.store.redeemAuthLinkSession(
			{
				attemptId: "attempt-a",
				browserTransactionHash: browserHash,
				credentialHash: "e".repeat(64),
			},
			cfg,
		),
	).toMatchObject({ kind: "issued" });
}
function registerSeparateAuthorityCleanup(test: Test) {
	for (const owned of [false, true]) {
		test(`separate Identity grants/account links/raw history survive transient cleanup, owned=${owned}`, async ({
			fixture,
		}) => {
			// Arrange: issue real independent authorities before inserting raw denial evidence.
			const f = fixture as LifecycleFixture;
			f.input.fingerprint = fingerprintPublicKey(f.input.publicKey);
			await (await lifecycleWriter(f, "join"))();
			await separateAuthority(f);
			if (owned)
				await insertOwnership(
					{ store: f.store, exec: f.exec, query: async () => [] },
					{ ...ownedRow, device_id: f.input.deviceId, identity_id: "identity-a" },
				);
			const preservedTables = [
				"coordinator_identity_group_grants",
				"coordinator_auth_controller_attestations",
				"coordinator_auth_account_links",
				"coordinator_join_requests",
				"coordinator_bootstrap_grants",
			];
			const preserved = await Promise.all(preservedTables.map(f.rows));
			for (const table of [
				"coordinator_auth_sessions",
				"coordinator_auth_session_receipts",
				"coordinator_auth_link_attempts",
				"coordinator_auth_link_audit_log",
			])
				expect((await f.rows(table)).length).toBeGreaterThan(0);
			await transition(f, "history cleanup");
			for (const table of [
				"coordinator_auth_sessions",
				"coordinator_auth_session_receipts",
				"coordinator_auth_link_attempts",
				"coordinator_auth_link_audit_log",
			])
				expect(await f.rows(table)).toEqual([]);
			await f.reopen?.();
			const before = await lifecycleSnapshot(f);
			// Act: matching Identity labels and retained authorities still are not owner proof.
			const pending = f.store.enrollDevice(f.input.groupId, {
				...f.input,
				identityId: "identity-a",
			});
			// Assert
			if (owned) {
				await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
				expect(await lifecycleSnapshot(f)).toEqual(before);
			} else await pending;
			expect(await Promise.all(preservedTables.map(f.rows))).toEqual(preserved);
		});
	}
}
