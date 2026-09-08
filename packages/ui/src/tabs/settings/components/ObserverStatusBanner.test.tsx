import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserverStatusBanner } from "./ObserverStatusBanner";

afterEach(() => {
	act(() => render(null, document.body));
	document.body.innerHTML = "";
});

describe("ObserverStatusBanner diagnostics action", () => {
	it("offers a contextual action for a processing failure without forwarding raw error text", () => {
		const onOpenDiagnostics = vi.fn();
		act(() =>
			render(
				<ObserverStatusBanner
					onOpenDiagnostics={onOpenDiagnostics}
					status={{ latest_failure: { error_message: "private provider response" } }}
				/>,
				document.body,
			),
		);
		const action = document.querySelector<HTMLButtonElement>("button");
		if (!action) throw new Error("observer diagnostics action missing");

		act(() => action.click());

		expect(onOpenDiagnostics).toHaveBeenCalledWith({
			severity: "error",
			subsystem: "observer",
		});
		expect(JSON.stringify(onOpenDiagnostics.mock.calls)).not.toContain("private provider response");
	});
});
