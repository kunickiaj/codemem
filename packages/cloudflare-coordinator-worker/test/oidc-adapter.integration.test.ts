import { describe, expect, it } from "vitest";
import { createCoordinatorOidcClient } from "../../core/src/coordinator-oidc.js";
import {
	challenge,
	ISSUER,
	oidcFixture,
	PROVIDER,
} from "../../core/src/coordinator-oidc-test-fixtures.js";

// Runs in workerd: only the fixture transport is mocked, never SDK token verification.
describe("OIDC adapter in the Worker runtime", () => {
	it("verifies RS256 using JWKS, projects only display fields, and denies provider code replay", async () => {
		// Arrange: extra claims and token response secrets must not escape the adapter.
		const fixture = oidcFixture();
		fixture.claims.roles = ["administrator"];
		fixture.claims.groups = ["fixture-group"];
		const { input } = await fixture.begin();
		const created = await createCoordinatorOidcClient(PROVIDER, { fetch: fixture.fetch });
		if (!created.ok) throw new Error(created.error);
		// Act: the fake provider consumes this code once, independently of browser storage.
		const result = await created.client.verifyCallback(input);
		const replay = await created.client.verifyCallback(input);
		// Assert: genuine signature verification requests JWKS and returns a minimal DTO.
		expect(result).toEqual({
			ok: true,
			account: { issuer: ISSUER, subject: "fixture-subject" },
			profile: {
				displayName: "Fixture User",
				email: "user@example.test",
				emailVerified: true,
				pictureUrl: "https://images.example.test/avatar.png",
			},
		});
		expect(fixture.requests.map(({ url }) => url)).toEqual([
			`${ISSUER}/.well-known/openid-configuration`,
			`${ISSUER}/.well-known/openid-configuration`,
			`${ISSUER}/token`,
			`${ISSUER}/jwks`,
			`${ISSUER}/token`,
		]);
		expect(replay).toEqual({ ok: false, error: "oidc_verification_failed" });
		expect(JSON.stringify([result, replay])).not.toMatch(
			/fixture-secret|fixture-access-token|fixture-refresh-token|id_token|clientSecret|roles|groups/,
		);
	});

	it("denies invalid JWS and claims under the required RS256 policy", async () => {
		// Arrange: each case owns a fresh transaction and SDK discovery configuration.
		const cases = [
			"valid",
			"wrong-key",
			"modified",
			"HS256",
			"none",
			"expired",
			"audience",
			"nonce",
		];
		for (const mode of cases) {
			const fixture = oidcFixture();
			if (mode === "wrong-key" || mode === "modified") fixture.settings.signature = mode;
			if (mode === "HS256" || mode === "none") fixture.settings.alg = mode;
			if (mode === "expired") fixture.claims.exp = 1;
			if (mode === "audience") fixture.claims.aud = "other-client";
			if (mode === "nonce") fixture.claims.nonce = "other-nonce";
			const { client, input } = await fixture.begin();
			// Act: no verification primitive or SDK method is mocked.
			const result = await client.verifyCallback(input);
			// Assert: signed success and every failure remain deterministic and redacted.
			if (mode === "valid") expect(result.ok, mode).toBe(true);
			else expect(result, mode).toEqual({ ok: false, error: "oidc_verification_failed" });
			if (mode === "wrong-key" || mode === "modified") {
				expect(
					fixture.requests.some(({ url }) => url === `${ISSUER}/jwks`),
					mode,
				).toBe(true);
			}
			expect(JSON.stringify(result), mode).not.toMatch(
				/fixture-secret|fixture-access-token|fixture-refresh-token|id_token/,
			);
		}
	});

	it("binds S256 and state to HTTPS callbacks and rejects invalid replies before exchange", async () => {
		// Arrange: HTTPS URLs describe the protocol; the injected transport never uses the network.
		const fixture = oidcFixture();
		const { client, input, request } = await fixture.begin();
		const authorization = new URL(request.authorizationUrl);
		const next = await client.createAuthorizationRequest();
		const mutations = ["origin", "path", "state", "error"];
		// Act: alter callback location or authorization response without changing trusted material.
		const results = [];
		for (const mutation of mutations) {
			const callback = new URL(input.callbackUrl);
			if (mutation === "origin") callback.hostname = "other.example.test";
			if (mutation === "path") callback.pathname = "/other";
			if (mutation === "state") callback.searchParams.set("state", "wrong-state");
			if (mutation === "error") {
				callback.searchParams.delete("code");
				callback.searchParams.set("error", "access_denied");
				callback.searchParams.set("error_description", "fixture-secret");
			}
			results.push(await client.verifyCallback({ ...input, callbackUrl: callback.href }));
		}
		// Assert: invalid authorization replies cannot send credentials to a token endpoint.
		expect(results).toEqual([
			{ ok: false, error: "invalid_callback" },
			{ ok: false, error: "invalid_callback" },
			{ ok: false, error: "oidc_verification_failed" },
			{ ok: false, error: "oidc_verification_failed" },
		]);
		expect(fixture.requests.map(({ url }) => url)).toEqual([
			`${ISSUER}/.well-known/openid-configuration`,
		]);
		expect(authorization.origin + authorization.pathname).toBe(`${ISSUER}/authorize`);
		expect(Object.fromEntries(authorization.searchParams)).toEqual({
			client_id: PROVIDER.clientId,
			redirect_uri: PROVIDER.redirectUri,
			response_type: "code",
			response_mode: "query",
			scope: "openid email profile",
			access_type: "online",
			state: input.material.state,
			nonce: input.material.nonce,
			code_challenge_method: "S256",
			code_challenge: await challenge(input.material.pkceVerifier),
		});
		for (const key of ["state", "nonce", "pkceVerifier"] as const) {
			expect(input.material[key]).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
			expect(input.material[key]).not.toBe(next.material[key]);
		}

		// Arrange: a separate code proves the fixture provider enforces PKCE.
		const wrongProof = await fixture.begin();
		// Act: first use the untouched callback, then redeem a different code with a wrong verifier.
		const accepted = await client.verifyCallback(input);
		const rejected = await wrongProof.client.verifyCallback({
			...wrongProof.input,
			material: { ...wrongProof.input.material, pkceVerifier: "x".repeat(43) },
		});
		// Assert: valid binding succeeds; the provider denies the incorrect S256 proof.
		expect(accepted.ok).toBe(true);
		expect(rejected).toEqual({ ok: false, error: "oidc_verification_failed" });
	});

	it("merges known UserInfo fields only when its subject matches the verified ID token", async () => {
		// Arrange: each UserInfo response has its own unconsumed code and signed ID token.
		for (const sub of ["fixture-subject", "other-subject"]) {
			const fixture = oidcFixture();
			Object.assign(fixture.userInfo, { sub, roles: ["administrator"], iss: "untrusted" });
			const { client, input } = await fixture.begin();
			// Act: opt in before the code is consumed; the SDK validates expectedSub.
			const result = await client.verifyCallback(input, { fetchUserInfo: true });
			// Assert: display data never overrides identity or grants permissions.
			if (sub === "fixture-subject") {
				expect(result).toEqual({
					ok: true,
					account: { issuer: ISSUER, subject: "fixture-subject" },
					profile: {
						displayName: "User Info",
						email: "user@example.test",
						emailVerified: true,
						pictureUrl: "https://images.example.test/avatar.png",
					},
				});
			} else expect(result).toEqual({ ok: false, error: "oidc_verification_failed" });
			expect(fixture.requests.at(-1)?.url).toBe(`${ISSUER}/userinfo`);
			expect(JSON.stringify(result)).not.toMatch(
				/fixture-secret|fixture-access-token|fixture-refresh-token|id_token|roles|administrator|untrusted/,
			);
		}
	});
});
