import { describe, expect, it } from "vitest";
import {
	type CoordinatorIdentityGroupGrant,
	compareIdentityGroupGrantRevisions,
} from "./coordinator-identity-group-grant.js";

const grant: CoordinatorIdentityGroupGrant = {
	coordinator_id: "coordinator-a",
	identity_id: "identity-a",
	group_id: "group-a",
	status: "active",
	revision: 1,
	source_kind: "controller_attestation",
	source_receipt_id: "receipt-a",
	created_at: "2026-10-02T12:00:00.000Z",
	revoked_at: null,
};

describe("identity group grant revision snapshot comparison", () => {
	it("matches unordered active and revoked snapshots without mutating them", () => {
		// Arrange: equality of snapshots is not endpoint authorization.
		const tombstone = Object.freeze({
			...grant,
			group_id: "group-b",
			status: "revoked" as const,
			revision: 2,
			revoked_at: "2026-10-03T12:00:00.000Z",
		});
		const expected = Object.freeze([Object.freeze(grant), tombstone]);
		const current = Object.freeze([tombstone, grant]);
		// Act
		const equal = compareIdentityGroupGrantRevisions(expected, current);
		// Assert
		expect(equal).toBe(true);
		expect(expected).toEqual([grant, tombstone]);
		expect(current).toEqual([tombstone, grant]);
	});

	it.each([
		{ revision: 2 },
		{ group_id: "other" },
		{ coordinator_id: "other" },
		{ identity_id: "other" },
		{ source_receipt_id: "other" },
		{ created_at: "2026-10-03T12:00:00.000Z" },
		{ status: "revoked" as const, revision: 2, revoked_at: "2026-10-03T12:00:00.000Z" },
	])("detects changed grant field %j", (change) => {
		// Arrange
		const current = { ...grant, ...change };
		// Act
		const equal = compareIdentityGroupGrantRevisions([grant], [current]);
		// Assert
		expect(equal).toBe(false);
	});

	it.each([
		[],
		[grant, grant],
		[{ ...grant, revision: 0 }],
		[{ ...grant, revision: 1.5 }],
		[{ ...grant, status: "unknown" }],
		[{ ...grant, source_kind: "project_receipt" }],
		[{ ...grant, revoked_at: "unexpected" }],
		[{ ...grant, status: "revoked", revoked_at: null }],
		[{ ...grant, identity_id: "" }],
		[{ ...grant, created_at: "" }],
		[grant, { ...grant, group_id: "group-b", identity_id: "other" }],
	])("rejects malformed or duplicate snapshot %j even when both copies match", (snapshot) => {
		// Arrange: casts deliberately exercise malformed runtime snapshots.
		const rows = snapshot as CoordinatorIdentityGroupGrant[];
		// Act
		const equal = compareIdentityGroupGrantRevisions(rows, rows);
		// Assert
		expect(equal).toBe(false);
	});

	it("rejects unknown groups rather than comparing only a known subset", () => {
		// Arrange
		const expected = [grant];
		const current = [grant, { ...grant, group_id: "unknown-group" }];
		// Act
		const equal = compareIdentityGroupGrantRevisions(expected, current);
		// Assert
		expect(equal).toBe(false);
	});
});
