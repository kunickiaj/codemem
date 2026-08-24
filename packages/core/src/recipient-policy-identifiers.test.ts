import { describe, expect, it } from "vitest";
import {
	canonicalRecipientPolicyJson,
	deterministicPolicyTeamId,
	isStrictRecipientPolicyId,
	isStrictRecipientPolicyProjectIdentity,
	legacyRecipientPolicyDigest,
	legacyTeamCandidateId,
	legacyTeamRosterFingerprint,
	recipientPolicyDigest,
} from "./recipient-policy-identifiers.js";

describe("recipient policy identifiers", () => {
	it.each([
		["ordinary ID", "device-a", true],
		["256 UTF-16 units", "a".repeat(256), true],
		["256 astral UTF-16 units", "😀".repeat(128), true],
		["empty ID", "", false],
		["leading whitespace", " device-a", false],
		["trailing whitespace", "device-a ", false],
		["Cc character", "device-a\n", false],
		["Cf character", "device-\u200B-a", false],
		["257 UTF-16 units", "a".repeat(257), false],
		["258 astral UTF-16 units", "😀".repeat(129), false],
		["non-string runtime value", undefined, false],
	] as const)("validates the shared strict grammar for %s", (_label, value, expected) => {
		expect(isStrictRecipientPolicyId(value)).toBe(expected);
	});

	it.each([
		["257 UTF-16 units", "p".repeat(257), true],
		["2048 UTF-16 units", "p".repeat(2_048), true],
		["2049 UTF-16 units", "p".repeat(2_049), false],
		["format character", `project-\u200B${"p".repeat(257)}`, false],
	] as const)("validates canonical Project identity limits for %s", (_label, value, expected) => {
		expect(isStrictRecipientPolicyProjectIdentity(value)).toBe(expected);
	});

	it.each([
		["null", null, "null"],
		["boolean", true, "true"],
		["string", "recipient", '"recipient"'],
		["finite number", 1.5, "1.5"],
		["dense array", [3, 2, 1], "[3,2,1]"],
		["sorted plain object", { z: 1, a: [{ y: 2, x: 1 }] }, '{"a":[{"x":1,"y":2}],"z":1}'],
		[
			"null-prototype object",
			Object.assign(Object.create(null) as Record<string, unknown>, { z: 1, a: 2 }),
			'{"a":2,"z":1}',
		],
	] as const)("canonicalizes supported %s data", (_label, value, expected) => {
		const result = canonicalRecipientPolicyJson(value);

		expect(result).toBe(expected);
	});

	it.each([
		["undefined", () => undefined],
		["function", () => () => undefined],
		["symbol", () => Symbol("unsupported")],
		["bigint", () => 1n],
		["NaN", () => Number.NaN],
		["positive infinity", () => Number.POSITIVE_INFINITY],
		["negative infinity", () => Number.NEGATIVE_INFINITY],
		["negative zero", () => -0],
		["sparse array", () => new Array(1)],
		["array with a custom property", () => Object.assign([1], { custom: true })],
		[
			"object accessor",
			() => Object.defineProperty({}, "value", { enumerable: true, get: () => 1 }),
		],
		["symbol property", () => ({ [Symbol("unsupported")]: true })],
		["non-enumerable property", () => Object.defineProperty({}, "hidden", { value: true })],
		["non-plain object", () => new Date(0)],
		[
			"cyclic object",
			() => {
				const value: Record<string, unknown> = {};
				value.self = value;
				return value;
			},
		],
	] as const)("rejects unsupported %s values", (_label, createValue) => {
		const value = createValue();
		const act = () => canonicalRecipientPolicyJson(value);

		expect(act).toThrow(TypeError);
	});

	it("accepts shared acyclic values by expanding each reference", () => {
		const shared = { value: true };
		const value = { left: shared, right: shared };

		const result = canonicalRecipientPolicyJson(value);

		expect(result).toBe('{"left":{"value":true},"right":{"value":true}}');
	});

	it("rejects formerly colliding values inside supported containers", () => {
		expect(canonicalRecipientPolicyJson({})).toBe("{}");
		expect(() => canonicalRecipientPolicyJson({ value: undefined })).toThrow(TypeError);
		expect(() => canonicalRecipientPolicyJson([undefined])).toThrow(TypeError);
		expect(() => canonicalRecipientPolicyJson({ nested: [{ value: Symbol("x") }] })).toThrow(
			TypeError,
		);
	});

	it("rejects NUL in a digest domain prefix", () => {
		const act = () => recipientPolicyDigest("recipient\0policy", { value: true });

		expect(act).toThrow(TypeError);
	});

	it.each([
		"\uD800",
		"\uDC00",
		"recipient\uD800policy",
		"\uDC00\uD800",
	])("rejects ill-formed UTF-16 in digest domain prefix %j", (prefix) => {
		expect(() => recipientPolicyDigest(prefix, { value: true })).toThrow(TypeError);
	});

	it("keeps well-formed astral-plane digest prefixes stable", () => {
		const prefix = "recipient-\u{1F600}-v1";
		const value = { value: true };

		expect(recipientPolicyDigest(prefix, value)).toBe(recipientPolicyDigest(prefix, value));
		expect(recipientPolicyDigest("\uFFFD", value)).toBeTypeOf("string");
	});

	it("pins the domain-separated digest bytes and external shape", () => {
		const result = recipientPolicyDigest("recipient-policy-test-v1", {
			b: [true, null, "x"],
			a: 1,
		});

		expect(result).toBe(
			"recipient-policy-test-v1:3ccd3e1ed08f09bd3923eadc07eb9dc45f49284ab51fe49c674a0f46c574c06e",
		);
	});

	it("produces different hashes for identical values in different domains", () => {
		const value = { recipient: "identity-a" };

		const first = recipientPolicyDigest("recipient-policy-a-v1", value);
		const second = recipientPolicyDigest("recipient-policy-b-v1", value);

		expect(first.split(":", 2)[1]).not.toBe(second.split(":", 2)[1]);
		expect(recipientPolicyDigest("ab", "c").split(":", 2)[1]).not.toBe(
			recipientPolicyDigest("a", "bc").split(":", 2)[1],
		);
	});

	it("preserves released recipient-policy digest bytes without domain separation", () => {
		expect(
			legacyRecipientPolicyDigest("recipient-policy-test-v1", {
				b: [true, null, "x"],
				a: 1,
			}),
		).toBe(
			"recipient-policy-test-v1:eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1",
		);
		for (const prefix of [
			"device-identity-binding-preview-v1",
			"edge-preview-v1",
			"recipient-onboarding-preview-v1",
			"recipient-policy-devices-v1",
		]) {
			expect(legacyRecipientPolicyDigest(prefix, { b: [true, null, "x"], a: 1 })).toBe(
				`${prefix}:eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1`,
			);
		}
		expect(deterministicPolicyTeamId("legacy-team-candidate:test")).toBe(
			"policy-team-v1:61e1813516059b6f1a1bc74aa7dc1f7a70560dd0b396df5eaccb3b26c1bdebbd",
		);
	});

	it("derives stable opaque candidate and Team identifiers", () => {
		const candidate = legacyTeamCandidateId("coordinator-private", "group-private");

		expect(candidate).toBe(legacyTeamCandidateId("coordinator-private", "group-private"));
		expect(candidate).not.toContain("coordinator-private");
		expect(candidate).not.toContain("group-private");
		expect(deterministicPolicyTeamId(candidate)).toBe(deterministicPolicyTeamId(candidate));
	});

	it("fingerprints stable roster evidence independently of ordering", () => {
		const devices = [
			{ deviceId: "b", fingerprint: "key-b", enabled: false, identityId: null },
			{ deviceId: "a", fingerprint: "key-a", enabled: true, identityId: "person-a" },
		];
		const reversed = [...devices].reverse();
		const [firstDevice, secondDevice] = devices;
		if (!firstDevice || !secondDevice) throw new Error("invalid test fixture");

		expect(legacyTeamRosterFingerprint(devices)).toBe(legacyTeamRosterFingerprint(reversed));
		expect(legacyTeamRosterFingerprint(devices)).not.toBe(
			legacyTeamRosterFingerprint([{ ...firstDevice, enabled: true }, secondDevice]),
		);
	});
});
