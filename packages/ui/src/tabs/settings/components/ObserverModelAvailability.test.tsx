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

it("labels catalog suggestions as unverified and checks only after a click", async () => {
	const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, options) => {
		if (String(request).endsWith("/api/observer-model-catalog")) {
			return new Response(
				JSON.stringify({ models: [{ provider: "openai", model: "gpt-6-luna" }] }),
			);
		}
		expect(options?.method).toBe("POST");
		return new Response(JSON.stringify({ available: true, status: "verified" }));
	});
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
	expect(mount.textContent).toContain("Catalog suggestions are unverified");
	await vi.waitFor(() => expect(mount?.querySelector('option[value="gpt-6-luna"]')).not.toBeNull());
	expect(fetcher).toHaveBeenCalledTimes(1);
	await act(async () => mount?.querySelector<HTMLButtonElement>("button")?.click());
	expect(fetcher).toHaveBeenCalledTimes(2);
	await vi.waitFor(() => expect(mount?.textContent).toContain("Verified with a request"));
});
