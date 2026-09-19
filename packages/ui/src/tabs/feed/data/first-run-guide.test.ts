import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	completeFirstRunStep,
	dismissFirstRunGuide,
	FIRST_RUN_GUIDE_STORAGE_KEY,
	readFirstRunGuideRecord,
	reopenFirstRunGuide,
	shouldShowFirstRunGuide,
} from "./first-run-guide";

beforeEach(() => localStorage.clear());

describe("first-run guide persistence", () => {
	it("records real actions without losing prior completion", () => {
		completeFirstRunStep("capture");
		completeFirstRunStep("inspect");
		completeFirstRunStep("capture");

		expect(readFirstRunGuideRecord().completed).toEqual(["capture", "inspect"]);
	});

	it("hides on dismissal and reopens with completed steps preserved", () => {
		completeFirstRunStep("capture");
		dismissFirstRunGuide();
		expect(shouldShowFirstRunGuide(readFirstRunGuideRecord())).toBe(false);

		reopenFirstRunGuide();
		expect(readFirstRunGuideRecord()).toMatchObject({
			completed: ["capture"],
			dismissed: false,
			showCompleted: true,
		});
	});

	it("fails open when browser storage is unavailable or malformed", () => {
		localStorage.setItem(FIRST_RUN_GUIDE_STORAGE_KEY, "not-json");
		expect(readFirstRunGuideRecord()).toMatchObject({ completed: [], dismissed: false });

		const storage = {
			getItem: vi.fn(() => null),
			setItem: vi.fn(() => {
				throw new Error("blocked");
			}),
		} as unknown as Storage;
		expect(() => completeFirstRunStep("find", storage)).not.toThrow();
	});

	it("hides after all jobs complete unless the user explicitly reopens it", () => {
		for (const step of ["capture", "inspect", "find", "scope", "settings-health"] as const) {
			completeFirstRunStep(step);
		}
		expect(shouldShowFirstRunGuide(readFirstRunGuideRecord())).toBe(false);
		reopenFirstRunGuide();
		expect(shouldShowFirstRunGuide(readFirstRunGuideRecord())).toBe(true);
	});
});
