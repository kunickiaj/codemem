import { env, exports } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it, vi } from "vitest";
import { captureCoordinatorBrowserAuthConfig } from "../../core/src/coordinator-browser-auth-config.js";

const NOW = 1790899200000;
const issuer = "https://accounts.google.com";
function fixture() {
	// Shape fixtures only: no discovery, JWS or provider verification is claimed.
	return {
		enabled: true,
		coordinatorId: "opaque-coordinator-namespace",
		issuer,
		clientId: "fixture-client-id",
		clientSecret: "fixture-client-secret",
		redirectUri: "https://login.example.test/auth/callback",
		revision: "a".repeat(64),
	};
}

it("captures frozen settings whose store config starts a real D1 transaction", async () => {
	// Arrange: store config is metadata, not a storage instance or public DTO.
	const input = fixture();
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	const material = {
		purpose: "signin" as const,
		stateHash: "1".repeat(64),
		binderHash: "2".repeat(64),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		// Act
		const captured = captureCoordinatorBrowserAuthConfig(input);
		if (captured.kind !== "enabled") throw new Error("Expected enabled fixture");
		const started = await store.startAuthBrowserTransaction(material, captured.store);
		const disabled = await store.startAuthBrowserTransaction(material, {
			...captured.store,
			enabled: false,
		});
		input.clientSecret = "changed-fixture-secret";
		input.revision = "b".repeat(64);
		// Assert: all captured objects resist mutation and retain their original data.
		expect(captured.publicOrigin).toBe("https://login.example.test");
		expect(captured.store).toEqual({
			enabled: true,
			coordinatorId: input.coordinatorId,
			issuer,
			redirectUri: input.redirectUri,
			revision: "a".repeat(64),
		});
		expect(captured.oidc).toEqual({
			issuer,
			clientId: input.clientId,
			clientSecret: "fixture-client-secret",
			redirectUri: input.redirectUri,
		});
		for (const object of [captured, captured.store, captured.oidc]) {
			expect(Object.isFrozen(object)).toBe(true);
			expect(Reflect.set(object, "issuer", "https://other.example.test")).toBe(false);
		}
		expect(started).toEqual({ kind: "started", expiresAtMs: NOW + 600000 });
		expect(disabled).toEqual({ kind: "rejected", error: "auth_config_changed" });
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("short-circuits disabled settings and redacts invalid inputs without invoking getters", () => {
	// Arrange: hostile reflection must fail closed, including errors containing secrets.
	const input = fixture();
	const getter = vi.fn(() => {
		throw new Error(input.clientSecret);
	});
	const ownKeys = vi.fn(() => {
		throw new Error(input.clientSecret);
	});
	const disabled = new Proxy(Object.defineProperty({ enabled: false }, "issuer", { get: getter }), {
		ownKeys,
		getOwnPropertyDescriptor(target, key) {
			if (key !== "enabled") throw new Error(input.clientSecret);
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	});
	const invalidCases = [
		[{ ...input, issuer: `${issuer}/` }, "issuer"],
		[{ ...input, redirectUri: "https://LOGIN.example.test/auth/callback" }, "redirectUri"],
		[{ ...input, revision: "A".repeat(64) }, "revision"],
		[{ ...input, unknown: input.clientSecret }, "unknown_field"],
		[Object.defineProperty({}, "enabled", { get: getter }), "enabled"],
		[new Proxy(input, { ownKeys }), "config"],
	] as const;
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		// Act
		const defaults = [undefined, disabled].map(captureCoordinatorBrowserAuthConfig);
		const results = invalidCases.map(([value]) => captureCoordinatorBrowserAuthConfig(value));
		// Assert: invalid output contains only fixed field names, not supplied secrets.
		expect(defaults).toEqual([{ kind: "disabled" }, { kind: "disabled" }]);
		expect(results).toEqual(invalidCases.map(([, field]) => ({ kind: "invalid", field })));
		expect(JSON.stringify(results)).not.toContain(input.clientSecret);
		expect(getter).not.toHaveBeenCalled();
		expect(ownKeys).toHaveBeenCalledTimes(1);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("keeps browser sign-in unmounted in the actual default Worker for GET and POST", async () => {
	// Arrange: use the Worker entrypoint and its test D1 binding, not a fake router.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		// Act
		const responses = await Promise.all(
			["GET", "POST"].map(async (method) => {
				const baseline = await exports.default.fetch("https://example.test/unknown-path", {
					method,
				});
				const signin = await exports.default.fetch("https://example.test/auth/sign-in", { method });
				return {
					baseline,
					signin,
					baselineBody: await baseline.text(),
					signinBody: await signin.text(),
				};
			}),
		);
		// Assert: neither method gains a login form, redirect, cookie or provider request.
		for (const { baseline, signin, baselineBody, signinBody } of responses) {
			expect(baseline.status).toBe(404);
			expect(signin.status).toBe(baseline.status);
			expect(signinBody).toBe(baselineBody);
			expect(signin.headers.get("content-type")).toBe(baseline.headers.get("content-type"));
			expect(signin.headers.get("location")).toBeNull();
			expect(signin.headers.get("set-cookie")).toBeNull();
			expect(signinBody).not.toMatch(/<form|fixture-client-secret/);
		}
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});
