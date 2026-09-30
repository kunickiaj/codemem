import { expect, it } from "vitest";
import { buildSettingsNotice } from "./notice";

it("reports a saved observer setting as applying rather than already active or restart-required", () => {
	const notice = buildSettingsNotice({
		effects: {
			applying_keys: ["observer_runtime", "observer_model"],
			restart_required_keys: [],
		},
	});
	expect(notice.type).toBe("warning");
	expect(notice.message).toContain("Applying them now; new events will wait");
	expect(notice.message).not.toContain("Applied now");
	expect(notice.message).not.toContain("Restart required");
});

it("mentions restart only when the save response requires one", () => {
	const notice = buildSettingsNotice({ effects: { restart_required_keys: ["observer_model"] } });
	expect(notice.message).toContain("Restart required for observer model");
	const applied = buildSettingsNotice({
		effects: { applying_keys: ["observer_model"], restart_required_keys: [] },
	});
	expect(applied.message).not.toContain("Restart required");
});
