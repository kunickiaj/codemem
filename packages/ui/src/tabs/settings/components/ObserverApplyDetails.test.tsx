import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { ObserverApplyDetails } from "./ObserverApplyDetails";

afterEach(() => {
	act(() => render(null, document.body));
	document.body.innerHTML = "";
});

it("shows active simple and rich models separately without claiming account availability", () => {
	act(() =>
		render(
			<ObserverApplyDetails
				status={{
					state: "active",
					active: {
						provider: "openai",
						model: "gpt-6-luna",
						runtime: "codex_sidecar",
						authType: "codex_sidecar",
						tierRoutingEnabled: true,
						simple: {
							provider: "openai",
							model: "gpt-6-luna",
							runtime: "codex_sidecar",
							reasoningEffort: null,
						},
						rich: {
							provider: "openai",
							model: "gpt-5.6-terra",
							runtime: "codex_sidecar",
							reasoningEffort: null,
						},
					},
				}}
				onRetry={vi.fn()}
				onRefresh={vi.fn()}
			/>,
			document.body,
		),
	);
	expect(document.body.textContent).toContain("Simple: openai / gpt-6-luna");
	expect(document.body.textContent).toContain("Rich: openai / gpt-5.6-terra");
	expect(document.body.textContent).toContain("may be unavailable to the active account");
});

it("makes a saved-but-failed application actionable", () => {
	const retry = vi.fn();
	act(() =>
		render(
			<ObserverApplyDetails
				status={{
					state: "failed",
					message: "Observer settings were saved but could not be applied.",
				}}
				onRetry={retry}
				onRefresh={vi.fn()}
			/>,
			document.body,
		),
	);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"saved but could not be applied",
	);
	const button = [...document.querySelectorAll("button")].find((node) =>
		node.textContent?.includes("Retry applying"),
	);
	act(() => button?.click());
	expect(retry).toHaveBeenCalledOnce();
});
