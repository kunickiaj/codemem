import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import {
	importOwnerEnrollmentAdmissionKey,
	issueOwnerEnrollmentAdmission,
	issueOwnerEnrollmentAdmissionV2,
	type OwnerEnrollmentAdmissionKey,
	type OwnerEnrollmentResolvedOwner,
	ownerEnrollmentOwnerCommitment,
	verifyOwnerEnrollmentAdmission,
	verifyOwnerEnrollmentAdmissionV2,
} from "./owner-enrollment-admission.js";
import { ownerEnrollmentStartMessage } from "./owner-enrollment-start.js";

const MAX_TTL = 900000;
const rawKey = new Uint8Array(32).fill(23);
const owner = {
	coordinatorId: "coordinator-a",
	issuer: "https://issuer.example.test",
	subject: "fixture-subject-a",
	identityId: "identity-a",
	linkId: "link-a",
};
const pin = {
	coordinatorId: owner.coordinatorId,
	origin: "https://app.example.test",
	issuer: owner.issuer,
	revision: "a".repeat(64),
};
const ownerFields = ["coordinatorId", "issuer", "subject", "identityId", "linkId"] as const;

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});

async function fixture() {
	const key = await importOwnerEnrollmentAdmissionKey(rawKey);
	const pendingKey = commitPendingKey();
	const start = {
		attemptId: "attempt-a",
		deviceId: "device-a",
		publicKey: pendingKey.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: Buffer.alloc(32, 9).toString("base64url"),
		signature: "",
	};
	start.signature = pendingKey.sign(ownerEnrollmentStartMessage(start, pin));
	const options = { resolvedOwner: { ...owner }, nowMs: NOW, ttlMs: MAX_TTL };
	const token = await issueOwnerEnrollmentAdmissionV2(key, pin, start, options);
	return { key, pendingKey, start, token, options };
}

function ownerJson(value: OwnerEnrollmentResolvedOwner) {
	return JSON.stringify([
		"codemem-owner-enrollment-owner-commitment-v1",
		...ownerFields.map((field) => value[field]),
	]);
}

// Independently sign wire fixtures so invalid times/domains cannot pass merely because of a bad MAC.
function signedToken(
	c: Awaited<ReturnType<typeof fixture>>,
	issued: number,
	expires: number,
	domain = "codemem-owner-enrollment-admission-v2",
) {
	const commitment = createHash("sha256").update(ownerJson(owner)).digest("hex");
	const message = JSON.stringify([
		domain,
		issued,
		expires,
		ownerEnrollmentStartMessage(c.start, pin),
		c.start.signature,
		commitment,
	]);
	const mac = createHmac("sha256", rawKey).update(message).digest("base64url");
	return `v2.${issued}.${expires}.${commitment}.${mac}`;
}

it("hashes the exact ordered, domain-separated owner tuple without normalizing subject", async () => {
	// Arrange: property insertion order must not change canonical field order.
	const reordered = {
		linkId: owner.linkId,
		identityId: owner.identityId,
		subject: owner.subject,
		issuer: owner.issuer,
		coordinatorId: owner.coordinatorId,
	};
	const expected = createHash("sha256").update(ownerJson(owner)).digest("hex");
	// Act
	const actual = await ownerEnrollmentOwnerCommitment(reordered);
	const spaced = await ownerEnrollmentOwnerCommitment({ ...owner, subject: ` ${owner.subject} ` });
	const wrongDomain = createHash("sha256")
		.update(JSON.stringify(ownerFields.map((field) => owner[field])))
		.digest("hex");
	// Assert
	expect(actual).toBe(expected);
	expect(actual).toMatch(/^[a-f0-9]{64}$/);
	expect(spaced).not.toBe(actual);
	expect(actual).not.toBe(wrongDomain);
});

