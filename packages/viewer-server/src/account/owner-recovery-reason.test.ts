import { describe, expect, it } from "vitest";
import {
	recoveryFixture,
	recoveryTests,
	selectionFor,
} from "../../test/owner-recovery-service-fixture.js";
import { createAccountOwnerRecoveryService } from "./owner-recovery-service.js";

recoveryTests();
describe("public recovery blocker reasons", () => {
	it.each(["resolution_schema_upgrade_required", "unsupported", "unclassified"])(
		"retains safe needs_review reason %s in the actual group preview",
		async (reason) => {
			// Arrange: retain the real coordinator/subject/history DTO, changing only the blocked boundary response.
			const f = await recoveryFixture();
			const read = f.reviewOwner.getMockImplementation();
			if (!read) throw new Error("Missing real fixture review reader");
			f.reviewOwner.mockImplementation(async (input) => {
				const result = { ...(await read(input)), state: "needs_review", reasons: [reason] };
				Reflect.deleteProperty(result, "owner_resolution_digest");
				return result;
			});
			const service = createAccountOwnerRecoveryService(f.serviceOptions);
			f.cleanup(() => service.close());
			const selection = await selectionFor(service);
			// Act
			const preview = await service.preview({
				...selection,
				requestId: "blocked-reason",
				purpose: "review",
			});
			// Assert: generic freshness text would hide the action the operator needs to take.
			expect(preview.history.complete).toBe(true);
			expect(preview.groupPreviews).toEqual([
				{ groupId: "group-a", action: "blocked", reason: expect.stringContaining(reason) },
			]);
			expect(f.association()).toBeNull();
		},
	);
	it("never copies arbitrary diagnostic fields or unbounded/control-bearing reasons into the public preview", async () => {
		// Arrange
		const f = await recoveryFixture();
		const read = f.reviewOwner.getMockImplementation();
		if (!read) throw new Error("Missing real fixture review reader");
		const secret = "provider-secret-fixture";
		f.reviewOwner.mockImplementation(async (input) => {
			const result = {
				...(await read(input)),
				state: "needs_review",
				reasons: ["resolution_schema_upgrade_required", `SELECT ${secret}\n${"x".repeat(4096)}`],
				providerResponse: secret,
			};
			Reflect.deleteProperty(result, "owner_resolution_digest");
			return result;
		});
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const selection = await selectionFor(service);
		// Act: rejecting the malformed remote DTO or projecting only safe text are both fail-closed.
		const outcome = await service
			.preview({ ...selection, requestId: "unsafe-reason", purpose: "review" })
			.then(
				(preview) => ({ preview }),
				() => ({ preview: null }),
			);
		// Assert
		expect(JSON.stringify(outcome)).not.toContain(secret);
		if (outcome.preview) {
			const reason = outcome.preview.groupPreviews[0]?.reason ?? "";
			expect(reason.length).toBeLessThanOrEqual(1024);
			expect(reason).not.toMatch(/[\r\n]/);
			expect(reason.includes(String.fromCharCode(0))).toBe(false);
			expect(outcome.preview.groupPreviews[0]?.action).toBe("blocked");
		}
		expect(f.association()).toBeNull();
	});
});
