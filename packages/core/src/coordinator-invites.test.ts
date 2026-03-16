import { describe, expect, it } from "vitest";
import {
	decodeInvitePayload,
	encodeInvitePayload,
	extractInvitePayload,
	type InvitePayload,
	inviteLink,
} from "./coordinator-invites.js";

const SAMPLE_PAYLOAD: InvitePayload = {
	v: 1,
	kind: "invite",
	coordinator_url: "https://coordinator.example.com",
	group_id: "grp-abc123",
	policy: "auto_approve",
	token: "tok-xyz",
	expires_at: "2026-12-31T23:59:59Z",
	team_name: "My Team",
};

describe("coordinator-invites", () => {
	describe("encode/decode round-trip", () => {
		it("round-trips a full payload", () => {
			const encoded = encodeInvitePayload(SAMPLE_PAYLOAD);
			expect(typeof encoded).toBe("string");
			expect(encoded.length).toBeGreaterThan(0);
			// No padding characters
			expect(encoded).not.toContain("=");

			const decoded = decodeInvitePayload(encoded);
			expect(decoded).toEqual(SAMPLE_PAYLOAD);
		});

		it("round-trips a payload with null team_name", () => {
			const payload: InvitePayload = { ...SAMPLE_PAYLOAD, team_name: null };
			const decoded = decodeInvitePayload(encodeInvitePayload(payload));
			expect(decoded.team_name).toBeNull();
		});
	});

	describe("decodeInvitePayload", () => {
		it("throws on non-object payload", () => {
			// Encode a string literal as base64url
			const encoded = Buffer.from('"just a string"').toString("base64url").replace(/=+$/, "");
			expect(() => decodeInvitePayload(encoded)).toThrow("invalid invite payload");
		});
	});

	describe("inviteLink", () => {
		it("produces a codemem:// link", () => {
			const encoded = encodeInvitePayload(SAMPLE_PAYLOAD);
			const link = inviteLink(encoded);
			expect(link).toMatch(/^codemem:\/\/join\?invite=/);
			expect(link).toContain(encodeURIComponent(encoded));
		});
	});

	describe("extractInvitePayload", () => {
		it("extracts from a codemem:// link", () => {
			const encoded = encodeInvitePayload(SAMPLE_PAYLOAD);
			const link = inviteLink(encoded);
			const extracted = extractInvitePayload(link);
			expect(extracted).toBe(encoded);
		});

		it("returns raw value if not a codemem:// link", () => {
			const raw = "some-base64url-value";
			expect(extractInvitePayload(raw)).toBe(raw);
		});

		it("trims whitespace", () => {
			const raw = "  some-value  ";
			expect(extractInvitePayload(raw)).toBe("some-value");
		});

		it("throws if codemem:// link has no invite param", () => {
			expect(() => extractInvitePayload("codemem://join?other=foo")).toThrow(
				"invite payload missing from link",
			);
		});

		it("full round-trip: encode → link → extract → decode", () => {
			const encoded = encodeInvitePayload(SAMPLE_PAYLOAD);
			const link = inviteLink(encoded);
			const extracted = extractInvitePayload(link);
			const decoded = decodeInvitePayload(extracted);
			expect(decoded).toEqual(SAMPLE_PAYLOAD);
		});
	});
});