it.each(ownerFields)("commits to exact owner %s, rejecting owner B substitution", async (field) => {
	// Arrange
	const c = await fixture();
	const changed = { ...owner, [field]: `${owner[field]}-b` };
	// Act
	const commitment = await ownerEnrollmentOwnerCommitment(changed);
	const accepted = await verifyOwnerEnrollmentAdmissionV2(c.key, c.token, pin, c.start, {
		resolvedOwner: changed,
		nowMs: NOW,
	});
	// Assert
	expect(commitment).not.toBe(c.token.split(".")[3]);
	expect(accepted).toBe(false);
});

const invalidOwnerFields = ownerFields.flatMap((field) =>
	[undefined, null, 42, "", "\n", "a\u200bb", "a\ud800b"].map((value) => ({ field, value })),
);
it.each([
	...invalidOwnerFields,
	{ field: "subject", value: " ".repeat(3) },
	{ field: "subject", value: "a".repeat(256) },
	{ field: "issuer", value: "http://issuer.example.test" },
	{ field: "issuer", value: "https://user:pass@issuer.example.test" },
	{ field: "issuer", value: "https://issuer.example.test?query" },
	{ field: "issuer", value: "https://issuer.example.test#fragment" },
	{ field: "issuer", value: " https://issuer.example.test" },
	{ field: "issuer", value: "https://issuer.example.test/\\path" },
	...(["coordinatorId", "identityId", "linkId"] as const).flatMap((field) => [
		{ field, value: "a".repeat(257) },
		{ field, value: " padded " },
	]),
])(
	"rejects malformed owner $field = $value in hash, issuer and verifier",
	async ({ field, value }) => {
		// Arrange: exercise runtime inputs that TypeScript cannot protect.
		const c = await fixture();
		const invalid = { ...owner, [field]: value } as OwnerEnrollmentResolvedOwner;
		// Act
		const commitment = ownerEnrollmentOwnerCommitment(invalid);
		const issuance = issueOwnerEnrollmentAdmissionV2(c.key, pin, c.start, {
			...c.options,
			resolvedOwner: invalid,
		});
		const verification = verifyOwnerEnrollmentAdmissionV2(c.key, c.token, pin, c.start, {
			resolvedOwner: invalid,
			nowMs: NOW,
		});
		// Assert
		await expect(commitment).rejects.toThrow();
		await expect(issuance).rejects.toThrow();
		await expect(verification).resolves.toBe(false);
	},
);

it("accepts maximum-length IDs and subject, preserving case and Unicode", async () => {
	// Arrange
	const c = await fixture();
	const resolvedOwner = {
		...owner,
		identityId: "a".repeat(256),
		linkId: "b".repeat(256),
		subject: `É${"x".repeat(254)}`,
	};
	// Act
	const token = await issueOwnerEnrollmentAdmissionV2(c.key, pin, c.start, {
		...c.options,
		resolvedOwner,
	});
	const accepted = await verifyOwnerEnrollmentAdmissionV2(c.key, token, pin, c.start, {
		resolvedOwner,
		nowMs: NOW,
	});
	// Assert
	expect(accepted).toBe(true);
	expect(
		await ownerEnrollmentOwnerCommitment({
			...resolvedOwner,
			subject: resolvedOwner.subject.toLowerCase(),
		}),
	).not.toBe(token.split(".")[3]);
});

it.each(["coordinatorId", "issuer"] as const)(
	"refuses issuance for mismatched owner/pin %s",
	async (field) => {
		// Arrange
		const c = await fixture();
		const resolvedOwner = { ...owner, [field]: `${owner[field]}-b` };
		// Act
		const result = issueOwnerEnrollmentAdmissionV2(c.key, pin, c.start, {
			...c.options,
			resolvedOwner,
		});
		// Assert
		await expect(result).rejects.toThrow("owner_admission_invalid_start");
	},
);

