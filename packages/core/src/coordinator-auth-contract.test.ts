import { describe, expect, it } from "vitest";
import {
	type CoordinatorAccountLink,
	decideCoordinatorAccountLink,
	parseCoordinatorAccountReference,
} from "./coordinator-auth-contract.js";

const ISSUER = "https://accounts.example.test/tenant";
const FINGERPRINT = "a".repeat(64);
type LinkInput = Parameters<typeof decideCoordinatorAccountLink>[0];

function decide(request: LinkInput) {
	return decideCoordinatorAccountLink(request, { issuer: ISSUER });
}

function input(overrides: Partial<LinkInput> = {}): LinkInput {
	return {
		coordinatorId: "coordinator-a",
		account: { issuer: ISSUER, subject: "User A" },
		identityId: "identity-a",
		device: { deviceId: "device-a", fingerprint: FINGERPRINT },
		ownership: {
			kind: "controller_verified",
			coordinatorId: "coordinator-a",
			identityId: "identity-a",
			deviceId: "device-a",
			fingerprint: FINGERPRINT,
		},
		accountLink: null,
		identityLink: null,
		...overrides,
	};
}

function link(overrides: Partial<CoordinatorAccountLink> = {}): CoordinatorAccountLink {
	return {
		coordinatorId: "coordinator-a",
		account: { issuer: ISSUER, subject: "User A" },
		identityId: "identity-a",
		status: "active",
		...overrides,
	};
}

describe("parseCoordinatorAccountReference", () => {
	it.each([
		["ordinary", { issuer: ISSUER, subject: "User A" }, "User A"],
		["meaningful surrounding spaces", { issuer: ISSUER, subject: " User A " }, " User A "],
		["Unicode and exact case", { issuer: ISSUER, subject: "Élève 😀" }, "Élève 😀"],
		["255 characters", { issuer: ISSUER, subject: "s".repeat(255) }, "s".repeat(255)],
		[
			"ignored claims",
			{ issuer: ISSUER, subject: "User A", email: "ignored@example.test", token: "not-returned" },
			"User A",
		],
	] as const)(
		"preserves a valid %s subject without returning extra claims",
		(_label, value, subject) => {
			// Arrange: the configured issuer is the exact expected provider URL.
			const options = { issuer: ISSUER };

			// Act: parse metadata, not provider proof or a token.
			const result = parseCoordinatorAccountReference(value, options);

			// Assert: only the reference survives.
			expect(result).toEqual({ ok: true, account: { issuer: ISSUER, subject } });
		},
	);

	it.each([
		["null", null],
		["array", [{ issuer: ISSUER, subject: "User A" }]],
		["string", "User A"],
		["date", new Date(0)],
	] as const)("rejects a %s account reference", (_label, value) => {
		const options = { issuer: ISSUER };
		const result = parseCoordinatorAccountReference(value, options);
		expect(result).toEqual({ ok: false, error: "invalid_account_reference" });
	});

	it.each([
		["HTTP", "http://accounts.example.test"],
		["credentials", "https://user:pass@accounts.example.test"],
		["query", "https://accounts.example.test/?tenant=a"],
		["fragment", "https://accounts.example.test/#tenant"],
		["no hostname", "https:///"],
		["missing authority separator", "https:accounts.example.test"],
		["backslash separator", "https://accounts.example.test\\path"],
		["lone surrogate path", "https://accounts.example.test/\uD800"],
		["leading whitespace", ` ${ISSUER}`],
		["trailing whitespace", `${ISSUER} `],
	] as const)("rejects a configured issuer with %s", (_label, issuer) => {
		const reference = { issuer: ISSUER, subject: "User A" };
		const result = parseCoordinatorAccountReference(reference, { issuer });
		expect(result).toEqual({ ok: false, error: "invalid_issuer" });
	});

	it.each([
		["HTTP", "http://accounts.example.test"],
		["credentials", "https://user:pass@accounts.example.test"],
		["query", "https://accounts.example.test/?tenant=a"],
		["fragment", "https://accounts.example.test/#tenant"],
		["missing authority separator", "https:accounts.example.test"],
		["backslash separator", "https://accounts.example.test\\path"],
		["lone surrogate path", "https://accounts.example.test/\uD800"],
		["outer whitespace", ` ${ISSUER}`],
		["non-string", 4],
	] as const)("rejects a supplied issuer with %s", (_label, issuer) => {
		const reference = { issuer, subject: "User A" };
		const result = parseCoordinatorAccountReference(reference, { issuer: ISSUER });
		expect(result).toEqual({ ok: false, error: "invalid_issuer" });
	});

	it.each([
		["different path", "https://accounts.example.test/other"],
		["trailing slash", `${ISSUER}/`],
		["different hostname case", "https://ACCOUNTS.example.test/tenant"],
	] as const)("does not canonicalize a %s issuer match", (_label, issuer) => {
		const reference = { issuer, subject: "User A" };
		const result = parseCoordinatorAccountReference(reference, { issuer: ISSUER });
		expect(result).toEqual({ ok: false, error: "issuer_mismatch" });
	});

	it.each([
		["missing", undefined],
		["null", null],
		["array", ["User A"]],
		["empty", ""],
		["whitespace only", " \t "],
		["256 characters", "s".repeat(256)],
		["control", "User\nA"],
		["format", "User\u200BA"],
		["lone high surrogate", "User\uD800A"],
		["lone low surrogate", "User\uDC00A"],
	] as const)("rejects a %s subject", (_label, subject) => {
		const reference = { issuer: ISSUER, subject };
		const result = parseCoordinatorAccountReference(reference, { issuer: ISSUER });
		expect(result).toEqual({ ok: false, error: "invalid_subject" });
	});
});

