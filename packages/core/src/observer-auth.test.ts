import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ObserverAuthAdapter,
	readAuthFile,
	redactText,
	renderObserverHeaders,
	resolveOAuthProvider,
} from "./observer-auth.js";

describe("ObserverAuthAdapter", () => {
	describe("resolve", () => {
		it("returns explicit token first", () => {
			const adapter = new ObserverAuthAdapter();
			const result = adapter.resolve({ explicitToken: "tok-explicit" });
			expect(result.token).toBe("tok-explicit");
			expect(result.source).toBe("explicit");
			expect(result.authType).toBe("bearer");
		});

		it("falls back to env tokens", () => {
			const adapter = new ObserverAuthAdapter();
			const result = adapter.resolve({ envTokens: ["", "tok-env"] });
			expect(result.token).toBe("tok-env");
			expect(result.source).toBe("env");
		});

		it("falls back to oauth token", () => {
			const adapter = new ObserverAuthAdapter();
			const result = adapter.resolve({ oauthToken: "tok-oauth" });
			expect(result.token).toBe("tok-oauth");
			expect(result.source).toBe("oauth");
		});

		it("returns no token with source=none", () => {
			const adapter = new ObserverAuthAdapter({ source: "none" });
			const result = adapter.resolve({ explicitToken: "ignored" });
			expect(result.token).toBeNull();
			expect(result.authType).toBe("none");
			expect(result.source).toBe("none");
		});

		it("caches command/file results", () => {
			let tmpDir: string;
			let tokenFile: string;
			tmpDir = mkdtempSync(join(tmpdir(), "codemem-auth-test-"));
			tokenFile = join(tmpDir, "token.txt");
			writeFileSync(tokenFile, "tok-cached\n");

			try {
				const adapter = new ObserverAuthAdapter({
					source: "file",
					filePath: tokenFile,
					cacheTtlS: 300,
				});

				const first = adapter.resolve();
				expect(first.token).toBe("tok-cached");

				// Delete the file — cached result should still be returned
				rmSync(tokenFile);
				const second = adapter.resolve();
				expect(second.token).toBe("tok-cached");

				// Force refresh should fail since file is gone
				const third = adapter.resolve({ forceRefresh: true });
				expect(third.token).toBeNull();
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});
});

describe("redactText", () => {
	it("masks sk- API keys", () => {
		expect(redactText("key is sk-abcdefghijklmnop")).toBe("key is [redacted]");
	});

	it("masks Bearer tokens", () => {
		expect(redactText("Bearer eyJhbGciOiJIUzI1NiJ9.test")).toBe("[redacted]");
	});

	it("truncates long text", () => {
		const long = "a".repeat(500);
		const result = redactText(long, 100);
		expect(result.length).toBeLessThanOrEqual(102); // 100 + "…"
	});
});

describe("readAuthFile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-auth-file-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads token from temp file", () => {
		const tokenFile = join(tmpDir, "token.txt");
		writeFileSync(tokenFile, "  my-secret-token  \n");
		expect(readAuthFile(tokenFile)).toBe("my-secret-token");
	});

	it("returns null for nonexistent file", () => {
		expect(readAuthFile(join(tmpDir, "nope.txt"))).toBeNull();
	});

	it("returns null for null path", () => {
		expect(readAuthFile(null)).toBeNull();
	});
});

describe("resolveOAuthProvider", () => {
	it("detects anthropic from claude model", () => {
		expect(resolveOAuthProvider(null, "claude-3-opus")).toBe("anthropic");
	});

	it("detects openai from non-claude model", () => {
		expect(resolveOAuthProvider(null, "gpt-4")).toBe("openai");
	});

	it("respects explicit configured provider", () => {
		expect(resolveOAuthProvider("anthropic", "gpt-4")).toBe("anthropic");
	});
});

describe("renderObserverHeaders", () => {
	it("substitutes auth template variables", () => {
		const headers = {
			Authorization: "Bearer ${auth.token}",
			"X-Auth-Type": "${auth.type}",
		};
		const result = renderObserverHeaders(headers, {
			token: "tok-123",
			authType: "bearer",
			source: "env",
		});
		expect(result.Authorization).toBe("Bearer tok-123");
		expect(result["X-Auth-Type"]).toBe("bearer");
	});

	it("drops headers referencing auth.token when no token", () => {
		const headers = {
			Authorization: "Bearer ${auth.token}",
			"X-Static": "always",
		};
		const result = renderObserverHeaders(headers, {
			token: null,
			authType: "none",
			source: "none",
		});
		expect(result.Authorization).toBeUndefined();
		expect(result["X-Static"]).toBe("always");
	});
});