it.each(["coordinatorId", "origin", "issuer", "revision"] as const)(
	"rejects config drift in %s",
	async (field) => {
		// Arrange
		const c = await fixture();
		const replacements = {
			coordinatorId: "coordinator-b",
			origin: "https://other.example.test",
			issuer: "https://other-issuer.example.test",
			revision: "b".repeat(64),
		};
		const changed = { ...pin, [field]: replacements[field] };
		// Act
		const accepted = await verifyOwnerEnrollmentAdmissionV2(
			c.key,
			c.token,
			changed,
			c.start,
			c.options,
		);
		// Assert
		expect(accepted).toBe(false);
	},
);

it.each([
	"attemptId",
	"deviceId",
	"publicKey",
	"loopbackRedirect",
	"browserStartCode",
	"signature",
] as const)(
	"rejects a changed signed start %s, including validly re-signed starts",
	async (field) => {
		// Arrange
		const c = await fixture();
		const otherKey = commitPendingKey();
		const replacements = {
			attemptId: "attempt-b",
			deviceId: "device-b",
			publicKey: otherKey.publicKey,
			loopbackRedirect: "http://127.0.0.1:43211/codemem/auth/complete",
			browserStartCode: Buffer.alloc(32, 10).toString("base64url"),
			signature: "A".repeat(86),
		};
		const changed = { ...c.start, [field]: replacements[field] };
		if (field !== "signature") {
			const signer = field === "publicKey" ? otherKey : c.pendingKey;
			changed.signature = signer.sign(ownerEnrollmentStartMessage(changed, pin));
		}
		// Act
		const accepted = await verifyOwnerEnrollmentAdmissionV2(
			c.key,
			c.token,
			pin,
			changed,
			c.options,
		);
		// Assert
		expect(accepted).toBe(false);
	},
);

it.each(["signature", "publicKey", "browserStartCode", "loopbackRedirect"] as const)(
	"issuer refuses invalid pending start %s",
	async (field) => {
		// Arrange
		const c = await fixture();
		const replacements = {
			signature: "A".repeat(86),
			publicKey: `${c.start.publicKey} comment`,
			browserStartCode: `${c.start.browserStartCode}=`,
			loopbackRedirect: "https://app.example.test/complete",
		};
		// Act
		const result = issueOwnerEnrollmentAdmissionV2(
			c.key,
			pin,
			{ ...c.start, [field]: replacements[field] },
			c.options,
		);
		// Assert
		await expect(result).rejects.toThrow();
	},
);

it("keeps v1 and v2 isolated in both directions, including prefix swaps", async () => {
	// Arrange
	const c = await fixture();
	const v1 = await issueOwnerEnrollmentAdmission(c.key, pin, c.start, c.options);
	// Act
	const results = await Promise.all([
		verifyOwnerEnrollmentAdmission(c.key, v1, pin, c.start, NOW),
		verifyOwnerEnrollmentAdmissionV2(c.key, c.token, pin, c.start, c.options),
		verifyOwnerEnrollmentAdmission(c.key, c.token, pin, c.start, NOW),
		verifyOwnerEnrollmentAdmissionV2(c.key, v1, pin, c.start, c.options),
		verifyOwnerEnrollmentAdmission(c.key, c.token.replace(/^v2/, "v1"), pin, c.start, NOW),
		verifyOwnerEnrollmentAdmissionV2(c.key, v1.replace(/^v1/, "v2"), pin, c.start, c.options),
		verifyOwnerEnrollmentAdmissionV2(
			c.key,
			signedToken(c, NOW, NOW + MAX_TTL, "codemem-owner-enrollment-admission-v1"),
			pin,
			c.start,
			c.options,
		),
	]);
	// Assert
	expect(results).toEqual([true, true, false, false, false, false, false]);
});

it.each([
	[NOW - 1, false],
	[NOW, true],
	[NOW + MAX_TTL - 1, true],
	[NOW + MAX_TTL, false],
	[NaN, false],
	[Infinity, false],
	[-1, false],
	[NOW + 0.5, false],
] as const)("verifies interval boundary %s as %s", async (nowMs, expected) => {
	// Arrange
	const c = await fixture();
	// Act
	const accepted = await verifyOwnerEnrollmentAdmissionV2(c.key, c.token, pin, c.start, {
		...c.options,
		nowMs,
	});
	// Assert
	expect(accepted).toBe(expected);
});

