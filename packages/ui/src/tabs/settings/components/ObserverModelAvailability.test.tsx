import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_FORM_STATE } from "../data/constants";
import { ObserverModelAvailability } from "./ObserverModelAvailability";

let mount: HTMLDivElement | null = null;
afterEach(() => {
	if (mount) act(() => render(null, mount as HTMLDivElement));
	mount?.remove();
	mount = null;
	vi.restoreAllMocks();
});

it("shows unverified OpenCode V2 suggestions without offering a paid model check", async () => {
	const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(
			JSON.stringify({
				models: [
					{ provider: "openai", model: "gpt-6-luna" },
					{ provider: "anthropic", model: "claude-sonnet-5-5" },
				],
			}),
		),
	);
	mount = document.createElement("div");
	document.body.appendChild(mount);
	await act(async () =>
		render(
			<ObserverModelAvailability
				id="observerModel"
				values={{ ...EMPTY_FORM_STATE, observerProvider: "openai", observerModel: "gpt-6-luna" }}
			/>,
			mount as HTMLDivElement,
		),
	);
	await vi.waitFor(() => expect(mount?.querySelector('option[value="gpt-6-luna"]')).not.toBeNull());
	expect(mount.textContent).toContain("OpenCode model list; account access is not verified");
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(mount?.querySelector("button")).toBeNull();
	await act(async () =>
		render(
			<ObserverModelAvailability
				id="observerSimpleModel"
				provider="anthropic"
				values={{
					...EMPTY_FORM_STATE,
					observerProvider: "openai",
					observerSimpleModel: "claude-sonnet-5-5",
				}}
			/>,
			mount as HTMLDivElement,
		),
	);
	await vi.waitFor(() =>
		expect(mount?.querySelector('option[value="claude-sonnet-5-5"]')).not.toBeNull(),
	);
	expect(mount?.querySelector('option[value="gpt-6-luna"]')).toBeNull();
	expect(mount?.querySelector("button")).toBeNull();
	expect(fetcher).toHaveBeenCalledTimes(1);
});
