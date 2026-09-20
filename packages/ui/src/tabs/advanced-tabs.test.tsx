import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAdvancedTabs } from "./advanced-tabs";

describe("mountAdvancedTabs", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});
	it("mounts the Advanced sections", () => {
		const mount = document.createElement("div");
		const syncPanel = document.createElement("div");
		syncPanel.id = "advancedSyncContent";
		const teamsPanel = document.createElement("div");
		teamsPanel.id = "advancedTeamsContent";
		const onValueChange = vi.fn();
		document.body.append(mount, syncPanel, teamsPanel);
		mountAdvancedTabs(mount, "sync", onValueChange);
		expect(mount.querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(document.getElementById("advancedSyncButton")?.getAttribute("aria-controls")).toBe(
			"advancedSyncContent",
		);
		expect(document.getElementById("advancedTeamsButton")?.getAttribute("aria-controls")).toBe(
			"advancedTeamsContent",
		);
		document
			.getElementById("advancedTeamsButton")
			?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
		expect(onValueChange).toHaveBeenCalledWith("teams", { focusContent: true });
	});
});
