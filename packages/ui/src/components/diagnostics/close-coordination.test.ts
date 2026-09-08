import { expect, it, vi } from "vitest";
import { closeDiagnosticsDrawer } from ".";

it("runs coordinated modal work after the diagnostics close turn", async () => {
	const afterClose = vi.fn();

	closeDiagnosticsDrawer(afterClose);

	expect(afterClose).not.toHaveBeenCalled();
	await Promise.resolve();
	expect(afterClose).toHaveBeenCalledOnce();
});
