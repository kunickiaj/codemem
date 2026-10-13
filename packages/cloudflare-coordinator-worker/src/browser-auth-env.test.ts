import { describe, expect, it } from "vitest";
import {
	type CloudflareBrowserAuthEnv,
	captureCloudflareBrowserAuthEnv,
} from "./browser-auth-env.js";

// Dummy bindings only: capture is local and never contacts an identity provider.
const PUBLIC_CONFIG = {
	enabled: true,
	coordinatorId: "fixture-coordinator",
	issuer: "https://accounts.google.com",
	clientId: "fixture-client-id",
	redirectUri: "https://coordinator.example.test/auth/callback",
	revision: "a".repeat(64),
};
const CLIENT_SECRET = "dummy-client-secret";
const CSRF_KEY = "0123456789abcdef".repeat(4);

function enabledEnv(config: Record<string, unknown> = PUBLIC_CONFIG): CloudflareBrowserAuthEnv {
	return {
		CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: JSON.stringify(config),
		CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET: CLIENT_SECRET,
		CODEMEM_COORDINATOR_BROWSER_CSRF_KEY: CSRF_KEY,
	};
}

describe("captureCloudflareBrowserAuthEnv", () => {
	it.each([undefined, JSON.stringify({ enabled: false })])(
		"disables browser auth without credentials for config %s",
		(raw) => {
			// Arrange: absent or explicitly disabled auth needs no secret bindings.
			const env = { CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: raw };
			// Act
			const result = captureCloudflareBrowserAuthEnv(env);
			// Assert
			expect(result).toEqual({ kind: "disabled" });
		},
	);

	it("captures public config with separate secret bindings and defaults owner enrollment off", () => {
		// Arrange
		const env = enabledEnv();
		// Act
		const result = captureCloudflareBrowserAuthEnv(env);
		// Assert: the owner opt-in is not forwarded as an OIDC config field.
		expect(result).toEqual({
			kind: "enabled",
			config: { ...PUBLIC_CONFIG, clientSecret: CLIENT_SECRET },
			csrfKeyBytes: Uint8Array.from(
				Array.from({ length: 4 }, () => [1, 35, 69, 103, 137, 171, 205, 239]).flat(),
			),
			ownerEnrollmentEnabled: false,
		});
	});

	it.each([false, true])("preserves explicit owner enrollment %s", (ownerEnrollmentEnabled) => {
		// Arrange
		const env = enabledEnv({ ...PUBLIC_CONFIG, ownerEnrollmentEnabled });
		// Act
		const result = captureCloudflareBrowserAuthEnv(env);
		// Assert
		expect(result).toMatchObject({
			kind: "enabled",
			ownerEnrollmentEnabled,
			config: { ...PUBLIC_CONFIG, clientSecret: CLIENT_SECRET },
		});
		if (result.kind === "enabled")
			expect(result.config).not.toHaveProperty("ownerEnrollmentEnabled");
	});
});

