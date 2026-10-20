import { expect, vi } from "vitest";
import { registerOwnerPinTests } from "../../core/src/owner-enrollment-owner-pin-test-harness.js";
import { attempt, ceremonyFixture, exec, NOW, resetCeremony, snapshot } from "./owner-ceremony-test-fixtures.js";

registerOwnerPinTests(async (use) => {
	await resetCeremony();
	const f = await ceremonyFixture();
	const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Live network forbidden"));
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	try {
		await use({ ...f, attempt, exec, snapshot });
		expect(network).not.toHaveBeenCalled();
	} finally { vi.restoreAllMocks(); }
});
