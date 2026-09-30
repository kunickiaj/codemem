import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_FORM_STATE } from "../data/constants";
import type { SettingsPanelProps } from "../data/types";
import { ObserverPanel } from "./ObserverPanel";
import { ProcessingPanel } from "./ProcessingPanel";

vi.mock("../../../components/primitives/radix-select", () => ({ RadixSelect: () => null }));
vi.mock("../../../components/primitives/radix-switch", () => ({ RadixSwitch: () => null }));

afterEach(() => {
	for (const mount of Array.from(document.body.children)) act(() => render(null, mount));
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

it.each([false, true])("shows API-key model catalogs with tier routing %s", async (tiered) => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			json: async () => ({ models: [{ provider: "openai", model: "api-key-model" }] }),
		}),
	);
	const props: SettingsPanelProps = {
		values: {
			...EMPTY_FORM_STATE,
			observerRuntime: "api_key",
			observerProvider: "openai",
			observerTierRoutingEnabled: tiered,
		},
		showTieredRouting: tiered,
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
	await act(async () =>
		render(<ObserverPanel {...props} observerStatusBannerSlot={null} />, mount),
	);
	await vi.waitFor(() => {
		const models = Array.from(mount.querySelectorAll("datalist option"), (option) =>
			option.getAttribute("value"),
		);
		expect(models).toEqual(tiered ? ["api-key-model", "api-key-model"] : ["api-key-model"]);
	});
});

it.each([
	["codex_sidecar", "anthropic", true],
	["claude_sidecar", "openai", true],
	["codex_sidecar", "anthropic", false],
	["claude_sidecar", "openai", false],
])(
	"keeps %s catalogs hidden despite a saved %s provider",
	async (runtime, savedProvider, explicit) => {
		const props: SettingsPanelProps = {
			values: { ...EMPTY_FORM_STATE, observerRuntime: "api_http", observerProvider: savedProvider },
			effectiveObserverRuntime: runtime,
			hasExplicitObserverRuntime: explicit,
			showTieredRouting: true,
			tierProviders: { simple: savedProvider, rich: savedProvider },
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
			render(
				<>
					<ObserverPanel {...props} observerStatusBannerSlot={null} />
					<ProcessingPanel {...props} />
				</>,
				mount,
			);
		});
		expect(mount.querySelector("datalist")).toBeNull();
		expect(props.values.observerProvider).toBe(savedProvider);
	},
);
