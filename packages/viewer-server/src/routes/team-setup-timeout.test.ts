import { describe, expect, it } from "vitest";
import { remainingCoordinatorTimeoutS } from "./team-setup.js";

describe("legacy Team completion coordinator timeout", () => {
	it("caps each publication at the shared remaining budget", () => {
		expect(remainingCoordinatorTimeoutS(30, 20_000, 10_000)).toBe(10);
		expect(remainingCoordinatorTimeoutS(3, 20_000, 10_000)).toBe(3);
		expect(remainingCoordinatorTimeoutS(3, 10_050, 10_000)).toBe(0.1);
	});

	it("stops publication after the shared deadline", () => {
		expect(remainingCoordinatorTimeoutS(3, 10_000, 10_000)).toBeNull();
		expect(remainingCoordinatorTimeoutS(3, 10_000, 10_001)).toBeNull();
	});
});