describe("decideCoordinatorAccountLink ownership", () => {
	it.each(["controller_verified", "admin_verified"] as const)(
		"allows %s ownership to create inert metadata with no snapshots",
		(kind) => {
			const request = input({
				ownership: { ...input().ownership, kind } as LinkInput["ownership"],
			});
			const result = decide(request);
			expect(result).toEqual({
				kind: "eligible",
				disposition: "create",
				coordinatorId: "coordinator-a",
				identityId: "identity-a",
				account: { issuer: ISSUER, subject: "User A" },
			});
		},
	);

	it("allows a matching active account/Identity pair only after ownership review", () => {
		const request = input({ accountLink: link(), identityLink: link() });
		const result = decide(request);
		expect(result).toEqual({
			kind: "eligible",
			disposition: "existing",
			coordinatorId: "coordinator-a",
			identityId: "identity-a",
			account: { issuer: ISSUER, subject: "User A" },
		});
	});

	it.each(["invitation_claim", "unavailable"] as const)("denies %s ownership", (kind) => {
		const request = input({ ownership: { kind } });
		const result = decide(request);
		expect(result).toEqual({ kind: "rejected", error: "ownership_review_required" });
	});

	it("requires fresh ownership even for an existing matching link", () => {
		const request = input({
			ownership: { kind: "unavailable" },
			accountLink: link(),
			identityLink: link(),
		});
		const result = decide(request);
		expect(result).toEqual({ kind: "rejected", error: "ownership_review_required" });
	});

	it.each([
		["coordinator", { coordinatorId: "coordinator-b" }],
		["Identity", { identityId: "identity-b" }],
		["device", { deviceId: "device-b" }],
		["fingerprint", { fingerprint: "b".repeat(64) }],
	] as const)("rejects ownership with another %s", (_label, override) => {
		const verified = input().ownership;
		const request = input({ ownership: { ...verified, ...override } as LinkInput["ownership"] });
		const result = decide(request);
		expect(result).toEqual({ kind: "rejected", error: "ownership_mismatch" });
	});
});