describe("captureCloudflareBrowserAuthEnv invalid bindings", () => {
	it.each(["", "{", "null", "[]", "true", "1", '"config"', " ".repeat(8193)])(
		"rejects malformed, non-object, or oversized config %#",
		(raw) => {
			// Arrange
			const env = { ...enabledEnv(), CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: raw };
			// Act
			const result = captureCloudflareBrowserAuthEnv(env);
			// Assert: no input details or secret bindings escape in invalid settings.
			expect(result).toEqual({ kind: "invalid" });
		},
	);

	it.each<[string, unknown]>([
		["enabled", undefined],
		["enabled", "true"],
		["enabled", 1],
		["ownerEnrollmentEnabled", "true"],
		["ownerEnrollmentEnabled", 1],
		["ownerEnrollmentEnabled", null],
		["coordinatorId", undefined],
		["coordinatorId", 1],
		["coordinatorId", ""],
		["issuer", 1],
		["issuer", "https://accounts.example.test"],
		["issuer", "http://accounts.google.com"],
		["issuer", "https://accounts.google.com/"],
		["clientId", undefined],
		["clientId", 1],
		["clientId", ""],
		["clientId", " fixture-client-id"],
		["redirectUri", 1],
		["redirectUri", "not-a-url"],
		["redirectUri", "http://coordinator.example.test/auth/callback"],
		["redirectUri", "https://user:password@coordinator.example.test/auth/callback"],
		["redirectUri", "https://coordinator.example.test/auth/callback?next=other"],
		["redirectUri", "https://coordinator.example.test/auth/callback#fragment"],
		["revision", undefined],
		["revision", 1],
		["revision", "a".repeat(63)],
		["revision", "a".repeat(65)],
		["revision", "A".repeat(64)],
		["revision", "g".repeat(64)],
		["unknownField", true],
		["clientSecret", CLIENT_SECRET],
		["csrfKey", CSRF_KEY],
		["CODEMEM_COORDINATOR_BROWSER_CSRF_KEY", CSRF_KEY],
	])("rejects invalid or forbidden config field %s (%#)", (field, value) => {
		// Arrange: secrets must remain separate bindings, never JSON fields.
		const env = enabledEnv({ ...PUBLIC_CONFIG, [field]: value });
		// Act
		const result = captureCloudflareBrowserAuthEnv(env);
		// Assert
		expect(result).toEqual({ kind: "invalid" });
	});

	it.each([undefined, "", " dummy-client-secret", "dummy\nsecret"])(
		"rejects absent or invalid separate client secret %#",
		(clientSecret) => {
			// Arrange
			const env = { ...enabledEnv(), CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET: clientSecret };
			// Act
			const result = captureCloudflareBrowserAuthEnv(env);
			// Assert
			expect(result).toEqual({ kind: "invalid" });
		},
	);

	it.each([
		undefined,
		"",
		"a".repeat(63),
		"a".repeat(65),
		"A".repeat(64),
		"g".repeat(64),
		` ${CSRF_KEY}`,
	])("rejects absent or non-64-lowercase-hex CSRF key %#", (csrfKey) => {
		// Arrange
		const env = { ...enabledEnv(), CODEMEM_COORDINATOR_BROWSER_CSRF_KEY: csrfKey };
		// Act
		const result = captureCloudflareBrowserAuthEnv(env);
		// Assert
		expect(result).toEqual({ kind: "invalid" });
	});

	it.each<[keyof CloudflareBrowserAuthEnv, unknown]>([
		["CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG", true],
		["CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG", {}],
		["CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET", 123],
		["CODEMEM_COORDINATOR_BROWSER_CSRF_KEY", 123],
	])("rejects a non-string binding %s (%#)", (binding, value) => {
		// Arrange: runtime bindings can violate the declared TypeScript types.
		const env = { ...enabledEnv(), [binding]: value } as CloudflareBrowserAuthEnv;
		// Act
		const result = captureCloudflareBrowserAuthEnv(env);
		// Assert
		expect(result).toEqual({ kind: "invalid" });
	});

	it("owns independent key bytes across captures and binding changes", () => {
		// Arrange
		const env = enabledEnv();
		const first = captureCloudflareBrowserAuthEnv(env);
		const second = captureCloudflareBrowserAuthEnv(env);
		if (first.kind !== "enabled" || second.kind !== "enabled") {
			throw new Error("Dummy valid bindings must enable browser auth");
		}
		// Act: mutate one capture and replace the input binding.
		first.csrfKeyBytes.fill(0);
		env.CODEMEM_COORDINATOR_BROWSER_CSRF_KEY = "f".repeat(64);
		const third = captureCloudflareBrowserAuthEnv(env);
		// Assert: neither earlier mutation nor later binding replacement aliases another capture.
		expect(second.csrfKeyBytes).toEqual(
			Uint8Array.from(Array.from({ length: 4 }, () => [1, 35, 69, 103, 137, 171, 205, 239]).flat()),
		);
		expect(third).toMatchObject({ kind: "enabled", csrfKeyBytes: new Uint8Array(32).fill(255) });
	});
});
