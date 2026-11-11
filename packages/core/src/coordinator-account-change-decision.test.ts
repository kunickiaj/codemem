import { describe, expect, it } from "vitest";
import {
	type AccountChangeFacts,
	type AccountChangeSubject,
	decideAccountChange,
	pickAccountChangeTarget,
} from "./coordinator-account-change-decision.js";
import { sqlIs } from "./coordinator-sql-compare.js";

const subject: AccountChangeSubject = {
	coordinatorId: "c",
	identityId: "identity",
	groupId: "g1",
	deviceId: "d1",
	publicKey: "key",
	fingerprint: "fp",
	keyId: "key-id",
	issuer: "issuer",
	enabled: true,
	connections: true,
};

/** A device-claim link with this device's own claim, which the decision allows. */
function allowedFacts(): AccountChangeFacts {
	return {
		enrollments: [
			{
				group_id: "g1",
				device_id: "d1",
				public_key: "key",
				fingerprint: "fp",
				identity_id: "identity",
				enabled: 1,
				group_live: 1,
			},
		],
		bindings: [],
		attestations: [],
		claims: [
			{
				claim_id: "claim",
				identity_id: "identity",
				group_id: "g1",
				device_id: "d1",
				public_key: "key",
				fingerprint: "fp",
				key_id: "key-id",
				active_link: 1,
				genesis: 1,
			},
		],
		link: [
			{
				coordinator_id: "c",
				link_id: "l1",
				identity_id: "identity",
				issuer: "issuer",
				subject: "account",
				auth_config_revision: "rev",
				revoked_at_ms: null,
				device_claim_id: "claim",
				attempts: [
					{
						identity_id: "identity",
						issuer: "issuer",
						account_subject: "account",
						auth_config_revision: "rev",
						state: "finalized",
					},
				],
				controller_birth: 0,
				device_birth: 1,
			},
		],
		revokedHistory: [],
		legacy: [{ assignment_current: 1, unwaivable_clear: 1, compatible_clear: 1 }],
		revocationConflicts: [],
		inviteConflicts: [],
		otherIdentityLinkAttemptConflicts: [],
		otherIdentityLinkAuditConflicts: [],
	};
}

const ownBinding = {
	coordinator_id: "c",
	device_id: "d1",
	key_id: "key-id",
	identity_id: "identity",
};
const currentReview = {
	attestation_id: "a1",
	identity_id: "identity",
	group_id: "g1",
	device_id: "d1",
	public_key: "key",
	fingerprint: "fp",
	revision: 1,
	revoked_at: null,
};

type Change = (f: AccountChangeFacts) => void;
const link = (f: AccountChangeFacts) => f.link[0] as AccountChangeFacts["link"][number];
const enrollment = (f: AccountChangeFacts) =>
	f.enrollments[0] as AccountChangeFacts["enrollments"][number];
const claim = (f: AccountChangeFacts) => f.claims[0] as AccountChangeFacts["claims"][number];
const legacy = (f: AccountChangeFacts) => f.legacy[0] as AccountChangeFacts["legacy"][number];

function decide(change: Change, p: AccountChangeSubject = subject) {
	const facts = allowedFacts();
	change(facts);
	return decideAccountChange(p, facts);
}

const denied: [string, Change][] = [
	["no target link", (f) => void f.link.splice(0)],
	[
		"a link of another Identity",
		(f) => {
			link(f).identity_id = "other";
		},
	],
	[
		"a link of another issuer",
		(f) => {
			link(f).issuer = "other";
		},
	],
	[
		"a link with a NULL issuer",
		(f) => {
			link(f).issuer = null;
		},
	],
	[
		"a revoked link",
		(f) => {
			link(f).revoked_at_ms = 5;
		},
	],
	["a revocation recorded in the history", (f) => void f.revokedHistory.push({ link_id: "x" })],
	["no creation attempt", (f) => void link(f).attempts.splice(0)],
	[
		"a creation attempt that has not finished",
		(f) => {
			(link(f).attempts[0] as { state: unknown }).state = "confirmed";
		},
	],
	[
		"a creation attempt with a NULL subject",
		(f) => {
			(link(f).attempts[0] as { account_subject: unknown }).account_subject = null;
		},
	],
	[
		"no verified birth",
		(f) => {
			link(f).device_birth = 0;
		},
	],
	[
		"a disabled enrollment",
		(f) => {
			enrollment(f).enabled = 0;
		},
	],
	[
		"an archived group",
		(f) => {
			enrollment(f).group_live = 0;
		},
	],
	[
		"an enrollment of another Identity",
		(f) => {
			enrollment(f).identity_id = "other";
		},
	],
	[
		"an enrollment with a NULL key",
		(f) => {
			enrollment(f).public_key = null;
		},
	],
	["no proof of this device", (f) => void f.claims.splice(0)],
	[
		"a claim without a verified genesis",
		(f) => {
			claim(f).genesis = 0;
		},
	],
	[
		"a claim of another key",
		(f) => {
			claim(f).key_id = "other-key";
		},
	],
	[
		"a claim with a NULL fingerprint",
		(f) => {
			claim(f).fingerprint = null;
		},
	],
	[
		"another Identity's claim of this device",
		(f) => void f.claims.push({ ...claim(f), claim_id: "x", identity_id: "other" }),
	],
	[
		"a review of this device for another Identity",
		(f) => void f.attestations.push({ ...currentReview, identity_id: "other" }),
	],
	[
		"a revoked review of this device",
		(f) => void f.attestations.push({ ...currentReview, revoked_at: "then" }),
	],
	[
		"a binding of this device for another Identity",
		(f) => void f.bindings.push({ ...ownBinding, identity_id: "other" }),
	],
	[
		"a current legacy assignment that changed",
		(f) => {
			legacy(f).assignment_current = 0;
		},
	],
	[
		"an unwaivable legacy contradiction",
		(f) => {
			legacy(f).unwaivable_clear = 0;
		},
	],
	[
		"a legacy contradiction",
		(f) => {
			legacy(f).compatible_clear = 0;
		},
	],
	[
		"a NULL legacy verdict",
		(f) => {
			legacy(f).compatible_clear = null;
		},
	],
	["no legacy verdict row", (f) => void f.legacy.splice(0)],
	["a revocation of the device", (f) => void f.revocationConflicts.push({})],
	["a conflicting invite", (f) => void f.inviteConflicts.push({})],
	["another Identity's link attempt", (f) => void f.otherIdentityLinkAttemptConflicts.push({})],
	["another Identity's link audit", (f) => void f.otherIdentityLinkAuditConflicts.push({})],
];

