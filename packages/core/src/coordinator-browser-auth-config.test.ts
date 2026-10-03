import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { captureCoordinatorBrowserAuthConfig } from "./coordinator-browser-auth-config.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";

const ISSUER = "https://accounts.google.com";
const SECRET = "synthetic-client-secret";
const REDIRECT = "https://browser.example.test/auth/callback";
const REVISION = "a".repeat(64);
function input(overrides: Record<string, unknown> = {}) {
	return {
		enabled: true,
		coordinatorId: "opaque-coordinator",
		issuer: ISSUER,
		clientId: "synthetic-client-id",
		clientSecret: SECRET,
		redirectUri: REDIRECT,
		revision: REVISION,
		...overrides,
	};
}
const fields = [
	"coordinatorId",
	"issuer",
	"clientId",
	"clientSecret",
	"redirectUri",
	"revision",
] as const;
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});
describe("captureCoordinatorBrowserAuthConfig: pure configuration boundary", () => {
	it.each(["plain", "null prototype"])("captures a valid %s object", (shape) => {
		// Arrange: only seven explicit server configuration fields are supported.
		const value = input();
		if (shape === "null prototype") Object.setPrototypeOf(value, null);
		// Act
		const result = captureCoordinatorBrowserAuthConfig(value);
		// Assert: the internal SDK snapshot intentionally retains its secret.
		expect(result).toEqual({
			kind: "enabled",
			publicOrigin: "https://browser.example.test",
			store: {
				enabled: true,
				coordinatorId: value.coordinatorId,
				issuer: ISSUER,
				revision: REVISION,
				redirectUri: REDIRECT,
			},
			oidc: {
				issuer: ISSUER,
				clientId: value.clientId,
				clientSecret: SECRET,
				redirectUri: REDIRECT,
			},
		});
	});
	it.each([undefined, { enabled: false }])(
		"disables omitted or false configuration: %j",
		(value) => {
			// Arrange / Act
			const result = captureCoordinatorBrowserAuthConfig(value);
			// Assert
			expect(result).toEqual({ kind: "disabled" });
		},
	);
	it.each([null, [], "true", 1, true, new Date(0), Object.create({ enabled: true })])(
		"rejects a non-plain configuration: %j",
		(value) => {
			// Arrange / Act
			const result = captureCoordinatorBrowserAuthConfig(value);
			// Assert
			expect(result).toEqual({ kind: "invalid", field: "config" });
		},
	);
	it("rejects a class instance even with all valid own fields", () => {
		// Arrange
		class Configuration {
			constructor() {
				Object.assign(this, input());
			}
		}
		// Act
		const result = captureCoordinatorBrowserAuthConfig(new Configuration());
		// Assert
		expect(result).toEqual({ kind: "invalid", field: "config" });
	});
	it.each([{}, { enabled: undefined }, { enabled: "true" }, { enabled: 1 }, { enabled: null }])(
		"requires an own boolean enabled value: %j",
		(value) => {
			// Arrange / Act
			const result = captureCoordinatorBrowserAuthConfig(value);
			// Assert
			expect(result).toEqual({ kind: "invalid", field: "enabled" });
		},
	);
	it("does not inspect disabled SDK/profile fields or enumerate keys", () => {
		// Arrange: unknown and symbol keys are irrelevant while disabled.
		const getter = vi.fn(() => {
			throw new Error(SECRET);
		});
		const target = { enabled: false, [Symbol("profile")]: SECRET };
		Object.defineProperty(target, "clientSecret", { get: getter });
		Object.defineProperty(target, "profile", { get: getter });
		const ownKeys = vi.fn(() => {
			throw new Error(SECRET);
		});
		const get = vi.fn(() => {
			throw new Error(SECRET);
		});
		const value = new Proxy(target, { ownKeys, get });
		// Act
		const result = captureCoordinatorBrowserAuthConfig(value);
		// Assert
		expect(result).toEqual({ kind: "disabled" });
		expect(getter).not.toHaveBeenCalled();
		expect(ownKeys).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});
});

