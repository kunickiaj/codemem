import { afterEach, describe, expect, it } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createDeviceRebindCeremony } from "./coordinator-device-rebind-ceremony.js";
import { readDeviceSelfBindEligibility } from "./coordinator-device-self-bind-authority.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { LEGACY_SETUP, linkedLegacySetupFixture } from "./linked-legacy-setup-test-fixtures.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});

describe.each(["SQLite", "D1"] as const)("%s pinned self-bind authority", (kind) => {
	it("refuses controller account links without a committed provenance receipt", async () => {
		// Arrange
		const f = await linkedLegacySetupFixture(kind, { accountAuthority: "controller_attestation" });
		close.push(f.close);
		f.coordinator.db.exec("DELETE FROM coordinator_auth_link_audit_log");
		// Act
		const result = await readDeviceSelfBindEligibility(
			nativeBackend(f.coordinator.db),
			{ signer: f.account.signer, currentIdentityId: LEGACY_SETUP.identityId },
			f.account.config,
			NOW,
		);
		// Assert
		expect(result).toEqual({ kind: "unavailable" });
	});
	it("offers the existing ceremony for one own controller proof and a valid account link", async () => {
		// Arrange: authentication proof has never supplied an ownership binding.
		const f = await linkedLegacySetupFixture(kind, { accountAuthority: "controller_attestation" });
		close.push(f.close);
		// Act
		const result = await readDeviceSelfBindEligibility(
			nativeBackend(f.coordinator.db),
			{
				signer: f.account.signer,
				currentIdentityId: LEGACY_SETUP.identityId,
			},
			f.account.config,
			NOW,
		);
		// Assert
		expect(result).toEqual({ kind: "eligible", identityId: LEGACY_SETUP.identityId });
		expect(
			f.coordinator.db
				.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id=?")
				.all(f.keyA.deviceId),
		).toEqual([]);
	});

	it("pins server authority at start without changing the client review digest", async () => {
		// Arrange
		const f = await linkedLegacySetupFixture(kind, { accountAuthority: "controller_attestation" });
		close.push(f.close);
		const ceremony = createDeviceRebindCeremony({
			backend: nativeBackend(f.coordinator.db),
			config: {
				...f.account.config,
				redirectUri: "https://app.example.test/auth/callback",
				clientId: "test-client",
				clientSecret: "test-secret",
			},
			publicOrigin: "https://app.example.test",
			now: () => NOW,
			csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(17)),
			limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
			client: {
				createAuthorizationRequest: async () => {
					throw new Error("no OIDC at start");
				},
				verifyCallback: async () => {
					throw new Error("no OIDC at start");
				},
			},
		});
		// Act
		const result = await ceremony.start(
			{
				attemptId: "self-bind-a",
				signer: f.account.signer,
				currentIdentityId: LEGACY_SETUP.identityId,
				reviewDigest: "e".repeat(64),
				browserStartHash: "b".repeat(64),
				loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
			},
			"client-a",
		);
		// Assert
		expect(result).toEqual({
			kind: "started",
			attemptId: "self-bind-a",
			expiresAtMs: NOW + 600000,
		});
		expect(
			f.coordinator.db
				.prepare(
					"SELECT review_digest, start_authority_json FROM coordinator_device_rebind_attempts",
				)
				.get(),
		).toMatchObject({ review_digest: "e".repeat(64), start_authority_json: expect.any(String) });
	});

	it("refuses a device claim instead of treating it as a controller-only gap", async () => {
		// Arrange
		const f = await linkedLegacySetupFixture(kind);
		close.push(f.close);
		// Act
		const result = await readDeviceSelfBindEligibility(
			nativeBackend(f.coordinator.db),
			{
				signer: f.account.signer,
				currentIdentityId: LEGACY_SETUP.identityId,
			},
			f.account.config,
			NOW,
		);
		// Assert
		expect(result).toEqual({ kind: "unavailable" });
	});
});