describe("decideAccountChange", () => {
	it("grants the target link with the enrollment Identity it records", () => {
		// Act
		const grant = decideAccountChange(subject, allowedFacts());
		// Assert
		expect(grant).toEqual({
			coordinatorId: "c",
			linkId: "l1",
			identityId: "identity",
			issuer: "issuer",
			subject: "account",
			enrollmentIdentityId: "identity",
		});
	});

	it("records a NULL enrollment Identity", () => {
		// Act
		const grant = decide((f) => {
			enrollment(f).identity_id = null;
		});
		// Assert
		expect(grant?.enrollmentIdentityId).toBeNull();
	});

	it.each(denied)("denies %s", (_name, change) => {
		// Act / Assert
		expect(decide(change)).toBeNull();
	});

	it("keeps an enrollment of another Identity with a NULL Identity harmless", () => {
		// Act
		const grant = decide((f) => {
			f.enrollments.push({ ...enrollment(f), group_id: "g2", identity_id: null, enabled: 0 });
		});
		// Assert
		expect(grant).not.toBeNull();
	});

	it("lets this key's own binding waive a legacy contradiction and another Identity's dormant claim", () => {
		// Act
		const grant = decide((f) => {
			f.bindings.push(ownBinding);
			f.claims.splice(0, 1, { ...claim(f), identity_id: "other", active_link: 0 });
			legacy(f).compatible_clear = 0;
		});
		// Assert
		expect(grant?.linkId).toBe("l1");
	});

	it("still denies another Identity's claim whose link is active, even with a binding", () => {
		// Act
		const grant = decide((f) => {
			f.bindings.push(ownBinding);
			f.claims.push({ ...claim(f), claim_id: "x", identity_id: "other", active_link: 1 });
		});
		// Assert
		expect(grant).toBeNull();
	});

	it("accepts a current review in place of a claim, even beside a revoked one", () => {
		// Act
		const grant = decide((f) => {
			f.claims.splice(0);
			f.attestations.push(currentReview, {
				...currentReview,
				attestation_id: "a2",
				group_id: "g2",
				revoked_at: "then",
			});
			link(f).controller_birth = 1;
		});
		// Assert
		expect(grant).not.toBeNull();
	});

	it("ignores a current review while the configuration is disabled", () => {
		// Act
		const grant = decide(
			(f) => {
				f.claims.splice(0);
				f.attestations.push(currentReview);
			},
			{ ...subject, enabled: false },
		);
		// Assert
		expect(grant).toBeNull();
	});

	it("matches the link's own claim without the connection schema", () => {
		// Arrange
		const legacySchema = { ...subject, connections: false };
		// Act
		const own = decide(() => {}, legacySchema);
		const other = decide((f) => {
			link(f).device_claim_id = "another";
		}, legacySchema);
		// Assert
		expect(own).not.toBeNull();
		expect(other).toBeNull();
	});
});

describe("pickAccountChangeTarget", () => {
	it("picks this device's binding first and otherwise the first link in SQL order", () => {
		// Arrange
		const rows = [
			{ link_id: "a", identity_id: "i1", bound: null },
			{ link_id: "b", identity_id: "i2", bound: 0 },
			{ link_id: "c", identity_id: "i3", bound: 1 },
			{ link_id: "d", identity_id: "i4", bound: 1 },
		];
		// Act / Assert
		expect(pickAccountChangeTarget(rows)).toEqual({ identity_id: "i3", target_link_id: "c" });
		expect(pickAccountChangeTarget(rows.slice(0, 2))).toEqual({
			identity_id: "i2",
			target_link_id: "b",
		});
		expect(pickAccountChangeTarget(rows.slice(0, 1))?.target_link_id).toBe("a");
		expect(pickAccountChangeTarget([])).toBeNull();
	});
});

describe("sqlIs", () => {
	it("treats two NULLs as the same and NULL as unlike any value", () => {
		// Act / Assert
		expect(sqlIs(null, null)).toBe(true);
		expect(sqlIs("a", "a")).toBe(true);
		expect(sqlIs("a", null)).toBe(false);
		expect(sqlIs("1", 1)).toBe(false);
	});
});
