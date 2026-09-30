import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_FORM_STATE } from "../data/constants";
import type { SettingsPanelProps } from "../data/types";
import { ObserverPanel } from "./ObserverPanel";

vi.mock("../../../components/primitives/radix-select", () => ({ RadixSelect: () => null }));

afterEach(() => {
	for (const mount of Array.from(document.body.children)) act(() => render(null, mount));
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

it.each([
	["codex_sidecar", "anthropic", "openai-model"],
	["claude_sidecar", "openai", "anthropic-model"],
])(
	"suggests models for %s rather than the saved %s provider",
	async (runtime, savedProvider, expected) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				json: async () => ({
					models: [
						{ provider: "openai", model: "openai-model" },
						{ provider: "anthropic", model: "anthropic-model" },
					],
				}),
			}),
		);
		const props: SettingsPanelProps = {
			values: { ...EMPTY_FORM_STATE, observerRuntime: "api_http", observerProvider: savedProvider },
			effectiveObserverRuntime: runtime,
			observerMaxCharsDefault: "",
			providerOptions: [],
			showAuthFile: false,
			showAuthCommand: false,
			hiddenUnlessAdvanced: () => true,
			onTextInput: () => vi.fn(),
			onSelectValueChange: () => vi.fn(),
			onSwitchInput: () => vi.fn(),
			getObserverModelLabel: () => "Model",
			getObserverModelTooltip: () => "",
			getObserverModelDescription: () => "",
			getObserverModelHint: () => "",
			protectedConfigHelp: () => "",
		};
		const mount = document.createElement("div");
		document.body.appendChild(mount);
		await act(async () => {
			render(<ObserverPanel {...props} observerStatusBannerSlot={null} />, mount);
		});
		await vi.waitFor(() =>
			expect(
				Array.from(mount.querySelectorAll("datalist option"), (option) =>
					option.getAttribute("value"),
				),
			).toEqual([expected]),
		);
	},
);
