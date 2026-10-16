import { describe, expect, vi } from "vitest";
import {
	attempt,
	authorize,
	backendTest,
	snapshot,
} from "./coordinator-auth-link-test-fixtures.js";

describe.each(["SQLite", "D1"] as const)("%s trusted creation Identity pin", (backend) => {
	const test = backendTest(backend);

	test("rejects a pin that differs from the attested Identity without writes", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		// Act
		const result = await f.store.createAuthLinkAttempt(
			attempt({ expectedIdentityId: "identity-b" }),
			f.cfg,
		);
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "controller_not_active" });
		expect(snapshot(f)).toEqual([[], [], []]);
	});

	test("creates with the attested pin but rejects a different pin on retry", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		// Act
		const created = await f.store.createAuthLinkAttempt(
			attempt({ expectedIdentityId: "identity-a" }),
			f.cfg,
		);
		const before = snapshot(f);
		const retry = await f.store.createAuthLinkAttempt(
			attempt({ expectedIdentityId: "identity-b" }),
			f.cfg,
		);
		// Assert
		expect(created).toMatchObject({ kind: "created", identityId: "identity-a" });
		expect(retry).toEqual({ kind: "rejected", error: "attempt_conflict" });
		expect(snapshot(f)).toEqual(before);
	});

	test.for(["inherited", "getter", "malformed", "contradictory device claim"] as const)(
		"rejects %s pins before eligibility without reading getters",
		async (shape, { fixture: f }) => {
			// Arrange
			const input = attempt({ expectedIdentityId: "identity-a" });
			const getter = vi.fn(() => "identity-a");
			if (shape === "inherited") {
				delete input.expectedIdentityId;
				Object.setPrototypeOf(input, { expectedIdentityId: "identity-a" });
			}
			if (shape === "getter") Object.defineProperty(input, "expectedIdentityId", { get: getter });
			if (shape === "malformed") input.expectedIdentityId = " padded ";
			if (shape === "contradictory device claim") {
				input.authority = { kind: "device_claim", identityId: "identity-b" };
				input.browserStartHash = "e".repeat(64);
			}
			// Act
			const result = await f.store.createAuthLinkAttempt(input, f.cfg);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
			expect(snapshot(f)).toEqual([[], [], []]);
			expect(getter).not.toHaveBeenCalled();
		},
	);
});
