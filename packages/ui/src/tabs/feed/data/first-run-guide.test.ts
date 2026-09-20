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
	it.each(["getter", "getItem", "setItem"] as const)(
		"preserves progress, dismissal and reopening when %s throws",
		async (failure) => {
			vi.resetModules();
			const guide = await import("./first-run-guide");
			guide.completeFirstRunStep("capture");
			const fail = () => {
				throw new DOMException("blocked", "SecurityError");
			};
			const spy =
				failure === "getter"
					? vi.spyOn(window, "localStorage", "get").mockImplementation(fail)
					: vi.spyOn(Storage.prototype, failure).mockImplementation(fail);
			try {
				guide.completeFirstRunStep("inspect");
				guide.completeFirstRunStep("find");
				guide.dismissFirstRunGuide();
				expect(guide.shouldShowFirstRunGuide(guide.readFirstRunGuideRecord())).toBe(false);
				guide.reopenFirstRunGuide();
				expect(guide.readFirstRunGuideRecord()).toEqual({
					completed: ["capture", "inspect", "find"],
					dismissed: false,
					showCompleted: true,
				});
			} finally {
				spy.mockRestore();
			}
		},
	);
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

	it("fails open when browser storage is unavailable or malformed", async () => {
		vi.resetModules();
		const guide = await import("./first-run-guide");
		localStorage.setItem(FIRST_RUN_GUIDE_STORAGE_KEY, "not-json");
		expect(guide.readFirstRunGuideRecord()).toMatchObject({ completed: [], dismissed: false });

		const storage = {
			getItem: vi.fn(() => null),
			setItem: vi.fn(() => {
				throw new Error("blocked");
			}),
		} as unknown as Storage;
		expect(() => guide.completeFirstRunStep("find", storage)).not.toThrow();
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