it.each([0, -1, 0.5, MAX_TTL + 1, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
	"refuses invalid issuance TTL %s",
	async (ttlMs) => {
		// Arrange
		const c = await fixture();
		// Act
		const result = issueOwnerEnrollmentAdmissionV2(c.key, pin, c.start, { ...c.options, ttlMs });
		// Assert
		await expect(result).rejects.toThrow();
	},
);

it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
	"refuses invalid issuance time %s",
	async (nowMs) => {
		// Arrange
		const c = await fixture();
		// Act
		const result = issueOwnerEnrollmentAdmissionV2(c.key, pin, c.start, { ...c.options, nowMs });
		// Assert
		await expect(result).rejects.toThrow();
	},
);

it.each([
	[0, 1, 0, true],
	[NOW, NOW + 1, NOW, true],
	[NOW, NOW, NOW, false],
	[NOW, NOW - 1, NOW, false],
	[NOW, NOW + MAX_TTL + 1, NOW, false],
	[NOW + 1, NOW + 2, NOW, false],
	[NOW - 2, NOW - 1, NOW, false],
] as const)(
	"validates independently authenticated times %s/%s at %s",
	async (issued, expires, nowMs, expected) => {
		// Arrange
		const c = await fixture();
		const token = signedToken(c, issued, expires);
		// Act
		const accepted = await verifyOwnerEnrollmentAdmissionV2(c.key, token, pin, c.start, {
			...c.options,
			nowMs,
		});
		// Assert
		expect(accepted).toBe(expected);
	},
);

it("rejects malformed encoding, forged commitments/MACs and runtime token types", async () => {
	// Arrange
	const c = await fixture();
	const parts = c.token.split(".");
	const mac = parts[4] ?? "";
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const last = alphabet.indexOf(mac.at(-1) ?? "");
	const ambiguousMac = mac.slice(0, -1) + alphabet[last + 1];
	const tokens: unknown[] = [
		null,
		undefined,
		42,
		{},
		"",
		"x".repeat(1000),
		` ${c.token}`,
		`${c.token}\n`,
		`${c.token}=`,
		`${c.token}.extra`,
		c.token.replace(`.${NOW}.`, `.0${NOW}.`),
		c.token.replace(`.${NOW}.`, `.+${NOW}.`),
		c.token.replace(`.${NOW}.`, `.1e12.`),
		c.token.replace(parts[3] ?? "", "F".repeat(64)),
		c.token.replace(parts[3] ?? "", "b".repeat(64)),
		c.token.replace(mac, "A".repeat(43)),
		c.token.replace(mac, ambiguousMac),
		c.token.replace(mac, `${mac.slice(0, -1)}=`),
	];
	// Act
	const results = await Promise.all(
		tokens.map((token) => verifyOwnerEnrollmentAdmissionV2(c.key, token, pin, c.start, c.options)),
	);
	// Assert
	expect(results).toEqual(tokens.map(() => false));
});

it("rejects other and forged key handles while accepting the fixture key", async () => {
	// Arrange
	const c = await fixture();
	const other = await importOwnerEnrollmentAdmissionKey(new Uint8Array(32).fill(24));
	const forged = {} as OwnerEnrollmentAdmissionKey;
	// Act
	const results = await Promise.all(
		[c.key, other, forged].map((key) =>
			verifyOwnerEnrollmentAdmissionV2(key, c.token, pin, c.start, c.options),
		),
	);
	const issuance = issueOwnerEnrollmentAdmissionV2(forged, pin, c.start, c.options);
	// Assert
	expect(results).toEqual([true, false, false]);
	await expect(issuance).rejects.toThrow();
});

