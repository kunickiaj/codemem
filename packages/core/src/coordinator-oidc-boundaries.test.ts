import type { CustomFetch } from "openid-client";
import { describe, expect, it, vi } from "vitest";
import { createCoordinatorOidcClient } from "./coordinator-oidc.js";

function hostileRecord<T extends object>(
	value: T,
	key: string,
	mode: string,
	trap: () => never,
): T {
	if (mode === "getter") {
		Object.defineProperty(value, key, { get: trap });
		return value;
	}
	if (mode === "inherited") {
		Object.setPrototypeOf(value, { [key]: "inherited" });
		return value;
	}
	return new Proxy(value, { getOwnPropertyDescriptor: trap });
}

import { ISSUER, oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";

describe("callback URL boundary", () => {
	it.each([
		"https://evil.example.test/auth/callback",
		"https://app.example.test/auth/callback/suffix",
		"https://app.example.test/other",
		"http://app.example.test/auth/callback",
		"//app.example.test/auth/callback",
		"https://user:pass@app.example.test/auth/callback",
		"https://app.example.test/auth/callback#fragment",
		"https://app.example.test/auth/%2fcallback",
		"https://app.example.test/auth/callback/%2e%2e/other",
		" https://app.example.test/auth/callback",
		"https://app.example.test/auth\\callback",
		"https://app.example.test/auth/callback\u200b",
	])("rejects spoofed callback URL %s before exchange", async (callbackUrl) => {
		// Arrange: transport records all outbound requests.
		const fixture = oidcFixture();
		const { client, input } = await fixture.begin();
		// Act.
		const result = await client.verifyCallback({ ...input, callbackUrl });
		// Assert.
		expect(result).toEqual({ ok: false, error: "invalid_callback" });
		expect(fixture.requests).toHaveLength(1);
	});

	it("accepts URL-normalized host case and ordinary callback query parameters", async () => {
		// Arrange: trusted redirect origin comparison uses URL normalization.
		const fixture = oidcFixture();
		const { client, input } = await fixture.begin();
		const callbackUrl = `${input.callbackUrl.replace("app.example.test", "APP.EXAMPLE.TEST")}&extra=display`;
		// Act.
		const result = await client.verifyCallback({ ...input, callbackUrl });
		// Assert.
		expect(result.ok).toBe(true);
	});
});

describe("provider configuration and transport boundaries", () => {
	it.each([
		["issuer", "http://issuer.example.test"],
		["issuer", "accounts.google.com"],
		["issuer", `${ISSUER}?query=yes`],
		["issuer", `${ISSUER}#fragment`],
		["issuer", ` ${ISSUER}`],
		["issuer", `${ISSUER}\u0000`],
		["issuer", `${ISSUER}\u200b`],
		["issuer", `${ISSUER}\ud800`],
		["issuer", "https://user:password@issuer.example.test"],
		["issuer", "https://issuer.example.test\\other"],
		["redirectUri", "http://app.example.test/auth/callback"],
		["redirectUri", `${PROVIDER.redirectUri}?query=yes`],
		["redirectUri", `${PROVIDER.redirectUri}#fragment`],
		["redirectUri", "https://user:password@app.example.test/auth/callback"],
		["redirectUri", ` ${PROVIDER.redirectUri}`],
		["redirectUri", "https://APP.EXAMPLE.TEST/auth/callback"],
		["redirectUri", "https://app.example.test:443/auth/callback"],
		["redirectUri", "https://app.example.test"],
		["redirectUri", "https://app.example.test/auth/../auth/callback"],
		["clientId", " "],
		["clientId", "x".repeat(257)],
		["clientId", "client\n"],
		["clientSecret", " "],
		["clientSecret", "x".repeat(4097)],
		["clientSecret", "secret\u200b"],
	] as const)("rejects invalid %s without network access (%s)", async (key, value) => {
		// Arrange: any attempted transport use would throw.
		const transport: CustomFetch = async () => {
			throw new Error("Unexpected network request");
		};
		const fetch = vi.fn(transport);
		// Act.
		const result = await createCoordinatorOidcClient({ ...PROVIDER, [key]: value }, { fetch });
		// Assert: never echo the credential or malformed URL.
		expect(result).toEqual({ ok: false, error: "invalid_provider_configuration" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([0, 31, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid timeout %s before discovery",
		async (timeoutSeconds) => {
			// Arrange.
			const fixture = oidcFixture();
			// Act.
			const result = await createCoordinatorOidcClient(PROVIDER, {
				fetch: fixture.fetch,
				timeoutSeconds,
			});
			// Assert.
			expect(result).toEqual({ ok: false, error: "invalid_provider_configuration" });
			expect(fixture.fetch).not.toHaveBeenCalled();
		},
	);

	it.each([1, 10, 30])("accepts supported timeout %s", async (timeoutSeconds) => {
		// Arrange.
		const fixture = oidcFixture();
		// Act.
		const result = await createCoordinatorOidcClient(PROVIDER, {
			fetch: fixture.fetch,
			timeoutSeconds,
		});
		// Assert.
		expect(result.ok).toBe(true);
		expect(fixture.requests[0]?.options.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([
		["issuer", "https://other.example.test"],
		["issuer", `${ISSUER}/`],
		["authorization_endpoint", undefined],
		["token_endpoint", undefined],
		["jwks_uri", undefined],
		["authorization_endpoint", "http://issuer.example.test/authorize"],
		["token_endpoint", "https://user:pass@issuer.example.test/token"],
		["jwks_uri", `${ISSUER}/jwks#fragment`],
		["userinfo_endpoint", "http://issuer.example.test/userinfo"],
		["userinfo_endpoint", "https://user:pass@issuer.example.test/userinfo"],
	] as const)("rejects unsafe discovered %s", async (key, value) => {
		// Arrange: metadata is supplied through real SDK discovery.
		const fixture = oidcFixture();
		fixture.metadata[key] = value;
		// Act.
		const result = await createCoordinatorOidcClient(PROVIDER, { fetch: fixture.fetch });
		// Assert.
		expect(result).toEqual({ ok: false, error: "oidc_discovery_failed" });
	});

	it("accepts discovery without optional userinfo and snapshots provider credentials", async () => {
		// Arrange: mutation after factory creation cannot alter token authentication.
		const fixture = oidcFixture();
		delete fixture.metadata.userinfo_endpoint;
		const config = { ...PROVIDER };
		const created = await createCoordinatorOidcClient(config, { fetch: fixture.fetch });
		const transaction = await fixture.begin();
		if (!created.ok) throw new Error(created.error);
		config.clientSecret = "changed-after-capture";
		config.clientId = "changed-client";
		// Act: use the original independently generated transaction against identical metadata.
		const result = await created.client.verifyCallback(transaction.input);
		// Assert.
		expect(result.ok).toBe(true);
	});

	it("redacts discovery backend failures without logging", async () => {
		// Arrange: backend errors deliberately contain fixture credentials.
		const fixture = oidcFixture();
		fixture.settings.failure = `${ISSUER}/.well-known/openid-configuration`;
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		// Act.
		try {
			const result = await createCoordinatorOidcClient(PROVIDER, { fetch: fixture.fetch });
			// Assert.
			expect(result).toEqual({ ok: false, error: "oidc_discovery_failed" });
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	it.each(["token", "jwks", "userinfo"])("redacts %s network failures", async (endpoint) => {
		// Arrange.
		const fixture = oidcFixture();
		fixture.settings.failure = `${ISSUER}/${endpoint}`;
		const { client, input } = await fixture.begin();
		// Act.
		const result = await client.verifyCallback(input, { fetchUserInfo: endpoint === "userinfo" });
		// Assert: the DTO has no raw token, secret, cause, or backend exception.
		expect(result).toEqual({ ok: false, error: "oidc_verification_failed" });
		expect(JSON.stringify(result)).not.toMatch(/fixture-secret|fixture-access-token|cause|backend/);
	});
});

describe("profile projection and userinfo", () => {
	it("merges only known userinfo fields after matching the verified subject", async () => {
		// Arrange: userinfo cannot override the account issuer or subject.
		const fixture = oidcFixture();
		Object.assign(fixture.userInfo, {
			email: "other@example.test",
			email_verified: false,
			iss: "evil",
			roles: ["admin"],
		});
		const { client, input } = await fixture.begin();
		// Act.
		const result = await client.verifyCallback(input, { fetchUserInfo: true });
		// Assert.
		expect(result).toEqual({
			ok: true,
			account: { issuer: ISSUER, subject: "fixture-subject" },
			profile: {
				displayName: "User Info",
				email: "other@example.test",
				emailVerified: false,
				pictureUrl: "https://images.example.test/avatar.png",
			},
		});
		expect(fixture.requests.at(-1)?.url).toBe(`${ISSUER}/userinfo`);
	});
});

describe("email verification provenance", () => {
	it.each([
		["other@example.test", undefined],
		["user@example.test", undefined],
		["other@example.test", "true"],
		["user@example.test", "true"],
	])("does not inherit verification for userinfo email %s with flag %s", async (email, flag) => {
		// Arrange: fresh email enrichment has no own boolean verification claim.
		const fixture = oidcFixture();
		Object.assign(fixture.userInfo, { email, email_verified: flag });
		const { client, input } = await fixture.begin();
		// Act.
		const result = await client.verifyCallback(input, { fetchUserInfo: true });
		// Assert: even an unchanged email cannot inherit the ID token's verification.
		expect(result).toEqual({
			ok: true,
			account: { issuer: ISSUER, subject: "fixture-subject" },
			profile: {
				displayName: "User Info",
				email,
				pictureUrl: "https://images.example.test/avatar.png",
			},
		});
	});

	it.each([true, false])("ignores userinfo verification %s without an email", async (flag) => {
		// Arrange: a flag alone cannot change the verified ID token email pair.
		const fixture = oidcFixture();
		fixture.userInfo.email_verified = flag;
		const { client, input } = await fixture.begin();
		// Act.
		const result = await client.verifyCallback(input, { fetchUserInfo: true });
		// Assert.
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
	});

	it.each([undefined, "", ["user@example.test"], "bad\u200bemail"])(
		"omits ID token verification without a valid email %#",
		async (email) => {
			// Arrange: the signed boolean flag cannot survive a rejected email claim.
			const fixture = oidcFixture();
			Object.assign(fixture.claims, { email, email_verified: true });
			const { client, input } = await fixture.begin();
			// Act.
			const result = await client.verifyCallback(input);
			// Assert: no orphan emailVerified field appears in the projected profile.
			expect(result).toEqual({
				ok: true,
				account: { issuer: ISSUER, subject: "fixture-subject" },
				profile: {
					displayName: "Fixture User",
					pictureUrl: "https://images.example.test/avatar.png",
				},
			});
		},
	);

	it.each(["malformed", "inherited"])(
		"preserves the ID token email pair for %s userinfo email fields",
		async (mode) => {
			// Arrange: JSON transport excludes inherited fields; malformed own fields are untrusted.
			const fixture = oidcFixture();
			if (mode === "malformed") fixture.userInfo.email = ["other@example.test"];
			else {
				Object.setPrototypeOf(fixture.userInfo, {
					email: "other@example.test",
					email_verified: false,
				});
			}
			const { client, input } = await fixture.begin();
			// Act.
			const result = await client.verifyCallback(input, { fetchUserInfo: true });
			// Assert: neither malformed nor inherited enrichment overwrites the original pair.
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
		},
	);
});

describe("profile projection boundaries", () => {
	it.each(["different-subject", undefined, { id: "fixture-subject" }])(
		"rejects userinfo subject mismatch %s",
		async (sub) => {
			// Arrange: a valid ID token does not authenticate unrelated userinfo.
			const fixture = oidcFixture();
			fixture.userInfo.sub = sub;
			const { client, input } = await fixture.begin();
			// Act.
			const result = await client.verifyCallback(input, { fetchUserInfo: true });
			// Assert.
			expect(result).toEqual({ ok: false, error: "oidc_verification_failed" });
		},
	);

	it("accepts absent display claims with an empty profile", async () => {
		// Arrange: identity proof does not require optional display metadata.
		const fixture = oidcFixture();
		Object.assign(fixture.claims, {
			name: undefined,
			email: undefined,
			email_verified: undefined,
			picture: undefined,
		});
		const { client, input } = await fixture.begin();
		// Act.
		const result = await client.verifyCallback(input);
		// Assert.
		expect(result).toEqual({
			ok: true,
			account: { issuer: ISSUER, subject: "fixture-subject" },
			profile: {},
		});
	});

	it.each([
		{
			name: { html: "<script>" },
			email: ["user@example.test"],
			email_verified: "true",
			picture: 42,
		},
		{
			name: "bad\u0000name",
			email: "bad\u200bemail",
			email_verified: 1,
			picture: "http://images.example.test/a",
		},
		{
			name: "n".repeat(257),
			email: "e".repeat(321),
			email_verified: null,
			picture: `https://images.example.test/${"a".repeat(2048)}`,
		},
		{ name: "", email: "", email_verified: {}, picture: "https://user:pass@images.example.test/a" },
		{
			name: null,
			email: null,
			email_verified: [],
			picture: "https://images.example.test/a#fragment",
		},
	])("ignores unsafe or nonprimitive display fields %#", async (claims) => {
		// Arrange: signed claims remain untrusted display metadata.
		const fixture = oidcFixture();
		Object.assign(fixture.claims, claims);
		const { client, input } = await fixture.begin();
		// Act.
		const result = await client.verifyCallback(input);
		// Assert: malformed display metadata does not replace account identity.
		expect(result).toEqual({
			ok: true,
			account: { issuer: ISSUER, subject: "fixture-subject" },
			profile: {},
		});
	});

	it("keeps HTML-looking names as inert metadata and accepts safe picture queries", async () => {
		// Arrange: UI escaping is a separate responsibility; no image is fetched here.
		const fixture = oidcFixture();
		fixture.claims.name = "<b>Fixture User</b>";
		fixture.claims.picture = "https://images.example.test/avatar?size=small";
		const { client, input } = await fixture.begin();
		// Act.
		const result = await client.verifyCallback(input, { fetchUserInfo: false });
		// Assert.
		expect(result).toMatchObject({
			ok: true,
			profile: { displayName: "<b>Fixture User</b>", pictureUrl: fixture.claims.picture },
		});
		expect(fixture.requests).toHaveLength(3);
	});
});

describe("own data descriptor capture", () => {
	it.each(["getter", "inherited", "proxy"])(
		"rejects %s provider fields without executing user code",
		async (mode) => {
			// Arrange: use typed objects with hostile descriptors, not coercion or casts.
			const fixture = oidcFixture();
			const trap = vi.fn(() => {
				throw new Error("Getter must never run");
			});
			let config = { ...PROVIDER };
			if (mode === "getter") Object.defineProperty(config, "issuer", { get: trap });
			if (mode === "inherited") Object.setPrototypeOf(config, PROVIDER);
			if (mode === "proxy") config = new Proxy(config, { getOwnPropertyDescriptor: trap });
			// Act.
			const result = await createCoordinatorOidcClient(config, { fetch: fixture.fetch });
			// Assert: accessor is never read; a proxy descriptor trap is safely caught.
			expect(result).toEqual({ ok: false, error: "invalid_provider_configuration" });
			expect(trap).toHaveBeenCalledTimes(mode === "proxy" ? 1 : 0);
			expect(fixture.fetch).not.toHaveBeenCalled();
		},
	);

	it("rejects accessor transport options before discovery", async () => {
		// Arrange.
		const fixture = oidcFixture();
		const options = { fetch: fixture.fetch, timeoutSeconds: 10 };
		const trap = vi.fn(() => {
			throw new Error("Getter must never run");
		});
		Object.defineProperty(options, "timeoutSeconds", { get: trap });
		// Act.
		const result = await createCoordinatorOidcClient(PROVIDER, options);
		// Assert.
		expect(result).toEqual({ ok: false, error: "invalid_provider_configuration" });
		expect(trap).not.toHaveBeenCalled();
		expect(fixture.fetch).not.toHaveBeenCalled();
	});

	it.each([
		["input", "getter"],
		["material", "getter"],
		["options", "getter"],
		["input", "inherited"],
		["material", "inherited"],
		["options", "inherited"],
		["input", "proxy"],
		["material", "proxy"],
		["options", "proxy"],
	] as const)(
		"rejects %s %s without invoking getters or exchanging a token",
		async (target, mode) => {
			// Arrange.
			const fixture = oidcFixture();
			const transaction = await fixture.begin();
			const { client } = transaction;
			let input = transaction.input;
			let options = { fetchUserInfo: false };
			const trap = vi.fn(() => {
				throw new Error("Getter must never run");
			});
			if (target === "input") input = hostileRecord(input, "callbackUrl", mode, trap);
			if (target === "material")
				input.material = hostileRecord(input.material, "nonce", mode, trap);
			if (target === "options") options = hostileRecord(options, "fetchUserInfo", mode, trap);
			// Act.
			const result = await client.verifyCallback(input, options);
			// Assert.
			expect(result).toEqual({ ok: false, error: "invalid_callback" });
			expect(trap).toHaveBeenCalledTimes(mode === "proxy" ? 1 : 0);
			expect(fixture.requests).toHaveLength(1);
		},
	);

	it.each(["state", "nonce", "pkceVerifier"] as const)(
		"rejects malformed %s before token exchange",
		async (key) => {
			// Arrange.
			const fixture = oidcFixture();
			const { client, input } = await fixture.begin();
			input.material[key] = "invalid short value!";
			// Act.
			const result = await client.verifyCallback(input);
			// Assert.
			expect(result).toEqual({ ok: false, error: "invalid_callback" });
			expect(fixture.requests).toHaveLength(1);
		},
	);
});
