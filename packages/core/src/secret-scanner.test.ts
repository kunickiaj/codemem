import { describe, expect, it } from "vitest";
import {
	DEFAULT_RULES,
	mergeDetections,
	type SecretRule,
	SecretScanner,
} from "./secret-scanner.js";

describe("SecretScanner", () => {
	const scanner = new SecretScanner();

	describe("scan — well-known secret patterns", () => {
		it("redacts AWS access key IDs", () => {
			const r = scanner.scan("aws creds: AKIAIOSFODNN7EXAMPLE in config");
			expect(r.redacted).toBe("aws creds: [REDACTED:aws_access_key_id] in config");
			expect(r.detections).toEqual([{ kind: "aws_access_key_id", count: 1 }]);
		});

		it("redacts AWS secret access keys with sufficient entropy", () => {
			const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
			const r = scanner.scan(`secret = ${secret}`);
			expect(r.redacted).not.toContain(secret);
			// Either aws_secret_access_key or generic_assigned_secret will catch it; both are wins.
			expect(r.detections.length).toBeGreaterThan(0);
		});

		it("redacts JWTs", () => {
			const jwt =
				"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
			const r = scanner.scan(`auth header: Bearer ${jwt}`);
			expect(r.redacted).toContain("[REDACTED:jwt]");
			expect(r.redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
			expect(r.detections.find((d) => d.kind === "jwt")?.count).toBe(1);
		});

		it("redacts classic GitHub PATs", () => {
			const pat = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const r = scanner.scan(`token=${pat}`);
			expect(r.redacted).toContain("[REDACTED:github_pat_classic]");
			expect(r.redacted).not.toContain(pat);
		});

		it("redacts fine-grained GitHub PATs", () => {
			const pat = `github_pat_${"a".repeat(82)}`;
			const r = scanner.scan(`use ${pat} for the api`);
			expect(r.redacted).toContain("[REDACTED:github_pat_finegrained]");
			expect(r.redacted).not.toContain(pat);
		});

		it("redacts other GitHub token variants", () => {
			const tokens = [
				"gho_abcdefghijklmnopqrstuvwxyz0123456789",
				"ghu_abcdefghijklmnopqrstuvwxyz0123456789",
				"ghs_abcdefghijklmnopqrstuvwxyz0123456789",
				"ghr_abcdefghijklmnopqrstuvwxyz0123456789",
			];
			for (const t of tokens) {
				const r = scanner.scan(`x ${t} y`);
				expect(r.redacted).not.toContain(t);
			}
		});

		it("redacts PEM private key blocks", () => {
			const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----`;
			const r = scanner.scan(`key file content:\n${pem}\nend`);
			expect(r.redacted).toContain("[REDACTED:pem_private_key]");
			expect(r.redacted).not.toContain("BEGIN RSA PRIVATE KEY");
		});

		it("redacts Slack tokens", () => {
			const t = "xoxb-1234567890-abcdefghij";
			const r = scanner.scan(`slack: ${t}`);
			expect(r.redacted).toContain("[REDACTED:slack_token]");
		});

		it("redacts Google API keys", () => {
			// 39 chars total: AIza + 35
			const k = "AIzaSyA-BCDEFGHIJKLMNOPQRSTUVWXY0123456";
			expect(k.length).toBe(39);
			const r = scanner.scan(`gkey=${k}`);
			expect(r.redacted).toContain("[REDACTED:google_api_key]");
		});

		it("redacts Stripe live and test keys", () => {
			// Repetition-only suffixes so GitHub push-protection does not flag
			// these as live Stripe keys; pattern still matches the rule.
			const live = `sk_live_${"X".repeat(24)}`;
			const test = `sk_test_${"X".repeat(24)}`;
			expect(scanner.scan(live).redacted).toContain("[REDACTED:");
			expect(scanner.scan(test).redacted).toContain("[REDACTED:");
		});
	});

	describe("scan — generic high-entropy with assignment context", () => {
		it("redacts the value after a secret-context prefix", () => {
			const r = scanner.scan('API_KEY="aB3xZ9pQ7rT2vW8yE4nM6kL0sJ5hF1dG"');
			expect(r.redacted).not.toContain("aB3xZ9pQ7rT2vW8yE4nM6kL0sJ5hF1dG");
			expect(r.redacted).toMatch(/\[REDACTED:/);
			expect(r.redacted).toContain("API_KEY=");
		});

		it("does not redact ordinary prose without secret context", () => {
			const text = "The quick brown fox jumps over the lazy dog forty two times.";
			const r = scanner.scan(text);
			expect(r.redacted).toBe(text);
			expect(r.detections).toEqual([]);
		});

		it("does not redact common low-entropy identifiers like UUIDs", () => {
			const text = "session id 550e8400-e29b-41d4-a716-446655440000 is fine";
			const r = scanner.scan(text);
			expect(r.redacted).toBe(text);
		});

		it("does not redact git commit SHAs", () => {
			const text = "fixed in commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
			const r = scanner.scan(text);
			expect(r.redacted).toBe(text);
		});
	});

	describe("redactValue — recursive object walk", () => {
		it("redacts strings inside nested objects and arrays", () => {
			const input = {
				body: "key=ghp_abcdefghijklmnopqrstuvwxyz0123456789 inline",
				nested: {
					token: "supersecretvalue1234",
					note: "harmless",
				},
				arr: ["plain", "AKIAIOSFODNN7EXAMPLE"],
			};
			const r = scanner.redactValue(input);
			const out = r.value as typeof input;
			expect(out.body).toContain("[REDACTED:github_pat_classic]");
			expect(out.nested.token).toBe("[REDACTED:context_secret]");
			expect(out.nested.note).toBe("harmless");
			expect(out.arr[0]).toBe("plain");
			expect(out.arr[1]).toBe("[REDACTED:aws_access_key_id]");
			expect(r.detections.find((d) => d.kind === "github_pat_classic")?.count).toBe(1);
			expect(r.detections.find((d) => d.kind === "context_secret")?.count).toBe(1);
			expect(r.detections.find((d) => d.kind === "aws_access_key_id")?.count).toBe(1);
		});

		it("treats secret-bearing key names as context for whole-value redaction", () => {
			const input = { password: "hunter2-but-longer", other: "fine" };
			const r = scanner.redactValue(input);
			expect((r.value as typeof input).password).toBe("[REDACTED:context_secret]");
			expect((r.value as typeof input).other).toBe("fine");
		});

		it("preserves URL values even under secret-bearing key names", () => {
			const input = { auth: "https://example.com/auth/callback" };
			const r = scanner.redactValue(input);
			expect((r.value as typeof input).auth).toBe("https://example.com/auth/callback");
		});

		it("preserves non-string values unchanged", () => {
			const input = { count: 42, flag: true, nope: null };
			const r = scanner.redactValue(input);
			expect(r.value).toEqual(input);
			expect(r.detections).toEqual([]);
		});
	});

	describe("allowlist", () => {
		it("bypasses redaction for explicit literal matches", () => {
			const fixture = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			const s = new SecretScanner({ allowlist: [fixture] });
			const r = s.scan(`token=${fixture}`);
			expect(r.redacted).toContain(fixture);
		});

		it("bypasses redaction for allowlist regexes", () => {
			const s = new SecretScanner({ allowlist: [/^AKIAFAKEFIXTURE/] });
			const r = s.scan("creds: AKIAFAKEFIXTURE0001 in test");
			expect(r.redacted).toContain("AKIAFAKEFIXTURE0001");
		});

		it("is stable across repeat calls when allowlist regex has g flag", () => {
			const fixture = "AKIAFAKEFIXTURE0001";
			const s = new SecretScanner({ allowlist: [/^AKIAFAKEFIXTURE\d{4}$/g] });
			for (let i = 0; i < 4; i++) {
				expect(s.scan(`creds: ${fixture} in test`).redacted).toContain(fixture);
			}
		});
	});

	describe("custom rules", () => {
		it("merges additional rules with defaults", () => {
			const extra: SecretRule = { kind: "internal_token", pattern: /\bACME-[A-Z0-9]{10}\b/g };
			const s = new SecretScanner({ rules: [extra] });
			const r = s.scan("internal: ACME-AB12CD34EF and aws AKIAIOSFODNN7EXAMPLE");
			expect(r.redacted).toContain("[REDACTED:internal_token]");
			expect(r.redacted).toContain("[REDACTED:aws_access_key_id]");
		});
	});

	describe("rule precedence", () => {
		it("classifies Anthropic keys as anthropic_api_key, not openai_api_key", () => {
			const key = `sk-ant-api03-${"A".repeat(85)}aB1`;
			const r = scanner.scan(`auth: ${key}`);
			expect(r.redacted).toContain("[REDACTED:anthropic_api_key]");
			expect(r.redacted).not.toContain("[REDACTED:openai_api_key]");
		});

		it("classifies OpenAI proj keys as openai_api_key", () => {
			const key = "sk-proj-aB3xZ9pQ7rT2vW8yE4nM6kL0sJ5hF1dGcXvBnMxY8zRpQwErTy2";
			const r = scanner.scan(`OPENAI_API_KEY=${key}`);
			expect(r.redacted).toContain("[REDACTED:openai_api_key]");
		});

		it("does not flag low-entropy sk- prefixed identifiers as openai keys", () => {
			// Internal SKU-like string with sk- prefix and 32+ chars but flat entropy
			const r = scanner.scan("sku ref sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa fine");
			expect(r.redacted).not.toContain("[REDACTED:openai_api_key]");
		});
	});

	describe("non-plain objects and cycles in redactValue", () => {
		it("returns Date instances unchanged instead of serializing to {}", () => {
			const d = new Date("2026-01-01T00:00:00Z");
			const r = scanner.redactValue({ when: d });
			expect((r.value as { when: Date }).when).toBe(d);
		});

		it("returns Map / Set / RegExp / Buffer unchanged", () => {
			const map = new Map([["k", "v"]]);
			const set = new Set([1, 2, 3]);
			const re = /foo/i;
			const buf = Buffer.from("hello");
			const r = scanner.redactValue({ map, set, re, buf });
			const out = r.value as {
				map: Map<string, string>;
				set: Set<number>;
				re: RegExp;
				buf: Buffer;
			};
			expect(out.map).toBe(map);
			expect(out.set).toBe(set);
			expect(out.re).toBe(re);
			expect(out.buf).toBe(buf);
		});

		it("survives a self-referential object without stack-overflowing", () => {
			const obj: Record<string, unknown> = { name: "x" };
			obj.self = obj;
			expect(() => scanner.redactValue(obj)).not.toThrow();
			const r = scanner.redactValue(obj);
			expect(r.value).toBeDefined();
		});

		it("survives a cyclic array reference", () => {
			const arr: unknown[] = ["a"];
			arr.push(arr);
			expect(() => scanner.redactValue(arr)).not.toThrow();
		});
	});

	describe("edge cases", () => {
		it("returns the original text when no rules match", () => {
			const r = scanner.scan("nothing to see here");
			expect(r.redacted).toBe("nothing to see here");
			expect(r.detections).toEqual([]);
		});

		it("handles empty and non-string inputs gracefully", () => {
			expect(scanner.scan("").redacted).toBe("");
			// @ts-expect-error — guarding runtime use
			expect(scanner.scan(null).redacted).toBe(null);
		});

		it("counts multiple detections of the same kind", () => {
			const r = scanner.scan(
				"ghp_abcdefghijklmnopqrstuvwxyz0123456789 and ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
			);
			expect(r.detections.find((d) => d.kind === "github_pat_classic")?.count).toBe(2);
		});

		it("never includes the original matched value in detection records", () => {
			const r = scanner.scan("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
			for (const d of r.detections) {
				expect(d).toEqual({ kind: d.kind, count: d.count });
				expect(JSON.stringify(d)).not.toContain("ghp_");
			}
		});
	});
});

describe("mergeDetections", () => {
	it("sums counts per kind across multiple lists", () => {
		const merged = mergeDetections(
			[
				{ kind: "jwt", count: 1 },
				{ kind: "github_pat_classic", count: 2 },
			],
			[{ kind: "jwt", count: 3 }],
			[],
		);
		expect(merged.find((d) => d.kind === "jwt")?.count).toBe(4);
		expect(merged.find((d) => d.kind === "github_pat_classic")?.count).toBe(2);
	});
});

describe("DEFAULT_RULES", () => {
	it("exposes a non-empty rule set", () => {
		expect(DEFAULT_RULES.length).toBeGreaterThan(5);
	});

	it("every default rule is a global regex", () => {
		for (const rule of DEFAULT_RULES) {
			expect(rule.pattern.flags).toContain("g");
		}
	});
});