it("emits only version, times, authenticated owner hash and MAC, without raw owner data", async () => {
	// Arrange
	const c = await fixture();
	// Act
	const parts = c.token.split(".");
	const expectedHash = await ownerEnrollmentOwnerCommitment(owner);
	// Assert
	expect(parts).toEqual([
		"v2",
		String(NOW),
		String(NOW + MAX_TTL),
		expectedHash,
		expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
	]);
	for (const value of Object.values(owner)) expect(c.token).not.toContain(value);
	expect(c.token).toBe(signedToken(c, NOW, NOW + MAX_TTL));
});

function holdDigest() {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
	vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
		entered.resolve();
		await release.promise;
		return digest(...args);
	});
	return { entered: entered.promise, release: () => release.resolve() };
}

function mutableInputs(c: Awaited<ReturnType<typeof fixture>>) {
	const pinned = { ...pin };
	const pending = { ...c.start };
	const resolvedOwner = { ...owner };
	const options = { ...c.options, resolvedOwner };
	const mutate = () => {
		for (const field of Object.keys(pinned) as (keyof typeof pinned)[]) pinned[field] = "invalid";
		for (const field of Object.keys(pending) as (keyof typeof pending)[])
			pending[field] = "invalid";
		for (const field of ownerFields) resolvedOwner[field] = "invalid";
		options.resolvedOwner = { ...owner, subject: "different-owner" };
		options.nowMs = -1;
		options.ttlMs = -1;
	};
	return { pinned, pending, options, mutate };
}

it("captures issuance inputs before the first awaited signature verification", async () => {
	// Arrange: hold real pending-key verification, not an elapsed-time delay.
	const c = await fixture();
	const inputs = mutableInputs(c);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const verify = globalThis.crypto.subtle.verify.bind(globalThis.crypto.subtle);
	vi.spyOn(globalThis.crypto.subtle, "verify").mockImplementationOnce(async (...args) => {
		entered.resolve();
		await release.promise;
		return verify(...args);
	});
	// Act
	const result = issueOwnerEnrollmentAdmissionV2(
		c.key,
		inputs.pinned,
		inputs.pending,
		inputs.options,
	);
	await entered.promise;
	inputs.mutate();
	release.resolve();
	// Assert
	await expect(result).resolves.toBe(c.token);
});

it.each(["issue", "verify"] as const)(
	"retains captured owner, pin, start and options across %s hashing",
	async (operation) => {
		// Arrange
		const c = await fixture();
		const inputs = mutableInputs(c);
		const held = holdDigest();
		// Act
		let result: Promise<string | boolean>;
		if (operation === "issue")
			result = issueOwnerEnrollmentAdmissionV2(
				c.key,
				inputs.pinned,
				inputs.pending,
				inputs.options,
			);
		else
			result = verifyOwnerEnrollmentAdmissionV2(
				c.key,
				c.token,
				inputs.pinned,
				inputs.pending,
				inputs.options,
			);
		await held.entered;
		inputs.mutate();
		held.release();
		// Assert
		await expect(result).resolves.toBe(operation === "issue" ? c.token : true);
	},
);

it("hashes the captured owner even when its fields change during digest", async () => {
	// Arrange
	const mutableOwner = { ...owner };
	const expected = createHash("sha256").update(ownerJson(owner)).digest("hex");
	const held = holdDigest();
	// Act
	const result = ownerEnrollmentOwnerCommitment(mutableOwner);
	await held.entered;
	for (const field of ownerFields) mutableOwner[field] = "invalid";
	held.release();
	// Assert
	await expect(result).resolves.toBe(expected);
});

function onceRead<T extends object>(value: T) {
	const reads: Record<string, number> = {};
	const wrapped = { ...value };
	for (const field of Object.keys(value) as (keyof T & string)[]) {
		Object.defineProperty(wrapped, field, {
			get: () => {
				reads[field] = (reads[field] ?? 0) + 1;
				if (reads[field] !== 1) throw new Error(`input field reread: ${field}`);
				return value[field];
			},
		});
	}
	return { wrapped, reads };
}

