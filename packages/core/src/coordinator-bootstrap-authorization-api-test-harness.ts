import { createPrivateKey, sign } from "node:crypto";
import { expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import {
	authorizationFixture,
	authorizationNowMs,
	bootstrapParticipant,
} from "./coordinator-bootstrap-authorization-test-harness.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import type {
	contractHarness,
	GrantFixture,
} from "./coordinator-identity-group-grant-test-harness.js";
import { buildCanonicalRequest, verifySignature } from "./sync-auth.js";

type Test = ReturnType<typeof contractHarness>;
const now = "2026-10-07T00:00:00Z";
const adminHeaders = { "X-Codemem-Coordinator-Admin": "fixture-admin" };
function appFor(f: GrantFixture, readLimit = 120) {
	return createCoordinatorApp({
		storeFactory: () => f.store,
		runtime: { now: () => now, adminSecret: () => "fixture-admin" },
		requestVerifier: async (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		requestRateLimit: {
			readLimit,
			limiter: { check: () => ({ allowed: readLimit !== 0, retryAfterS: 1 }) },
		},
	});
}
function signedHeaders(f: GrantFixture, path: string) {
	// RFC 8032 public test vector; not a live credential.
	const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
	const key = createPrivateKey({
		key: Buffer.from(`302e020100300506032b657004220420${seed}`, "hex"),
		format: "der",
		type: "pkcs8",
	});
	const timestamp = String(authorizationNowMs / 1000);
	const nonce = "bootstrap-api-fixture-nonce";
	const canonical = buildCanonicalRequest("GET", path, timestamp, nonce, Buffer.alloc(0));
	return {
		"X-Opencode-Device": bootstrapParticipant(f, "seed"),
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": nonce,
		"X-Opencode-Signature": `v2:${sign(null, canonical, key).toString("base64")}`,
	};
}
const failures = [
	["missing grant", 404, "grant_not_found"],
	["missing group", 404, "grant_not_found"],
	["archived", 409, "group_archived"],
	["revoked", 403, "grant_revoked"],
	["expired", 403, "grant_expired"],
	["calendar overflow", 503, "bootstrap_authorization_unavailable"],
	["timezone-less", 503, "bootstrap_authorization_unavailable"],
	["seed missing", 404, "seed_enrollment_not_found"],
	["worker missing", 404, "worker_enrollment_not_found"],
	["seed disabled", 404, "seed_enrollment_not_found"],
	["worker disabled", 404, "worker_enrollment_not_found"],
	["seed ID revoked", 403, "device_revoked"],
	["worker ID revoked", 403, "device_revoked"],
	["seed key revoked", 403, "device_revoked"],
	["worker key revoked", 403, "device_revoked"],
] as const;
async function change(f: GrantFixture, grantId: string, mode: string) {
	if (mode === "missing group") {
		await f.exec("DELETE FROM enrolled_devices WHERE group_id = ?", f.review.groupId);
		await f.exec("DELETE FROM groups WHERE group_id = ?", f.review.groupId);
	}
	if (mode === "archived") await f.store.archiveGroup(f.review.groupId);
	if (mode === "revoked") await f.store.revokeBootstrapGrant(grantId, now);
	const expiry: Record<string, string> = {
		expired: now,
		"calendar overflow": "2099-02-30T00:00:00Z",
		"timezone-less": "2099-01-01T00:00:00",
	};
	if (expiry[mode])
		await f.exec(
			"UPDATE coordinator_bootstrap_grants SET expires_at = ? WHERE grant_id = ?",
			expiry[mode],
			grantId,
		);
	for (const who of ["seed", "worker"] as const) await changeParticipant(f, mode, who);
}
async function changeParticipant(f: GrantFixture, mode: string, who: "seed" | "worker") {
	const deviceId = bootstrapParticipant(f, who);
	if (mode === `${who} missing`) await f.store.removeDevice(f.review.groupId, deviceId);
	if (mode === `${who} disabled`) await f.store.setDeviceEnabled(f.review.groupId, deviceId, false);
	if (!mode.startsWith(`${who} `) || !mode.endsWith("revoked")) return;
	let publicKey = who === "seed" ? CANONICAL_PUBLIC_KEY : UNRELATED_PUBLIC_KEY;
	let revokedId = deviceId;
	if (mode === `${who} ID revoked`) {
		publicKey = `opaque-id-${who}`;
		await f.exec(
			"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
			publicKey,
			f.review.groupId,
			deviceId,
		);
	} else {
		revokedId = `${deviceId}-alias`;
		await f.store.enrollDevice(f.review.groupId, {
			deviceId: revokedId,
			publicKey,
			fingerprint: f.review.fingerprint,
		});
	}
	expect(
		await f.store.createDeviceRevocation({
			groupId: f.review.groupId,
			deviceId: revokedId,
			publicKey,
			fingerprint: f.review.fingerprint,
		}),
	).toMatchObject({ kind: "revoked" });
}
export function registerBootstrapAuthorizationApi(test: Test) {
	registerSuccessfulLookup(test);
	registerDeniedLookup(test);
	registerSignedDenials(test);
	registerSeedAdmissionDenials(test);
	registerPrivateLookup(test);
	registerDriftLookup(test);
}
function registerSuccessfulLookup(test: Test) {
	test.for(["admin", "signed"] as const)(
		"%s lookup returns version and both authoritative enrollments",
		async (mode, { fixture: f }) => {
			// Arrange
			const grant = await authorizationFixture(f);
			const getter = vi.spyOn(f.store, "getBootstrapGrantAuthorization");
			const path =
				mode === "admin"
					? `/v1/admin/bootstrap-grants/${grant.grant_id}`
					: `/v1/bootstrap-grants/${grant.grant_id}?group_id=${f.review.groupId}`;
			const headers = mode === "admin" ? adminHeaders : signedHeaders(f, path);
			// Act
			const response = await appFor(f).request(path, { headers });
			// Assert
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				authorization_version: 1,
				grant,
				seed_enrollment: await f.store.getEnrollment(f.review.groupId, grant.seed_device_id),
				worker_enrollment: await f.store.getEnrollment(f.review.groupId, grant.worker_device_id),
			});
			const expectedSeed =
				mode === "signed"
					? {
							groupId: f.review.groupId,
							deviceId: grant.seed_device_id,
							publicKey: CANONICAL_PUBLIC_KEY,
							fingerprint: f.review.fingerprint,
						}
					: undefined;
			expect(getter).toHaveBeenCalledWith({
				grantId: grant.grant_id,
				nowMs: authorizationNowMs,
				...(expectedSeed ? { expectedSeed } : {}),
			});
		},
	);
}
function registerDeniedLookup(test: Test) {
	test.for(failures)(
		"admin denies %s with status %s",
		async ([mode, status, error], { fixture: f }) => {
			// Arrange: admin must check both participants without any signed nonce admission.
			const grant = await authorizationFixture(f);
			await change(f, grant.grant_id, mode);
			const raw = await f.store.getBootstrapGrant(grant.grant_id);
			const nonce = vi.spyOn(f.store, "recordAuthorizedNonce");
			// Act
			const response = await appFor(f).request(
				`/v1/admin/bootstrap-grants/${mode === "missing grant" ? "absent" : grant.grant_id}`,
				{ headers: adminHeaders },
			);
			// Assert
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({ error });
			expect(nonce).not.toHaveBeenCalled();
			expect(await f.store.getBootstrapGrant(grant.grant_id)).toEqual(raw);
			expect(await f.store.listBootstrapGrants(f.review.groupId)).toEqual([raw]);
			const history = await appFor(f).request(
				`/v1/admin/bootstrap-grants?group_id=${f.review.groupId}`,
				{ headers: adminHeaders },
			);
			expect(history.status).toBe(200);
			expect(await history.json()).toEqual({ items: [raw] });
		},
	);
}
function registerSignedDenials(test: Test) {
	test.for(
		failures.filter(([mode]) =>
			[
				"missing grant",
				"revoked",
				"expired",
				"calendar overflow",
				"timezone-less",
				"worker missing",
				"worker disabled",
				"worker ID revoked",
				"worker key revoked",
			].includes(mode),
		),
	)("signed denies %s with status %s", async ([mode, status, error], { fixture: f }) => {
		// Arrange: signed lookup still consults current worker and grant authority after admission.
		const grant = await authorizationFixture(f);
		await change(f, grant.grant_id, mode);
		const path = `/v1/bootstrap-grants/${mode === "missing grant" ? "absent" : grant.grant_id}?group_id=${f.review.groupId}`;
		// Act
		const response = await appFor(f).request(path, { headers: signedHeaders(f, path) });
		// Assert
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error });
	});
}
function registerSeedAdmissionDenials(test: Test) {
	test.for(["ID", "key"] as const)(
		"signed seed %s revocation denies before authorization lookup",
		async (mode, { fixture: f }) => {
			// Arrange: keep the real canonical signing key usable, even with an ID-only tombstone.
			const grant = await authorizationFixture(f);
			await changeParticipant(f, `seed ${mode} revoked`, "seed");
			if (mode === "ID")
				await f.exec(
					"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE group_id = ? AND device_id = ?",
					CANONICAL_PUBLIC_KEY,
					f.review.fingerprint,
					f.review.groupId,
					grant.seed_device_id,
				);
			const getter = vi.spyOn(f.store, "getBootstrapGrantAuthorization");
			const path = `/v1/bootstrap-grants/${grant.grant_id}?group_id=${f.review.groupId}`;
			const headers = signedHeaders(f, path);
			const enrollment = await f.store.getEnrollment(f.review.groupId, grant.seed_device_id);
			expect(enrollment?.public_key).toBe(CANONICAL_PUBLIC_KEY);
			expect(
				verifySignature({
					method: "GET",
					pathWithQuery: path,
					bodyBytes: Buffer.alloc(0),
					publicKey: enrollment?.public_key ?? "",
					deviceId: grant.seed_device_id,
					timestamp: headers["X-Opencode-Timestamp"],
					nonce: headers["X-Opencode-Nonce"],
					signature: headers["X-Opencode-Signature"],
				}),
			).toBe(true);
			// Act
			const response = await appFor(f).request(path, { headers });
			// Assert: valid signatures do not bypass global seed revocation or reveal grant authority.
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "device_revoked" });
			expect(getter).not.toHaveBeenCalled();
		},
	);
}
function registerPrivateLookup(test: Test) {
	test.for(["admin", "signed", "limited"] as const)(
		"%s rejection never reads grant authorization",
		async (mode, { fixture: f }) => {
			// Arrange: even a known grant cannot disclose participant revocation before authentication.
			const grant = await authorizationFixture(f);
			const getter = vi.spyOn(f.store, "getBootstrapGrantAuthorization");
			const path =
				mode === "admin"
					? `/v1/admin/bootstrap-grants/${grant.grant_id}`
					: `/v1/bootstrap-grants/${grant.grant_id}?group_id=${f.review.groupId}`;
			const headers: Record<string, string> = mode === "admin" ? {} : signedHeaders(f, path);
			if (mode === "signed")
				headers["X-Opencode-Signature"] = `v2:${Buffer.alloc(64).toString("base64")}`;
			// Act
			const response = await appFor(f, mode === "limited" ? 0 : 120).request(path, { headers });
			// Assert
			expect(response.status).toBe(mode === "limited" ? 429 : 401);
			expect(getter).not.toHaveBeenCalled();
		},
	);
}
function registerDriftLookup(test: Test) {
	test.for([
		"group",
		"seed",
		"key drift",
		"fingerprint drift",
		"revoked key drift",
		"revoked fingerprint drift",
	] as const)(
		"signed %s mismatch denies before revoked worker disclosure",
		async (mode, { fixture: f }) => {
			// Arrange: replace authority only after real signature and nonce admission succeed.
			const grant = await authorizationFixture(f);
			if (!mode.endsWith("drift") || mode.startsWith("revoked "))
				await change(f, grant.grant_id, "worker key revoked");
			const getter = f.store.getBootstrapGrantAuthorization.bind(f.store);
			vi.spyOn(f.store, "getBootstrapGrantAuthorization").mockImplementation(async (input) => {
				if (mode === "group")
					await f.exec(
						"UPDATE coordinator_bootstrap_grants SET group_id = ? WHERE grant_id = ?",
						"foreign",
						grant.grant_id,
					);
				if (mode === "seed")
					await f.exec(
						"UPDATE coordinator_bootstrap_grants SET seed_device_id = ? WHERE grant_id = ?",
						"foreign",
						grant.grant_id,
					);
				if (mode.endsWith("key drift"))
					await f.exec(
						"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
						UNRELATED_PUBLIC_KEY,
						f.review.groupId,
						grant.seed_device_id,
					);
				if (mode.endsWith("fingerprint drift"))
					await f.exec(
						"UPDATE enrolled_devices SET fingerprint = ? WHERE group_id = ? AND device_id = ?",
						"changed",
						f.review.groupId,
						grant.seed_device_id,
					);
				return getter(input);
			});
			const path = `/v1/bootstrap-grants/${grant.grant_id}?group_id=${f.review.groupId}`;
			// Act
			const response = await appFor(f).request(path, { headers: signedHeaders(f, path) });
			// Assert
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "grant_not_found" });
		},
	);
}
