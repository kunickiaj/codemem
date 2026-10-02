import { describe, expect, it } from "vitest";
import { challenge, ISSUER, oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";

describe("coordinator OIDC adapter", () => {
	it("uses discovered authorization metadata and fresh S256 transaction material", async () => {
		// Arrange: HTTPS endpoints exist only in the injected transport.
		const fixture = oidcFixture();
		const { client } = await fixture.begin();
		// Act: begin two independent transactions without network authorization calls.
		const first = await client.createAuthorizationRequest();
		const second = await client.createAuthorizationRequest();
		const url = new URL(first.authorizationUrl);
		// Assert: OAuth code flow only, with exact SDK-generated secrets.
		expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: PROVIDER.clientId,
			redirect_uri: PROVIDER.redirectUri,
			response_type: "code",
			response_mode: "query",
			scope: "openid email profile",
			access_type: "online",
			state: first.material.state,
			nonce: first.material.nonce,
			code_challenge_method: "S256",
			code_challenge: await challenge(first.material.pkceVerifier),
		});
		for (const key of ["state", "nonce", "pkceVerifier"] as const) {
			expect(first.material[key]).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
			expect(first.material[key]).not.toBe(second.material[key]);
		}
		expect(fixture.requests.map((request) => request.url)).toEqual([
			`${ISSUER}/.well-known/openid-configuration`,
		]);
		expect(Object.keys(client).sort()).toEqual(["createAuthorizationRequest", "verifyCallback"]);
	});

	it("verifies RS256 through JWKS and returns only an account and display profile", async () => {
		// Arrange: unexpected refresh tokens and arbitrary claims must remain private.
		const fixture = oidcFixture();
		fixture.claims.roles = ["administrator"];
		fixture.claims.hd = "example.test";
		const { client, input } = await fixture.begin();
		// Act: exchange and cryptographically validate the code.
		const result = await client.verifyCallback(input);
		// Assert: identity comes exclusively from issuer and subject.
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
		expect(fixture.requests.map((request) => request.url)).toEqual([
			`${ISSUER}/.well-known/openid-configuration`,
			`${ISSUER}/token`,
			`${ISSUER}/jwks`,
		]);
		expect(JSON.stringify(result)).not.toMatch(
			/fixture-secret|fixture-access-token|fixture-refresh-token|id_token|roles|administrator/,
		);
	});
});

describe("token proof and authorization response rejection", () => {
	it.each(["wrong-key", "modified", "none", "HS256"])(
		"rejects %s token signatures",
		async (mode) => {
			// Arrange: the provider supplies a token not signed under the required RS256 key.
			const fixture = oidcFixture();
			if (mode === "none" || mode === "HS256") fixture.settings.alg = mode;
			else fixture.settings.signature = mode;
			const { client, input } = await fixture.begin();
			// Act: the maintained SDK, not a mocked verifier, processes it.
			const result = await client.verifyCallback(input);
			// Assert: all failures redact provider details.
			expect(result).toEqual({ ok: false, error: "oidc_verification_failed" });
			if (mode === "wrong-key" || mode === "modified") {
				expect(fixture.requests.some((request) => request.url === `${ISSUER}/jwks`)).toBe(true);
			}
		},
	);

	it.each([
		["issuer", { iss: "https://other.example.test" }],
		["bare Google issuer", { iss: "accounts.google.com" }],
		["audience", { aud: "other-client" }],
		["nonce", { nonce: "other-nonce" }],
		["missing nonce", { nonce: undefined }],
		["expired", { exp: 1 }],
		["future not-before", { nbf: 4_000_000_000 }],
		["missing subject", { sub: undefined }],
		["object subject", { sub: { id: "fixture-subject" } }],
	] as const)("rejects invalid %s claims", async (_label, claims) => {
		// Arrange: replace one required signed claim.
		const fixture = oidcFixture();
		Object.assign(fixture.claims, claims);
		const { client, input } = await fixture.begin();
		// Act: verify the genuine signature and invalid claim set.
		const result = await client.verifyCallback(input);
		// Assert: signed but wrong claims cannot identify an account.
		expect(result).toEqual({ ok: false, error: "oidc_verification_failed" });
	});

	it("requires an ID token even when access and refresh tokens exist", async () => {
		// Arrange: OAuth-only token response is not identity proof.
		const fixture = oidcFixture();
		fixture.settings.omitIdToken = true;
		const { client, input } = await fixture.begin();
		// Act.
		const result = await client.verifyCallback(input);
		// Assert.
		expect(result).toEqual({ ok: false, error: "oidc_verification_failed" });
	});

	it.each(["wrong", "missing", "duplicate", "denied", "duplicate-code", "missing-code"])(
		"rejects %s callback state/error before token fetch",
		async (mode) => {
			// Arrange: alter the callback, not the trusted transaction material.
			const fixture = oidcFixture();
			const { client, input, callback } = await fixture.begin();
			if (mode === "wrong") callback.searchParams.set("state", "wrong");
			if (mode === "missing") callback.searchParams.delete("state");
			if (mode === "duplicate") callback.searchParams.append("state", input.material.state);
			if (mode === "duplicate-code") callback.searchParams.append("code", "second-code");
			if (mode === "missing-code") callback.searchParams.delete("code");
			if (mode === "denied") {
				callback.searchParams.delete("code");
				callback.searchParams.set("error", "access_denied");
			}
			// Act.
			const result = await client.verifyCallback({ ...input, callbackUrl: callback.href });
			// Assert: no code exchange for invalid authorization responses.
			expect(result).toEqual({ ok: false, error: "oidc_verification_failed" });
			expect(fixture.requests).toHaveLength(1);
		},
	);

	it.each(["pkceVerifier", "nonce"] as const)("rejects wrong trusted %s material", async (key) => {
		// Arrange: otherwise valid transaction, wrong proof material.
		const fixture = oidcFixture();
		const { client, input } = await fixture.begin();
		// Act.
		const result = await client.verifyCallback({
			...input,
			material: { ...input.material, [key]: "x".repeat(43) },
		});
		// Assert: provider PKCE enforcement or SDK nonce enforcement denies it.
		expect(result).toEqual({ ok: false, error: "oidc_verification_failed" });
	});

	it("rejects provider-consumed code replay without claiming browser transaction protection", async () => {
		// Arrange: code consumption belongs to this fake provider, not an adapter map.
		const fixture = oidcFixture();
		const { client, input } = await fixture.begin();
		// Act: redeem the same code twice.
		const first = await client.verifyCallback(input);
		const second = await client.verifyCallback(input);
		// Assert.
		expect(first.ok).toBe(true);
		expect(second).toEqual({ ok: false, error: "oidc_verification_failed" });
	});
});