it.each(["issue", "verify"] as const)(
	"reads caller accessors once and validates their captured values during %s",
	async (operation) => {
		// Arrange: later accessor reads throw instead of silently yielding changed values.
		const c = await fixture();
		const pinned = onceRead(pin);
		const pending = onceRead(c.start);
		const resolved = onceRead(owner);
		const options = onceRead({ ...c.options, resolvedOwner: resolved.wrapped });
		// Act
		let result: string | boolean;
		if (operation === "issue")
			result = await issueOwnerEnrollmentAdmissionV2(
				c.key,
				pinned.wrapped,
				pending.wrapped,
				options.wrapped,
			);
		else
			result = await verifyOwnerEnrollmentAdmissionV2(
				c.key,
				c.token,
				pinned.wrapped,
				pending.wrapped,
				options.wrapped,
			);
		// Assert
		expect(result).toBe(operation === "issue" ? c.token : true);
		for (const input of [pinned, pending, resolved, options]) {
			expect(Object.values(input.reads).every((count) => count === 1)).toBe(true);
		}
	},
);

it.each(["issue", "verify"] as const)(
	"refuses invalid accessor owner values during %s even if later reads would be valid",
	async (operation) => {
		// Arrange
		const c = await fixture();
		let reads = 0;
		const resolvedOwner = {
			...owner,
			get subject() {
				return ++reads === 1 ? "\n" : owner.subject;
			},
		};
		const options = { ...c.options, resolvedOwner };
		// Act
		const result =
			operation === "issue"
				? issueOwnerEnrollmentAdmissionV2(c.key, pin, c.start, options)
				: verifyOwnerEnrollmentAdmissionV2(c.key, c.token, pin, c.start, options);
		// Assert
		if (operation === "issue")
			await expect(result).rejects.toThrow("owner_admission_invalid_owner");
		else await expect(result).resolves.toBe(false);
		expect(reads).toBe(1);
	},
);

it("validates the captured issuer even when a later owner getter repairs the input", async () => {
	// Arrange: the subject getter must not bypass validation of an earlier captured field.
	const mutableOwner = {
		...owner,
		issuer: "http://invalid.example.test",
		get subject() {
			this.issuer = owner.issuer;
			return owner.subject;
		},
	};
	// Act
	const result = ownerEnrollmentOwnerCommitment(mutableOwner);
	// Assert
	await expect(result).rejects.toThrow("owner_admission_invalid_owner");
	expect(mutableOwner.issuer).toBe(owner.issuer);
});

it("does not repair a captured invalid pending-key signature during verification", async () => {
	// Arrange
	const c = await fixture();
	const pending = { ...c.start, signature: "A".repeat(86) };
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const verify = globalThis.crypto.subtle.verify.bind(globalThis.crypto.subtle);
	vi.spyOn(globalThis.crypto.subtle, "verify").mockImplementationOnce(async (...args) => {
		entered.resolve();
		await release.promise;
		return verify(...args);
	});
	// Act
	const result = issueOwnerEnrollmentAdmissionV2(c.key, pin, pending, c.options);
	await entered.promise;
	pending.signature = c.start.signature;
	release.resolve();
	// Assert
	await expect(result).rejects.toThrow("owner_admission_invalid_start");
});

it("does not replace a captured wrong owner with the matching owner during hashing", async () => {
	// Arrange
	const c = await fixture();
	const resolvedOwner = { ...owner, subject: "owner-b" };
	const held = holdDigest();
	// Act
	const result = verifyOwnerEnrollmentAdmissionV2(c.key, c.token, pin, c.start, {
		...c.options,
		resolvedOwner,
	});
	await held.entered;
	resolvedOwner.subject = owner.subject;
	held.release();
	// Assert
	await expect(result).resolves.toBe(false);
});
