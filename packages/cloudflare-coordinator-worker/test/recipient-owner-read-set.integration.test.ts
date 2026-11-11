import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	exec,
	producer,
	reset,
	retain,
	state,
	timestamp,
} from "./owner-producer-consistency-test-fixtures.js";

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await reset();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// Native D1 runs the recipient's retained-ownership reads and the guards that lead its
// token batch. A change only the negative owner reads select refuses the invite there too:
// a retained resolution change aborts the batch, and a legacy completion naming the
// device leaves it a no-op, as the old pin in the token update did, so the unbound invite
// is then refused as already bound.
for (const fact of ["retained resolution", "legacy completion"] as const) {
	it(`native D1 refuses a recipient invite when a ${fact} changes before the write`, async () => {
		// Arrange
		const p = await producer("team_member");
		await retain(p.subject);
		p.h.arm(async () => {
			if (fact === "legacy completion")
				await exec(
					"INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES ('raced-group','raced-candidate',1,?,?,?)",
					`not json ${JSON.stringify(p.subject.deviceId)}`,
					timestamp,
					timestamp,
				);
			else
				await exec(
					"INSERT INTO coordinator_legacy_owner_resolutions SELECT coordinator_id,'raced-resolution',resolution_version,device_id,key_id,owner_identity_id,purpose,scope,source_attestation_id,source_group_id,source_controller_revision,source_public_key,source_fingerprint,source_enrollment_identity_id,source_created_at,source_review_receipt_id,source_evidence_digest,resolution_evidence_digest,reviewed_weak_labels_json,created_at FROM coordinator_legacy_owner_resolutions LIMIT 1",
				);
		});
		// Act
		const outcome = await p.run().catch((error: unknown) => error);
		// Assert
		expect(p.h.observed()).toBe(true);
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toBe(
			fact === "retained resolution"
				? "device_ownership_authorization_unavailable"
				: "invite_already_bound",
		);
		expect(await state()).toEqual(p.h.afterMutation());
	});
}