describe("configuration descriptor safety and redacted failures", () => {
	it.each(["enabled", ...fields])("rejects an accessor for %s without invoking it", (field) => {
		// Arrange
		const value = input();
		const getter = vi.fn(() => {
			throw new Error(SECRET);
		});
		Object.defineProperty(value, field, { get: getter });
		// Act
		const result = captureCoordinatorBrowserAuthConfig(value);
		// Assert
		expect(result).toEqual({ kind: "invalid", field });
		expect(getter).not.toHaveBeenCalled();
	});
	it.each(fields)("rejects missing own data for %s", (field) => {
		// Arrange
		const value: Record<string, unknown> = input();
		delete value[field];
		// Act
		const result = captureCoordinatorBrowserAuthConfig(value);
		// Assert
		expect(result).toEqual({ kind: "invalid", field });
	});
	it.each(["unrecognized-private-token", Symbol("synthetic-private-path")])(
		"rejects unknown keys before field errors without disclosing the key: %s",
		(key) => {
			// Arrange
			const getter = vi.fn(() => SECRET);
			const value = input({ clientId: null });
			Object.defineProperty(value, key, { get: getter });
			// Act
			const result = captureCoordinatorBrowserAuthConfig(value);
			// Assert
			expect(result).toEqual({ kind: "invalid", field: "unknown_field" });
			expect(getter).not.toHaveBeenCalled();
		},
	);
	it.each(["getPrototypeOf", "getOwnPropertyDescriptor", "ownKeys"] as const)(
		"catches and redacts a throwing %s proxy trap",
		(trap) => {
			// Arrange
			const error = new Error(`${SECRET} ${REDIRECT} synthetic-private-token`);
			const value = new Proxy(input(), {
				[trap]: () => {
					throw error;
				},
			});
			const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
			// Act: reflection may execute traps, but no exception or cause escapes.
			const result = captureCoordinatorBrowserAuthConfig(value);
			// Assert
			expect(result).toEqual({ kind: "invalid", field: "config" });
			expect(log).not.toHaveBeenCalled();
		},
	);
	it.each(fields)("does not coerce an object supplied for %s", (field) => {
		// Arrange
		const coerce = vi.fn(() => {
			throw new Error(SECRET);
		});
		const value = input({ [field]: { toString: coerce, [Symbol.toPrimitive]: coerce } });
		// Act
		const result = captureCoordinatorBrowserAuthConfig(value);
		// Assert
		expect(result).toEqual({ kind: "invalid", field });
		expect(coerce).not.toHaveBeenCalled();
	});
});

