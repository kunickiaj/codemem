import { expect, vi } from "vitest";
import type {
	CoordinatorIdentityGroupGrantIssueInput,
	CoordinatorIdentityGroupGrantRevokeInput,
	CoordinatorIdentityGroupGrantScope,
} from "./coordinator-identity-group-grant.js";
import type { contractHarness } from "./coordinator-identity-group-grant-test-harness.js";

export function registerGrantInputTests(test: ReturnType<typeof contractHarness>) {
	test.for([
		null,
		[],
		{},
		{ coordinatorId: "", attestationId: "a" },
		{ coordinatorId: "c", attestationId: " padded " },
	])("rejects malformed issuance input %j without writes", async (input, { fixture: f }) => {
		// Arrange
		const before = await f.rows("coordinator_identity_group_grants");
		// Act
		const result = await f.store.issueIdentityGroupGrantFromControllerAttestation(
			input as CoordinatorIdentityGroupGrantIssueInput,
		);
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "invalid_grant_input" });
		expect(await f.rows("coordinator_identity_group_grants")).toEqual(before);
	});
	test("never executes an issuance ID getter or uses inherited authority", async ({
		fixture: f,
	}) => {
		// Arrange
		const getter = vi.fn(() => {
			throw new Error("untrusted getter");
		});
		const input = { coordinatorId: f.review.coordinatorId };
		Object.defineProperty(input, "attestationId", { get: getter });
		// Act
		const accessor = await f.store.issueIdentityGroupGrantFromControllerAttestation(
			input as CoordinatorIdentityGroupGrantIssueInput,
		);
		const inherited = await f.store.issueIdentityGroupGrantFromControllerAttestation(
			Object.create(f.review),
		);
		// Assert
		expect(accessor).toEqual({ kind: "rejected", error: "invalid_grant_input" });
		expect(inherited).toEqual(accessor);
		expect(getter).not.toHaveBeenCalled();
		expect(await f.rows("coordinator_identity_group_grants")).toEqual([]);
	});
	test.for([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, "1", null])(
		"rejects invalid CAS revision %j",
		async (revision, { fixture: f }) => {
			// Arrange
			const input = {
				...f.review,
				expectedRevision: revision,
			} as CoordinatorIdentityGroupGrantRevokeInput;
			// Act
			const revoked = await f.store.revokeIdentityGroupGrant(input);
			// Assert
			expect(revoked).toBe(false);
			expect(await f.rows("coordinator_identity_group_grants")).toEqual([]);
		},
	);
	test("malformed list scope raises an error rather than returning a misleading empty authority set", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = { coordinatorId: f.review.coordinatorId } as CoordinatorIdentityGroupGrantScope;
		// Act
		const pending = f.store.listIdentityGroupGrantRevisions(input);
		// Assert
		await expect(pending).rejects.toThrow("invalid_grant_input");
	});
}
