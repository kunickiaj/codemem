import { describe, expect, it } from "vitest";
import {
	explainScopeMembershipRevocation,
	scopeMembershipEpochStatus,
} from "./scope-membership-semantics.js";

describe("scope membership semantics", () => {
	it("classifies stale, current, and unknown membership epochs", () => {
		expect(scopeMembershipEpochStatus({ membershipEpoch: 2, requiredEpoch: 3 })).toEqual({
			membership_epoch: 2,
			required_epoch: 3,
			stale: true,
			reason: "stale_epoch",
		});
		expect(scopeMembershipEpochStatus({ membershipEpoch: 3, requiredEpoch: 3 })).toEqual({
			membership_epoch: 3,
			required_epoch: 3,
			stale: false,
			reason: "current",
		});
		expect(scopeMembershipEpochStatus({ membershipEpoch: null, requiredEpoch: 3 })).toEqual({
			membership_epoch: null,
			required_epoch: 3,
			stale: false,
			reason: "unknown_epoch",
		});
	});

	it("explains revocation limits without promising remote deletion", () => {
		expect(
			explainScopeMembershipRevocation({
				scopeId: "scope-acme",
				deviceId: "device-a",
				membershipEpoch: 4,
			}),
		).toEqual({
			scope_id: "scope-acme",
			device_id: "device-a",
			membership_epoch: 4,
			prevents_future_sync: true,
			deletes_already_copied_data: false,
			message:
				"Revocation prevents future sync only; it does not remove data already copied to the revoked device.",
		});
	});
});
