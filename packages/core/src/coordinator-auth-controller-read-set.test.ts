import { describe, expect, it } from "vitest";
import type { CoordinatorAuthControllerReviewInput } from "./coordinator-auth-controller.js";
import type { ControllerHistorySnapshot } from "./coordinator-auth-controller-history.js";
import {
	controllerReviewReads,
	decideControllerReview,
} from "./coordinator-auth-controller-read-set.js";
import { review } from "./coordinator-auth-store-test-fixtures.js";

const invite = {
	inviteId: "invite-a",
	kind: "team_member" as const,
	actorId: "A",
	assignedIdentityId: "A",
	targetIdentityId: null,
	digest: "c".repeat(64),
};
const inviteRow = ["invite-a", "team_member", "A", "A", null, "c".repeat(64)];
const history = {
	records: [
		{
			group_id: "g",
			candidate_ref: "ref",
			manifest_version: 1,
			completed_at: "t",
			created_at: "t",
			manifest_json: "{}",
		},
	],
	keys: [{ public_key: "key-a", fingerprint: "f".repeat(64) }],
	discoveryKeys: ["key-a"],
} as unknown as ControllerHistorySnapshot;
const historyRows = {
	history: [["g", "ref", 1, "t", "t", "{}"]],
	historyKeys: [["key-a", "f".repeat(64)]],
	historyDiscovery: [["key-a"]],
};
const owner = {
	purpose: "existing_account_owner" as const,
	coordinatorId: "coordinator-a",
	targetIdentityId: "A",
	issuer: "https://issuer.example.test",
	linkId: "link-a",
	authConfigRevision: "r",
	createdAtMs: 1,
};
const allowedOwner = {
	ownerLinks: [{ link_id: "link-a", proven: 1, live: 1 }],
	ownerClaimConflicts: [],
	ownerControllerConflicts: [],
};

function input(
	snapshot: Partial<NonNullable<CoordinatorAuthControllerReviewInput["verifiedSnapshot"]>>,
) {
	return review({ verifiedSnapshot: { enrollmentIdentityId: null, invites: [], ...snapshot } });
}

describe("controller review decision", () => {
	it("allows a review without a snapshot and reads nothing for it", () => {
		expect(decideControllerReview(review(), {})).toBe(true);
		expect(controllerReviewReads(review(), [])).toEqual({});
	});

	it("compares invites as a set, in any order, by every reviewed field", () => {
		const second = { ...invite, inviteId: "invite-b" };
		const secondRow = ["invite-b", ...inviteRow.slice(1)];
		const reviewed = input({ invites: [invite, second] });
		expect(decideControllerReview(reviewed, { invites: [secondRow, inviteRow] })).toBe(true);
		expect(decideControllerReview(reviewed, { invites: [inviteRow] })).toBe(false);
		expect(
			decideControllerReview(reviewed, {
				invites: [inviteRow, [...secondRow.slice(0, 5), "d".repeat(64)]],
			}),
		).toBe(false);
		expect(decideControllerReview(input({}), { invites: [inviteRow] })).toBe(false);
	});

	it.each(Object.keys(historyRows) as (keyof typeof historyRows)[])(
		"refuses when the live %s rows differ from the reviewed history",
		(name) => {
			const reviewed = input({ legacyHistory: history });
			expect(decideControllerReview(reviewed, { invites: [], ...historyRows })).toBe(true);
			expect(
				decideControllerReview(reviewed, {
					invites: [],
					...historyRows,
					[name]: [...historyRows[name], ["extra"]],
				}),
			).toBe(false);
			expect(decideControllerReview(reviewed, { invites: [], ...historyRows, [name]: [] })).toBe(
				false,
			);
		},
	);

	it("allows an owner target only through a proven, live link with no conflicts", () => {
		const reviewed = input({ accountOwnerTarget: owner });
		const decide = (rows: Partial<typeof allowedOwner>) =>
			decideControllerReview(reviewed, { invites: [], ...allowedOwner, ...rows });
		expect(decide({})).toBe(true);
		expect(decide({ ownerLinks: [] })).toBe(false);
		expect(decide({ ownerLinks: [{ link_id: "link-a", proven: 0, live: 1 }] })).toBe(false);
		expect(decide({ ownerLinks: [{ link_id: "link-a", proven: 1, live: 0 }] })).toBe(false);
		expect(decide({ ownerLinks: [{ link_id: "link-a", proven: null, live: 1 }] })).toBe(false);
		expect(decide({ ownerClaimConflicts: [{ claim_id: "c" }] as never[] })).toBe(false);
		expect(decide({ ownerControllerConflicts: [{ attestation_id: "x" }] as never[] })).toBe(false);
	});

	it("needs the enrollment's revocation key to read an owner target", () => {
		const reviewed = input({ accountOwnerTarget: owner });
		expect(() => controllerReviewReads(reviewed, ["g", "d", "k", "f", null, "d", ""])).toThrow(
			"account_owner_authority_unavailable",
		);
		expect(
			Object.keys(controllerReviewReads(reviewed, ["g", "d", "k", "f", null, "d", "kid"])),
		).toEqual(["invites", "ownerLinks", "ownerClaimConflicts", "ownerControllerConflicts"]);
	});
});