describe("decideCoordinatorAccountLink input and snapshot validation", () => {
	it.each([
		["null request", null],
		["array request", []],
		["empty coordinator", { coordinatorId: "" }],
		["padded coordinator", { coordinatorId: " coordinator-a" }],
		["long Identity", { identityId: "i".repeat(257) }],
		["format device ID", { device: { deviceId: "device\u200Ba", fingerprint: FINGERPRINT } }],
		["control Identity", { identityId: "identity\na" }],
		["surrogate coordinator", { coordinatorId: "coordinator-\uD800" }],
		["surrogate Identity", { identityId: "identity-\uDC00" }],
		["surrogate device", { device: { deviceId: "device-\uD800", fingerprint: FINGERPRINT } }],
		["bad fingerprint case", { device: { deviceId: "device-a", fingerprint: "A".repeat(64) } }],
		["bad fingerprint length", { device: { deviceId: "device-a", fingerprint: "a".repeat(63) } }],
		[
			"unsafe account issuer",
			{ account: { issuer: "http://accounts.example.test", subject: "User A" } },
		],
		["unsafe account subject", { account: { issuer: ISSUER, subject: "\u200B" } }],
		["surrogate account subject", { account: { issuer: ISSUER, subject: "User\uD800" } }],
		[
			"different configured issuer",
			{ account: { issuer: "https://accounts.example.test/other", subject: "User A" } },
		],
		["array account", { account: [] }],
		["array ownership", { ownership: [] }],
		["unrecognized ownership", { ownership: { kind: "self_reported" } }],
		[
			"verified ownership missing device",
			{
				ownership: {
					kind: "controller_verified",
					coordinatorId: "coordinator-a",
					identityId: "identity-a",
					fingerprint: FINGERPRINT,
				},
			},
		],
		[
			"verified ownership missing fingerprint",
			{
				ownership: {
					kind: "admin_verified",
					coordinatorId: "coordinator-a",
					identityId: "identity-a",
					deviceId: "device-a",
				},
			},
		],
	] as const)("rejects malformed %s input", (_label, override) => {
		const request =
			override === null || Array.isArray(override)
				? (override as unknown as LinkInput)
				: ({ ...input(), ...override } as unknown as LinkInput);
		const result = decide(request);
		expect(result).toEqual({ kind: "rejected", error: "invalid_link_input" });
	});

	it.each([
		["missing Identity lookup", link(), null],
		["missing account lookup", null, link()],
		[
			"account lookup wrong account",
			link({ account: { issuer: ISSUER, subject: "User B" } }),
			link(),
		],
		["Identity lookup wrong Identity", link(), link({ identityId: "identity-b" })],
		["account lookup wrong coordinator", link({ coordinatorId: "coordinator-b" }), link()],
		["Identity lookup wrong coordinator", link(), link({ coordinatorId: "coordinator-b" })],
		["invalid status", link({ status: "pending" as CoordinatorAccountLink["status"] }), link()],
		["invalid snapshot subject", link({ account: { issuer: ISSUER, subject: "\n" } }), link()],
		[
			"invalid snapshot issuer path",
			link({ account: { issuer: "https://accounts.example.test/\uD800", subject: "User A" } }),
			link(),
		],
		["invalid snapshot Identity", link({ identityId: "identity\na" }), link()],
		["array snapshot", [] as unknown as CoordinatorAccountLink, link()],
		["undefined account lookup", undefined as unknown as CoordinatorAccountLink, null],
		["wrong-type Identity lookup", link(), "not-a-link" as unknown as CoordinatorAccountLink],
	] as const)(
		"rejects %s rather than treating lookup as absence",
		(_label, accountLink, identityLink) => {
			const request = input({ accountLink, identityLink });
			const result = decide(request);
			expect(result).toEqual({ kind: "rejected", error: "invalid_link_snapshot" });
		},
	);
});

describe("decideCoordinatorAccountLink mapping", () => {
	it("rejects an account already bound to another Identity", () => {
		const request = input({ accountLink: link({ identityId: "identity-b" }), identityLink: null });
		const result = decide(request);
		expect(result).toEqual({ kind: "rejected", error: "account_link_conflict" });
	});

	it.each([
		["subject", { issuer: ISSUER, subject: "user A" }],
		["issuer", { issuer: "https://accounts.example.test/other", subject: "User A" }],
	] as const)("rejects an Identity already bound to a different %s", (_label, account) => {
		const request = input({ accountLink: null, identityLink: link({ account }) });
		const result = decide(request);
		expect(result).toEqual({ kind: "rejected", error: "identity_link_conflict" });
	});

	it.each(["accountLink", "identityLink"] as const)("never unrevokes a %s", (side) => {
		const request = input({
			accountLink: link(),
			identityLink: link(),
			[side]: link({ status: "revoked" }),
		});
		const result = decide(request);
		expect(result).toEqual({ kind: "rejected", error: "link_revoked" });
	});

	it("treats identical provider evidence in another coordinator as separately eligible", () => {
		const second = input({
			coordinatorId: "coordinator-b",
			ownership: { ...input().ownership, coordinatorId: "coordinator-b" } as LinkInput["ownership"],
		});
		const firstResult = decide(input());
		const secondResult = decide(second);
		expect(firstResult).toMatchObject({ kind: "eligible", coordinatorId: "coordinator-a" });
		expect(secondResult).toMatchObject({ kind: "eligible", coordinatorId: "coordinator-b" });
	});

	it("does not mutate frozen inputs or leak extra account claims into the result", () => {
		const account = Object.freeze({
			issuer: ISSUER,
			subject: "User A",
			email: "ignored@example.test",
			secret: "not-returned",
		});
		const request = Object.freeze(
			input({
				account,
				device: Object.freeze({ deviceId: "device-a", fingerprint: FINGERPRINT }),
				ownership: Object.freeze(input().ownership),
				accountLink: Object.freeze(
					link({ account: Object.freeze({ issuer: ISSUER, subject: "User A" }) }),
				),
				identityLink: Object.freeze(
					link({ account: Object.freeze({ issuer: ISSUER, subject: "User A" }) }),
				),
			}),
		);
		const result = decide(request);
		expect(result).toEqual({
			kind: "eligible",
			disposition: "existing",
			coordinatorId: "coordinator-a",
			identityId: "identity-a",
			account: { issuer: ISSUER, subject: "User A" },
		});
		if (result.kind !== "eligible") throw new Error("expected eligible result");
		expect(result.account).not.toBe(account);
	});
});