describe("configuration field validation and immutable snapshots", () => {
	it("preserves ordinary Unicode credentials and a lowercase mixed-hex revision", () => {
		// Arrange
		const value = input({
			clientId: "Élève",
			clientSecret: "秘密",
			revision: "0123456789abcdef".repeat(4),
		});
		// Act
		const result = captureCoordinatorBrowserAuthConfig(value);
		// Assert
		expect(result.kind).toBe("enabled");
		if (result.kind !== "enabled") throw new Error("expected enabled capture");
		expect(result.oidc.clientSecret).toBe("秘密");
		expect(result.store.revision).toBe(value.revision);
	});
	it.each([
		["clientId", 1],
		["clientId", 256],
		["clientSecret", 1],
		["clientSecret", 4096],
	] as const)("accepts %s at length %i", (field, length) => {
		// Arrange
		const value = input({ [field]: "x".repeat(length) });
		// Act
		const result = captureCoordinatorBrowserAuthConfig(value);
		// Assert
		expect(result.kind).toBe("enabled");
	});
	it.each([
		["clientId", "x".repeat(257)],
		["clientSecret", "x".repeat(4097)],
		...(["clientId", "clientSecret"] as const).flatMap((field) =>
			["", " ", " leading", "trailing ", "x\u0000y", "x\u200By", "x\uD800y"].map(
				(value) => [field, value] as const,
			),
		),
		["revision", "a".repeat(63)],
		["revision", "a".repeat(65)],
		["revision", "g".repeat(64)],
		["revision", "A".repeat(64)],
		["issuer", "accounts.google.com"],
		["issuer", `${ISSUER}/`],
		["issuer", "https://issuer.example.test"],
		["issuer", "https://ACCOUNTS.GOOGLE.COM"],
		["coordinatorId", ""],
		["coordinatorId", " leading"],
		["coordinatorId", "x\u200By"],
	] as const)("rejects malformed %s: %j", (field, value) => {
		// Arrange
		const config = input({ [field]: value });
		// Act
		const result = captureCoordinatorBrowserAuthConfig(config);
		// Assert: only the fixed field name survives, never values or lengths.
		expect(JSON.stringify(result)).toBe(JSON.stringify({ kind: "invalid", field }));
	});
	it.each([
		"http://browser.example.test/auth/callback",
		`${REDIRECT}?`,
		`${REDIRECT}?token=private`,
		`${REDIRECT}#`,
		`${REDIRECT}#private`,
		"https://user:pass@browser.example.test/auth/callback",
		"https://BROWSER.EXAMPLE.TEST/auth/callback",
		"https://browser.example.test",
		"https://browser.example.test\\auth/callback",
		`${REDIRECT}\n`,
		`${REDIRECT}\u200B`,
		`${REDIRECT}\uD800`,
		"not-a-url",
		` ${REDIRECT}`,
		"https://browser.example.test:443/auth/callback",
	])("rejects a noncanonical or unsafe redirect: %j", (redirectUri) => {
		// Arrange
		const value = input({ redirectUri });
		// Act
		const result = captureCoordinatorBrowserAuthConfig(value);
		// Assert
		expect(result).toEqual({ kind: "invalid", field: "redirectUri" });
	});
	it.each(["https://browser.example.test/", "https://browser.example.test:8443/auth/%0A"])(
		"derives public origin only from the accepted redirect: %s",
		(redirectUri) => {
			// Arrange: coordinator IDs are opaque, not a source of URL authority.
			const value = input({ coordinatorId: "https://unrelated.example.test/", redirectUri });
			// Act
			const result = captureCoordinatorBrowserAuthConfig(value);
			// Assert: escaped pathname controls follow the existing redirect policy.
			expect(result.kind).toBe("enabled");
			if (result.kind !== "enabled") throw new Error("expected enabled capture");
			expect(result.publicOrigin).toBe(new URL(redirectUri).origin);
			expect(result.store.redirectUri).toBe(redirectUri);
		},
	);
	it("captures immutable snapshots and passes through an explicit revision", () => {
		// Arrange
		const value = input({ revision: "b".repeat(64) });
		// Act
		const result = captureCoordinatorBrowserAuthConfig(value);
		value.clientSecret = "replaced-secret";
		value.redirectUri = "https://replaced.example.test/";
		value.revision = "c".repeat(64);
		// Assert: later mutations cannot change either captured downstream config.
		expect(result.kind).toBe("enabled");
		if (result.kind !== "enabled") throw new Error("expected enabled capture");
		expect([result, result.store, result.oidc].every(Object.isFrozen)).toBe(true);
		expect(result.oidc.clientSecret).toBe(SECRET);
		expect(result.store.redirectUri).toBe(REDIRECT);
		expect(result.store.revision).toBe("b".repeat(64));
		expect(Reflect.set(result.store, "revision", "d".repeat(64))).toBe(false);
		expect(Reflect.set(result.oidc, "clientSecret", "changed")).toBe(false);
	});
});
describe("existing coordinator app without browser auth options", () => {
	it.each(["GET", "POST"])("leaves all browser auth paths unknown for %s", async (method) => {
		// Arrange: no stores, providers, or databases should be opened for unknown routes.
		const storeFactory = vi.fn<() => CoordinatorStore>(() => {
			throw new Error("store forbidden");
		});
		const requestVerifier = vi.fn(() => false);
		const app = createCoordinatorApp({
			storeFactory,
			requestVerifier,
			runtime: { adminSecret: () => null, now: () => "2026-09-01T00:00:00Z" },
		});
		const paths = [
			"/auth/sign-in",
			"/auth/callback",
			"/auth/link/confirm",
			"/auth/link/cancel",
			"/auth/logout",
		];
		// Act: compare the old router's real fallback, not a newly invented response.
		const unknown = await app.request("/synthetic-unregistered-route", { method });
		const expected = {
			status: unknown.status,
			body: await unknown.text(),
			type: unknown.headers.get("content-type"),
		};
		const responses = await Promise.all(
			paths.map(async (path) => {
				const response = await app.request(path, { method });
				return {
					status: response.status,
					body: await response.text(),
					type: response.headers.get("content-type"),
				};
			}),
		);
		// Assert: no browser handlers or SDK transport were introduced by capture alone.
		expect(expected.status).toBe(404);
		expect(responses).toEqual(paths.map(() => expected));
		expect(storeFactory).not.toHaveBeenCalled();
		expect(requestVerifier).not.toHaveBeenCalled();
	});
});
