import { expect } from "vitest";
import {
	insertOwnership,
	OWNERSHIP_TABLE,
	ownedRow,
} from "./coordinator-device-ownership-test-harness.js";
import type {
	RevocationFixture,
	revocationHarness,
} from "./coordinator-device-revocation-test-harness.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	NODE_ONLY_ALIASES,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	recipientInvite,
	recipientSnapshot,
	recipientTables,
} from "./coordinator-recipient-revocation-test-harness.js";
import { OWNED_DENIAL, OWNED_UNAVAILABLE } from "./shared-owned-device-enrollment-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

type Test = ReturnType<typeof revocationHarness>;
type Input = Awaited<ReturnType<typeof recipientInvite>>["input"];
type Kind = "team_member" | "add_device";
export const ownedRecipientTables = [...recipientTables, OWNERSHIP_TABLE];
export async function ownedRecipientSnapshot(f: RevocationFixture) {
	return [...(await recipientSnapshot(f)), await f.rows(OWNERSHIP_TABLE)];
}
// RAW INSERT simulates retained authority only. Provenance and matching identity are NOT owner proof.
export function bindRecipient(
	f: RevocationFixture,
	input: Input,
	subject = "key",
	identityId = input.identityId,
) {
	return insertOwnership(
		{ store: f.store, exec: f.exec, query: async () => [] },
		{
			...ownedRow,
			device_id: subject === "ID" ? input.deviceId : "retained-other-device",
			key_id: subject === "ID" ? "b".repeat(64) : ownedRow.key_id,
			identity_id: identityId,
		},
	);
}
async function stageRecipient(f: RevocationFixture, kind: Kind, stage: string) {
	const fixture = await recipientInvite(f, kind);
	if (stage === "grant recovery")
		await f.store.setDeviceEnabled(fixture.seed.groupId, fixture.seed.deviceId, false);
	if (stage !== "first") await f.store.consumeRecipientInvite(fixture.input);
	if (stage === "identity repair")
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
			fixture.input.deviceId,
		);
	if (stage === "grant recovery")
		await f.store.setDeviceEnabled(fixture.seed.groupId, fixture.seed.deviceId, true);
	return fixture;
}
export function registerOwnedRecipientContract(test: Test) {
	for (const kind of ["team_member", "add_device"] as const) {
		registerFirst(test, kind);
		registerRetained(test, kind);
		registerCurrentEnrollment(test, kind);
		registerOwnedInviter(test, kind);
		registerValidation(test, kind);
	}
}
export async function bindInviter(
	f: RevocationFixture,
	seed: Awaited<ReturnType<typeof recipientInvite>>["seed"],
) {
	const keyId = await ed25519KeyId(seed.publicKey);
	expect(keyId).not.toBeNull();
	expect(keyId).not.toBe(ownedRow.key_id);
	await insertOwnership(
		{ store: f.store, exec: f.exec, query: async () => [] },
		{
			...ownedRow,
			device_id: seed.deviceId,
			key_id: keyId,
			identity_id: seed.identityId,
		},
	);
}
function registerOwnedInviter(test: Test, kind: Kind) {
	for (const stage of ["first", "retry", "identity repair", "grant recovery"] as const) {
		test(`${kind} owned inviter alone permits unbound recipient ${stage} without changing inviter authority`, async ({
			fixture: f,
		}) => {
			// Arrange: enroll seed BEFORE raw binding; only recipient state is mutated by acceptance.
			const { input, seed } = await stageRecipient(f, kind, stage);
			await bindInviter(f, seed);
			const ledger = await f.rows(OWNERSHIP_TABLE);
			const inviter = await f.store.getEnrollment(seed.groupId, seed.deviceId, true);
			const group = await f.store.getGroup(seed.groupId);
			const grants = await f.store.listBootstrapGrants(seed.groupId);
			// Act: assigned/target recipient identity is not verified owner proof.
			const accepted = await f.store.consumeRecipientInvite(input);
			const retry = await f.store.consumeRecipientInvite(input);
			// Assert: ownership does not prohibit using an already-enrolled seed.
			expect(accepted.status).toBe(stage === "first" ? "accepted" : "existing");
			expect(retry.status).toBe("existing");
			expect(await f.store.getEnrollment(seed.groupId, input.deviceId)).toMatchObject({
				public_key: input.publicKey,
				identity_id: input.identityId,
				enabled: 1,
			});
			assertInviterBootstrap({
				kind,
				grant: accepted.bootstrap_grant,
				seedDeviceId: seed.deviceId,
				workerDeviceId: input.deviceId,
			});
			expect(retry.bootstrap_grant).toEqual(accepted.bootstrap_grant);
			expect(await f.store.listBootstrapGrants(seed.groupId)).toHaveLength(
				kind === "add_device" ? 1 : 0,
			);
			if (grants.length) expect(accepted.bootstrap_grant).toEqual(grants[0]);
			expect(await f.store.getEnrollment(seed.groupId, seed.deviceId, true)).toEqual(inviter);
			expect(await f.store.getGroup(seed.groupId)).toEqual(group);
			expect(await f.rows(OWNERSHIP_TABLE)).toEqual(ledger);
			expect(await f.rows("coordinator_device_revocations")).toEqual([]);
		});
	}
	test(`${kind} inviter revocation still denies when only inviter is owned`, async ({
		fixture: f,
	}) => {
		// Arrange: actual seed revocation is independent of ownership association.
		const { input, seed } = await recipientInvite(f, kind);
		await f.store.createDeviceRevocation(seed);
		await bindInviter(f, seed);
		const before = await ownedRecipientSnapshot(f);
		// Act
		const pending = f.store.consumeRecipientInvite(input);
		// Assert: ownership must not mask revocation.
		await expect(pending).rejects.toThrow(/^device_revoked$/);
		expect(await ownedRecipientSnapshot(f)).toEqual(before);
	});
}
function assertInviterBootstrap(options: {
	kind: Kind;
	grant: unknown;
	seedDeviceId: string;
	workerDeviceId: string;
}) {
	// Team-member recipients have a new identity, so no same-identity seed grant is issued.
	if (options.kind === "team_member") expect(options.grant).toBeNull();
	else
		expect(options.grant).toMatchObject({
			seed_device_id: options.seedDeviceId,
			worker_device_id: options.workerDeviceId,
		});
}
function registerCurrentEnrollment(test: Test, kind: Kind) {
	for (const stage of ["first", "retry", "identity repair", "grant recovery"] as const) {
		for (const retainedOwner of [false, true]) {
			test(`${kind} ${stage} preserves stored ${retainedOwner ? "owned" : "unbound"} key against clean incoming key without effects`, async ({
				fixture: f,
			}) => {
				// Arrange: body key is clean; only the actual stored PUB has canonical ownership.
				const input = await prepareCurrentEnrollment(f, kind, stage);
				if (retainedOwner) await bindRecipient(f, input);
				const before = await ownedRecipientSnapshot(f);
				// Act: retry body matches the committed invite, but not stored enrollment.
				const pending = f.store.consumeRecipientInvite(input);
				// Assert: legacy tuple mismatch remains private and precedes owner checks.
				await expect(pending).rejects.toThrow(/^invite_identity_conflict$/);
				expect(await ownedRecipientSnapshot(f)).toEqual(before);
			});
		}
	}
}
async function prepareCurrentEnrollment(f: RevocationFixture, kind: Kind, stage: string) {
	const { input, seed } = await recipientInvite(f, kind);
	input.publicKey = UNRELATED_PUBLIC_KEY;
	input.fingerprint = fingerprintPublicKey(input.publicKey);
	if (stage === "grant recovery")
		await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, false);
	if (stage === "first")
		await f.store.enrollDevice(f.input.groupId, { ...f.input, identityId: input.identityId });
	else await f.store.consumeRecipientInvite(input);
	await f.exec(
		"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE device_id = ?",
		CANONICAL_PUBLIC_KEY,
		fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
		input.deviceId,
	);
	if (stage === "identity repair")
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
			input.deviceId,
		);
	if (stage === "grant recovery") await f.store.setDeviceEnabled(seed.groupId, seed.deviceId, true);
	return input;
}
function registerFirst(test: Test, kind: Kind) {
	test(`${kind} unbound acceptance, identity repair, and retry retain legacy grants`, async ({
		fixture: f,
	}) => {
		// Arrange: no binding is issued by legacy acceptance.
		const { input } = await recipientInvite(f, kind);
		// Act
		const accepted = await f.store.consumeRecipientInvite(input);
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
			input.deviceId,
		);
		const retry = await f.store.consumeRecipientInvite(input);
		// Assert
		expect([accepted.status, retry.status]).toEqual(["accepted", "existing"]);
		expect(retry.bootstrap_grant).toEqual(accepted.bootstrap_grant);
		expect(await f.store.getEnrollment(f.input.groupId, input.deviceId)).toMatchObject({
			identity_id: input.identityId,
			enabled: 1,
		});
		expect(await f.rows(OWNERSHIP_TABLE)).toEqual([]);
	});
	for (const subject of ["ID", "key"] as const) {
		for (const identity of ["matching", "foreign"] as const) {
			test(`${kind} first acceptance denies isolated owned ${subject} with ${identity} identity hint`, async ({
				fixture: f,
			}) => {
				// Arrange: different key isolates ID authority; different ID isolates key authority.
				const { input } = await recipientInvite(f, kind);
				if (subject === "ID") {
					input.publicKey = UNRELATED_PUBLIC_KEY;
					input.fingerprint = fingerprintPublicKey(input.publicKey);
				}
				await bindRecipient(
					f,
					input,
					subject,
					identity === "matching" ? input.identityId : "foreign-identity",
				);
				const before = await ownedRecipientSnapshot(f);
				// Act
				const pending = f.store.consumeRecipientInvite(input);
				// Assert: assignment / add-device target never verifies account ownership.
				await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
				expect(await ownedRecipientSnapshot(f)).toEqual(before);
			});
		}
	}
}
function registerRetained(test: Test, kind: Kind) {
	for (const stage of ["retry", "identity repair", "grant recovery"] as const) {
		test(`${kind} later binding denies ${stage} without rewriting readable history`, async ({
			fixture: f,
		}) => {
			// Arrange: acceptance happened while unbound, before retained binding appeared.
			const { input } = await stageRecipient(f, kind, stage);
			const history = await f.store.getInviteByTokenForInspection(input.token);
			const grants = await f.store.listBootstrapGrants(f.input.groupId);
			await bindRecipient(f, input);
			const before = await ownedRecipientSnapshot(f);
			// Act
			const pending = f.store.consumeRecipientInvite(input);
			// Assert: retry returning permission requires proof; pure inspection does not.
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(await ownedRecipientSnapshot(f)).toEqual(before);
			expect(await f.store.getInviteByTokenForInspection(input.token)).toEqual(history);
			expect(await f.store.listInvites(f.input.groupId)).toContainEqual(history);
			expect(await f.store.listBootstrapGrants(f.input.groupId)).toEqual(grants);
			for (const grant of grants)
				expect(await f.store.getBootstrapGrant(grant.grant_id)).toEqual(grant);
		});
	}
	for (const alias of [
		...ACCEPTED_ALIASES.filter((alias) => alias.name === "comment"),
		...NODE_ONLY_ALIASES,
	]) {
		test(`${kind} retained canonical key denies new ID under ${alias.name} after device/group removal`, async ({
			fixture: f,
		}) => {
			// Arrange: retained key authority is global, independent of enrollment/group lifetime.
			const { input } = await recipientInvite(f, kind);
			await f.store.createGroup("discarded-group");
			await f.store.enrollDevice("discarded-group", f.input);
			await bindRecipient(f, input);
			await f.store.removeDevice("discarded-group", f.input.deviceId);
			await f.exec("DELETE FROM groups WHERE group_id = ?", "discarded-group");
			input.deviceId = "new-key-alias";
			input.publicKey = alias.publicKey;
			input.fingerprint = fingerprintPublicKey(input.publicKey);
			const before = await ownedRecipientSnapshot(f);
			// Act
			const pending = f.store.consumeRecipientInvite(input);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(await ownedRecipientSnapshot(f)).toEqual(before);
		});
	}
}
function registerValidation(test: Test, kind: Kind) {
	for (const failure of ["missing", "expired", "fingerprint", "identity", "kind"] as const) {
		test(`${kind} ${failure} validation precedes ownership without state effects`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input } = await recipientInvite(f, kind);
			await bindRecipient(f, input);
			Object.assign(
				input,
				{
					missing: { token: "missing-token" },
					expired: { now: "2100-01-01T00:00:00.000Z" },
					fingerprint: { fingerprint: "f".repeat(64) },
					identity: { identityId: "wrong-identity" },
					kind: { inviteKind: kind === "team_member" ? "add_device" : "team_member" },
				}[failure],
			);
			const before = await ownedRecipientSnapshot(f);
			// Act
			const pending = f.store.consumeRecipientInvite(input);
			// Assert
			const errors = {
				missing: "invite_invalid",
				expired: "invite_expired",
				fingerprint: "fingerprint_mismatch",
				identity: "invite_identity_conflict",
				kind: "invite_invalid",
			};
			await expect(pending).rejects.toThrow(new RegExp(`^${errors[failure]}$`));
			expect(await ownedRecipientSnapshot(f)).toEqual(before);
		});
	}
	test(`${kind} revocation precedes simultaneous retained ownership`, async ({ fixture: f }) => {
		// Arrange: genuine revocation evidence exists before raw binding simulation.
		const { input } = await recipientInvite(f, kind);
		await f.store.enrollDevice(f.input.groupId, { ...f.input, ...input });
		await f.store.createDeviceRevocation({ ...f.input, ...input });
		await bindRecipient(f, input);
		const before = await ownedRecipientSnapshot(f);
		// Act
		const pending = f.store.consumeRecipientInvite(input);
		// Assert
		await expect(pending).rejects.toThrow(/^device_revoked$/);
		expect(await ownedRecipientSnapshot(f)).toEqual(before);
	});
	test(`${kind} ownership schema absent fails privately without consuming`, async ({
		fixture: f,
	}) => {
		// Arrange: disposable database only.
		const { input } = await recipientInvite(f, kind);
		await f.exec(`DROP TABLE ${OWNERSHIP_TABLE}`);
		const before = await recipientSnapshot(f);
		// Act
		const pending = f.store.consumeRecipientInvite(input);
		// Assert
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
		expect(await recipientSnapshot(f)).toEqual(before);
	});
}
