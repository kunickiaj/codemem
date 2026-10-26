import { afterEach, describe, expect, it } from "vitest";
import {
	capabilitiesPath,
	cleanupAccountChangeHttpFixtures,
	config,
	fixture,
	keypair,
	NOW,
} from "./coordinator-account-change-http-test-fixtures.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";

afterEach(cleanupAccountChangeHttpFixtures);

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** device-b runs as identity-a, whose Google link device-a made; device-b has no proof yet. */
async function withPeer() {
	const f = await fixture();
	const peer = keypair("device-b");
	await f.store.enrollDevice("group-a", peer);
	f.db
		.prepare("UPDATE enrolled_devices SET identity_id = 'identity-a' WHERE device_id = 'device-b'")
		.run();
	return { f, peer };
}

async function bind(f: Fixture, peer: ReturnType<typeof keypair>, identityId = "identity-a") {
	f.db
		.prepare(
			`INSERT INTO coordinator_device_ownership_bindings
			 (device_id, key_id, identity_id, coordinator_id, binding_id, provenance, source_ref, bound_at)
			 VALUES (?, ?, ?, ?, 'binding-b', 'owner_enrollment', 'rebind:attempt-b', ?)`,
		)
		.run(
			peer.deviceId,
			await ed25519KeyId(peer.publicKey),
			identityId,
			config.coordinatorId,
			new Date(NOW).toISOString(),
		);
}

function recordLegacyDecision(f: Fixture, decision: Record<string, unknown>, identityId: string) {
	f.db
		.prepare(
			`INSERT INTO coordinator_legacy_team_completions
			 (group_id, candidate_ref, manifest_version, manifest_json, completed_at, created_at)
			 VALUES ('group-a', 'candidate-old', 1, ?, 'completed', 'created')`,
		)
		.run(
			JSON.stringify({
				coordinator_id: config.coordinatorId,
				memberships: [{ identity_id: identityId, role: "member" }],
				device_decisions: [{ identity_id: identityId, enabled: true, ...decision }],
			}),
		);
}

async function capabilities(f: Fixture, peer: ReturnType<typeof keypair>) {
	return (await (await f.send("GET", capabilitiesPath, undefined, peer)).json()).actions;
}

function status(f: Fixture, peer: ReturnType<typeof keypair>) {
	const { deviceId, publicKey, fingerprint } = peer;
	return f.store.readAccountLinkStatus(
		{ groupId: "group-a", deviceId, publicKey, fingerprint },
		config,
		{
			identityId: "identity-a",
		},
	);
}

describe("account changes from a device's ownership binding", () => {
	it("gives a rebound device Refresh, Unlink, and its linked status", async () => {
		// Arrange
		const { f, peer } = await withPeer();
		const unproven = await capabilities(f, peer);
		const unprovenStatus = await status(f, peer);
		// Act
		await bind(f, peer);
		const bound = await capabilities(f, peer);
		const boundStatus = await status(f, peer);
		// Assert
		expect(unproven).toEqual({ refresh: false, disconnect: false });
		expect(unprovenStatus).not.toMatchObject({ state: "linked", account: expect.anything() });
		expect(bound).toEqual({ refresh: true, disconnect: true });
		expect(boundStatus).toMatchObject({ state: "linked", identityId: "identity-a" });
		expect(boundStatus.account).not.toBeNull();
	});

	it("lets the binding supersede legacy Team history that named the old Identity", async () => {
		// Arrange: before the rebind, a legacy migration recorded device-b under its old Identity.
		const { f, peer } = await withPeer();
		recordLegacyDecision(
			f,
			{ device_id: peer.deviceId, key_fingerprint: peer.fingerprint, decision: "included" },
			"local:device-b",
		);
		const before = await capabilities(f, peer);
		// Act
		await bind(f, peer);
		// Assert
		expect(before).toEqual({ refresh: false, disconnect: false });
		expect(await capabilities(f, peer)).toEqual({ refresh: true, disconnect: true });
	});

	it.each([
		[
			"an owner excluded this device",
			(peer: ReturnType<typeof keypair>) => ({
				device_id: peer.deviceId,
				key_fingerprint: peer.fingerprint,
				decision: "excluded",
			}),
		],
		[
			"an owner excluded another device of the Identity",
			() => ({
				device_id: "device-z",
				key_fingerprint: "fingerprint-z",
				decision: "excluded",
			}),
		],
	])("keeps denying a bound device when %s", async (_case, decision) => {
		// Arrange: the binding waives only history naming this device's old Identity.
		const { f, peer } = await withPeer();
		recordLegacyDecision(f, decision(peer), "identity-a");
		// Act
		await bind(f, peer);
		// Assert
		expect(await capabilities(f, peer)).toEqual({ refresh: false, disconnect: false });
	});

	it("lets the binding supersede the device's own claim under its old Identity", async () => {
		// Arrange: device-b once claimed its old Identity (claims are permanent), then rebound.
		const { f, peer } = await withPeer();
		f.db
			.prepare(
				`INSERT INTO coordinator_auth_device_claims (claim_id, coordinator_id, identity_id, group_id,
				 device_id, public_key, fingerprint, key_id, attempt_id, issuer, auth_config_revision, created_at_ms)
				 VALUES ('claim-old', ?, 'local:device-b', 'group-a', ?, ?, ?, ?, 'attempt-old', ?, ?, 1)`,
			)
			.run(
				config.coordinatorId,
				peer.deviceId,
				peer.publicKey,
				peer.fingerprint,
				await ed25519KeyId(peer.publicKey),
				config.issuer,
				config.revision,
			);
		// Act
		await bind(f, peer);
		// Assert
		expect(await capabilities(f, peer)).toEqual({ refresh: true, disconnect: true });
		expect(await status(f, peer)).toMatchObject({ state: "linked", identityId: "identity-a" });
	});

	it("gives nothing for a binding that names another Identity", async () => {
		// Arrange
		const { f, peer } = await withPeer();
		// Act
		await bind(f, peer, "identity-other");
		// Assert
		expect(await capabilities(f, peer)).toEqual({ refresh: false, disconnect: false });
	});

	it("gives nothing once the bound device's key is revoked", async () => {
		// Arrange
		const { f, peer } = await withPeer();
		await bind(f, peer);
		// Act
		f.db
			.prepare(
				`INSERT INTO coordinator_device_revocations (subject_kind, subject_value, revocation_id,
				 evidence_group_id, evidence_device_id, evidence_public_key, evidence_fingerprint, created_at)
				 VALUES ('ed25519_key', ?, 'revocation-b', 'group-a', ?, ?, ?, 'created')`,
			)
			.run(await ed25519KeyId(peer.publicKey), peer.deviceId, peer.publicKey, peer.fingerprint);
		// Assert: a revoked key cannot even sign the request, and status shows no account.
		const response = await f.send("GET", capabilitiesPath, undefined, peer);
		expect([401, 403]).toContain(response.status);
		expect((await status(f, peer)).account).toBeNull();
	});
});
