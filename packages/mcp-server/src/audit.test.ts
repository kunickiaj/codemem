import { describe, expect, it, vi } from "vitest";
import {
	buildOAuthAuditEvent,
	createDefaultOAuthAuditEmitter,
	createSilentOAuthAuditEmitter,
	resolveOAuthAuditEmitterFromEnv,
	wrapAuditEmitterBestEffort,
} from "./audit.js";

type WriteCapture = {
	write: (chunk: string) => boolean;
};

function captureWrites(): { stream: WriteCapture; chunks: string[] } {
	const chunks: string[] = [];
	const stream: WriteCapture = {
		write(chunk: string) {
			chunks.push(chunk);
			return true;
		},
	};
	return { stream, chunks };
}

describe("OAuth audit events", () => {
	it("builds events with ISO timestamps and metadata", () => {
		const event = buildOAuthAuditEvent("bearer", {
			outcome: "denied",
			reason: "expired_token",
			clientId: "client-123",
			remoteAddress: "203.0.113.10",
			now: 1_700_000_000_000,
		});

		expect(event).toEqual({
			kind: "bearer",
			outcome: "denied",
			reason: "expired_token",
			clientId: "client-123",
			remoteAddress: "203.0.113.10",
			timestamp: new Date(1_700_000_000_000).toISOString(),
		});
	});

	it("refuses to attach secret-bearing fields in any casing or separator style", () => {
		const forbidden = [
			"access_token",
			"refresh_token",
			"id_token",
			"code",
			"code_verifier",
			"code_challenge",
			"client_secret",
			"authorization",
			"password",
			"secret",
			"token",
			// camelCase forms that bypassed the snake_case-only denylist before
			// Codex P2 feedback on PR #1136.
			"accessToken",
			"refreshToken",
			"idToken",
			"codeVerifier",
			"codeChallenge",
			"clientSecret",
			// UPPER_SNAKE_CASE and kebab-case round out the canonicalization
			// coverage so future callers cannot smuggle secrets by reshaping.
			"ACCESS_TOKEN",
			"client-secret",
		];
		for (const key of forbidden) {
			expect(() =>
				buildOAuthAuditEvent("token", {
					outcome: "success",
					[key]: "leak",
				} as Parameters<typeof buildOAuthAuditEvent>[1]),
			).toThrow(/forbidden field/i);
		}
	});

	it("default emitter writes one JSON line per event to the supplied stream", () => {
		const { stream, chunks } = captureWrites();
		const emit = createDefaultOAuthAuditEmitter(
			stream as unknown as Parameters<typeof createDefaultOAuthAuditEmitter>[0],
		);

		emit(
			buildOAuthAuditEvent("registration", {
				outcome: "success",
				clientId: "client-abc",
				now: 1_700_000_000_000,
			}),
		);
		emit(
			buildOAuthAuditEvent("bearer", {
				outcome: "denied",
				reason: "missing_authorization_header",
				now: 1_700_000_001_000,
			}),
		);

		expect(chunks).toHaveLength(2);
		const first = chunks[0] ?? "";
		const second = chunks[1] ?? "";
		expect(first.endsWith("\n")).toBe(true);
		expect(JSON.parse(first.trimEnd())).toEqual({
			source: "codemem-mcp-oauth-audit",
			kind: "registration",
			outcome: "success",
			clientId: "client-abc",
			timestamp: new Date(1_700_000_000_000).toISOString(),
		});
		expect(JSON.parse(second.trimEnd())).toMatchObject({
			kind: "bearer",
			outcome: "denied",
			reason: "missing_authorization_header",
		});
	});

	it("silent emitter writes nothing", () => {
		const emit = createSilentOAuthAuditEmitter();
		expect(() =>
			emit(buildOAuthAuditEvent("revocation", { outcome: "success", now: 0 })),
		).not.toThrow();
	});

	it("env resolver returns a silent emitter for falsy values", () => {
		for (const value of ["0", "false", "FALSE", "no", " No "]) {
			const { stream, chunks } = captureWrites();
			const emit = resolveOAuthAuditEmitterFromEnv(value);
			emit(buildOAuthAuditEvent("bearer", { outcome: "denied", now: 0 }));
			const probe = createDefaultOAuthAuditEmitter(
				stream as unknown as Parameters<typeof createDefaultOAuthAuditEmitter>[0],
			);
			probe(buildOAuthAuditEvent("bearer", { outcome: "denied", now: 0 }));
			expect(chunks).toHaveLength(1);
		}
	});

	it("env resolver returns a default-shaped emitter when unset or unknown", () => {
		expect(typeof resolveOAuthAuditEmitterFromEnv(undefined)).toBe("function");
		expect(typeof resolveOAuthAuditEmitterFromEnv("anything-else")).toBe("function");
	});

	it("wraps emitters so emitter failures never throw into the caller", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const throwingEmitter = () => {
				throw new Error("stream write failed");
			};
			const safe = wrapAuditEmitterBestEffort(throwingEmitter);
			const event = buildOAuthAuditEvent("bearer", { outcome: "denied", now: 0 });
			expect(() => safe(event)).not.toThrow();
			expect(() => safe(event)).not.toThrow();
			// First failure surfaces, subsequent ones are suppressed to avoid log floods.
			expect(consoleError).toHaveBeenCalledTimes(1);
		} finally {
			consoleError.mockRestore();
		}
	});
});
