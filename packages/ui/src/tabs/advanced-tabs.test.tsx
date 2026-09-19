import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAdvancedTabs } from "./advanced-tabs";

describe("mountAdvancedTabs", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});
	it("mounts the Advanced sections", () => {
		const mount = document.createElement("div");
		const onValueChange = vi.fn();
		document.body.appendChild(mount);
		mountAdvancedTabs(mount, "sync", onValueChange);
		expect(mount.querySelectorAll('[role="tab"]')).toHaveLength(2);
		document
			.getElementById("advancedTeamsButton")
			?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
		expect(onValueChange).toHaveBeenCalledWith("teams");
	});
});