describe("decideCoordinatorAccountLink trusted boundaries", () => {
	it("preserves valid emoji pairs in IDs and subject", () => {
		const request = input({
			coordinatorId: "coordinator-😀",
			identityId: "identity-😀",
			device: { deviceId: "device-😀", fingerprint: FINGERPRINT },
			account: { issuer: ISSUER, subject: "User 😀" },
			ownership: {
				kind: "admin_verified",
				coordinatorId: "coordinator-😀",
				identityId: "identity-😀",
				deviceId: "device-😀",
				fingerprint: FINGERPRINT,
			},
		});
		const result = decide(request);
		expect(result).toEqual({
			kind: "eligible",
			disposition: "create",
			coordinatorId: "coordinator-😀",
			identityId: "identity-😀",
			account: { issuer: ISSUER, subject: "User 😀" },
		});
	});

	it.each([
		["missing options", undefined],
		["null options", null],
		["array options", []],
		["HTTP issuer", { issuer: "http://accounts.example.test/tenant" }],
		["missing issuer", {}],
	] as const)(
		"rejects %s rather than using an account's own issuer as configuration",
		(_label, options) => {
			const request = input();
			const result = decideCoordinatorAccountLink(
				request,
				options as unknown as { issuer: string },
			);
			expect(result).toEqual({ kind: "rejected", error: "invalid_link_input" });
		},
	);

	it("rejects an otherwise valid reference from another configured issuer", () => {
		const request = input();
		const result = decideCoordinatorAccountLink(request, {
			issuer: "https://accounts.example.test/other",
		});
		expect(result).toEqual({ kind: "rejected", error: "invalid_link_input" });
	});

	it("rejects a reference whose issuer differs only in path without canonicalizing it", () => {
		const request = input({ account: { issuer: `${ISSUER}/`, subject: "User A" } });
		const result = decide(request);
		expect(result).toEqual({ kind: "rejected", error: "invalid_link_input" });
	});

	it("does not accept inherited coordinator scope", () => {
		const original = Object.getOwnPropertyDescriptor(Object.prototype, "coordinatorId");
		const request = input() as unknown as Record<string, unknown>;
		Reflect.deleteProperty(request, "coordinatorId");
		let result: ReturnType<typeof decide> | undefined;
		try {
			Object.defineProperty(Object.prototype, "coordinatorId", {
				configurable: true,
				value: "coordinator-a",
			});
			result = decide(request as unknown as LinkInput);
		} finally {
			if (original) Object.defineProperty(Object.prototype, "coordinatorId", original);
			else Reflect.deleteProperty(Object.prototype, "coordinatorId");
		}
		expect(result).toEqual({ kind: "rejected", error: "invalid_link_input" });
	});
});

describe("decideCoordinatorAccountLink accessor safety", () => {
	it("rejects an accessor on the configured issuer without invoking it", () => {
		let invoked = 0;
		const options = Object.defineProperty({}, "issuer", {
			get() {
				invoked++;
				return ISSUER;
			},
		}) as { issuer: string };
		const result = decideCoordinatorAccountLink(input(), options);
		expect(result).toEqual({ kind: "rejected", error: "invalid_link_input" });
		expect(invoked).toBe(0);
	});

	it.each([
		["request coordinator", "request", "coordinatorId", "invalid_link_input"],
		["request account", "request", "account", "invalid_link_input"],
		["device fingerprint", "device", "fingerprint", "invalid_link_input"],
		["ownership coordinator", "ownership", "coordinatorId", "invalid_link_input"],
		["account subject", "account", "subject", "invalid_link_input"],
		["snapshot status", "accountLink", "status", "invalid_link_snapshot"],
		["snapshot account issuer", "identityLinkAccount", "issuer", "invalid_link_snapshot"],
	] as const)("rejects %s accessor without invoking it", (_label, target, key, error) => {
		const request = input({ accountLink: link(), identityLink: link() });
		let object: object = request;
		if (target === "device") object = request.device;
		if (target === "ownership") object = request.ownership;
		if (target === "account") object = request.account;
		if (target === "accountLink") object = request.accountLink as CoordinatorAccountLink;
		if (target === "identityLinkAccount")
			object = (request.identityLink as CoordinatorAccountLink).account;
		let invoked = 0;
		Object.defineProperty(object, key, {
			configurable: true,
			enumerable: true,
			get() {
				invoked++;
				if (target === "request" && key === "coordinatorId") {
					return invoked === 1 ? "coordinator-a" : "coordinator-b";
				}
				return key === "issuer" ? ISSUER : "coordinator-a";
			},
		});
		const result = decide(request);
		expect(result).toEqual({ kind: "rejected", error });
		expect(invoked).toBe(0);
	});
});
