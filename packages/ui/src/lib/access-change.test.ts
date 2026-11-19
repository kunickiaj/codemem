import { describe, expect, it } from "vitest";
import { accessChangeRefusalMessage } from "./access-change";
import { friendlyError } from "./form";

describe("accessChangeRefusalMessage", () => {
	it("explains the Viewer's refusal and says nothing changed", () => {
		expect(accessChangeRefusalMessage(new Error("access_change_needs_admin_device"))).toBe(
			"Only a device that holds the coordinator admin secret can change who receives Projects. Nothing changed. Make the change on that device.",
		);
	});

	it("leaves other errors to their callers", () => {
		expect(accessChangeRefusalMessage(new Error("request failed"))).toBeNull();
		expect(accessChangeRefusalMessage("access_change_needs_admin_device")).toBeNull();
	});
});

describe("friendlyError", () => {
	it("explains the Viewer's access-change refusal on screens outside Sharing", () => {
		expect(friendlyError(new Error("access_change_needs_admin_device"), "Failed.")).toBe(
			"Only a device that holds the coordinator admin secret can change who receives Projects. Nothing changed. Make the change on that device.",
		);
	});
});
