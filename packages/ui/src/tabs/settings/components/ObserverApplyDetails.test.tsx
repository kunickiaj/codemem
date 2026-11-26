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
							model: "gpt-6.1-terra",
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
	expect(document.body.textContent).toContain("Simple requests");
	expect(document.body.textContent).toContain("openai · gpt-6-luna");
	expect(document.body.textContent).toContain("Rich requests");
	expect(document.body.textContent).toContain("openai · gpt-6.1-terra");
	expect(document.body.textContent).not.toContain("codex_sidecar");
	const routing = document.querySelector<HTMLDetailsElement>(".observer-routing-details");
	expect(routing?.open).toBe(false);
	expect(routing?.querySelector("summary")?.textContent).toBe("Models in use");
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

function renderTiers(simple: Record<string, unknown>, rich: Record<string, unknown>) {
	const tier = { provider: "openai", model: "gpt-5.6", runtime: "opencode_v2" };
	act(() =>
		render(
			<ObserverApplyDetails
				status={{
					state: "active",
					active: {
						provider: "openai",
						model: "gpt-5.6",
						runtime: "opencode_v2",
						authType: "opencode_v2",
						tierRoutingEnabled: true,
						simple: { ...tier, reasoningEffort: null, ...simple },
						rich: { ...tier, reasoningEffort: null, ...rich },
					},
				}}
				onRetry={vi.fn()}
				onRefresh={vi.fn()}
			/>,
			document.body,
		),
	);
	return [...document.querySelectorAll(".observer-routing-list dd")].map(
		(node) => node.textContent,
	);
}

it("labels the configured effort as requested and shows what was applied", () => {
	const [simple, rich] = renderTiers(
		{
			reasoningEffort: "high",
			appliedReasoning: { effort: "high", requestSucceeded: true, fallbackReason: null },
		},
		{
			reasoningEffort: "max",
			appliedReasoning: {
				effort: null,
				requestSucceeded: true,
				fallbackReason: "variant_not_listed",
			},
		},
	);

	expect(simple).toBe("openai · gpt-5.6 · Requested reasoning: high · Applied: high");
	expect(rich).toBe(
		"openai · gpt-5.6 · Requested reasoning: max · Applied: OpenCode default (model doesn't offer it)",
	);
});

it("shows only the requested effort before a request reports what was applied", () => {
	const [simple, rich] = renderTiers(
		{ reasoningEffort: "high" },
		{
			reasoningEffort: "max",
			appliedReasoning: {
				effort: null,
				requestSucceeded: true,
				fallbackReason: "variant_rejected",
			},
		},
	);

	expect(simple).toBe("openai · gpt-5.6 · Requested reasoning: high");
	expect(rich).toContain("Applied: OpenCode default (OpenCode rejected it)");
});

it("says the last request failed instead of claiming an applied effort", () => {
	const [simple, rich] = renderTiers(
		{
			reasoningEffort: "high",
			appliedReasoning: { effort: null, requestSucceeded: false, fallbackReason: null },
		},
		{
			reasoningEffort: "max",
			appliedReasoning: {
				effort: null,
				requestSucceeded: false,
				fallbackReason: "variant_rejected",
			},
		},
	);

	expect(simple).toBe("openai · gpt-5.6 · Requested reasoning: high · Last request failed");
	expect(rich).toBe("openai · gpt-5.6 · Requested reasoning: max · Last request failed");
	expect(document.body.textContent).not.toContain("Applied");
});
