import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FORM_STATE } from "../data/constants";
import type { SettingsPanelProps } from "../data/types";
import { ObserverPanel } from "./ObserverPanel";

vi.mock("../../../components/primitives/radix-select", () => ({
	RadixSelect: ({
		id,
		onValueChange,
		options,
		value,
	}: {
		id?: string;
		onValueChange: (value: string) => void;
		options: Array<{ label: string; value: string }>;
		value: string;
	}) => (
		<select id={id} onChange={(event) => onValueChange(event.currentTarget.value)} value={value}>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	),
}));

let mount: HTMLDivElement | null = null;

function props(): SettingsPanelProps & { observerStatusBannerSlot: null } {
	return {
		values: { ...EMPTY_FORM_STATE, observerRuntime: "api_http" },
		observerMaxCharsDefault: "12000",
		providerOptions: [],
		showAuthFile: false,
		showAuthCommand: false,
		showTieredRouting: false,
		hiddenUnlessAdvanced: () => false,
		onTextInput: () => vi.fn(),
		onSelectValueChange: () => vi.fn(),
		onSwitchInput: () => vi.fn(),
		getObserverModelLabel: () => "Model",
		getObserverModelTooltip: () => "",
		getObserverModelDescription: () => "",
		getObserverModelHint: () => "",
		getTieredRoutingHelperText: () => "",
		protectedConfigHelp: (key) => `${key} is protected`,
		observerStatusBannerSlot: null,
	};
}

afterEach(() => {
	if (mount) {
		act(() => render(null, mount as HTMLDivElement));
		mount.remove();
		mount = null;
	}
	document.body.innerHTML = "";
});

it.each(["claude_sidecar", "codex_sidecar", "api_http"])(
	"keeps the provider editable for automatically resolved %s",
	(runtime) => {
		mount = document.createElement("div");
		document.body.appendChild(mount);
		const base = props();
		const onSelect = vi.fn();
		act(() =>
			render(
				<ObserverPanel
					{...base}
					values={{ ...base.values, observerRuntime: runtime }}
					hasExplicitObserverRuntime={false}
					effectiveObserverRuntime={runtime}
					onSelectValueChange={() => onSelect}
				/>,
				mount as HTMLDivElement,
			),
		);
		expect(mount.querySelector("#observerProvider")).not.toBeNull();
		const select = mount.querySelector<HTMLSelectElement>("#observerRuntime");
		expect(select?.value).toBe("automatic");
		act(() => {
			if (!select) throw new Error("Missing connection mode");
			select.value = runtime;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onSelect).toHaveBeenCalledWith(runtime);
	},
);
describe("ObserverPanel", () => {
	it("shows the provider when authentication previews a direct API connection", () => {
		mount = document.createElement("div");
		document.body.appendChild(mount);
		const base = props();
		act(() =>
			render(
				<ObserverPanel
					{...base}
					values={{ ...base.values, observerRuntime: "codex_sidecar" }}
					effectiveObserverRuntime="api_http"
				/>,
				mount as HTMLDivElement,
			),
		);
		expect(mount.querySelector("#observerProvider")).not.toBeNull();
		expect(mount.querySelector<HTMLSelectElement>("#observerRuntime")?.value).toBe("api_http");
		expect(mount.textContent).not.toContain("Codex chooses the provider");
	});
	it("starts with connection mode and only offers a provider picker on the automatic path", () => {
		mount = document.createElement("div");
		document.body.appendChild(mount);
		const base = { ...props(), providerOptions: [{ label: "anthropic", value: "anthropic" }] };
		const values = { ...base.values, observerProvider: "anthropic" };
		act(() =>
			render(
				<ObserverPanel {...base} values={{ ...values, observerRuntime: "codex_sidecar" }} />,
				mount as HTMLDivElement,
			),
		);
		expect(mount.querySelector("#observerProvider")).toBeNull();
		expect(mount.textContent).toContain("Codex chooses the provider");

		act(() =>
			render(
				<ObserverPanel {...base} values={{ ...values, observerRuntime: "api_http" }} />,
				mount as HTMLDivElement,
			),
		);
		const runtime = mount.querySelector("#observerRuntime");
		const provider = mount.querySelector<HTMLSelectElement>("#observerProvider");
		expect(
			runtime?.compareDocumentPosition(provider as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(provider?.value).toBe("anthropic");
	});

	it("offers a local Codex runtime and shows its protected command", () => {
		mount = document.createElement("div");
		document.body.appendChild(mount);
		act(() => render(<ObserverPanel {...props()} />, mount as HTMLDivElement));

		const runtime = mount.querySelector<HTMLSelectElement>("#observerRuntime");
		expect(runtime?.textContent).toContain("Local Codex session");
		expect(mount.querySelector<HTMLTextAreaElement>("#codexCommand")).not.toBeNull();
		expect(mount.textContent).toContain("codex_command is protected");
	});

	it("mentions pi in observer connection copy", () => {
		mount = document.createElement("div");
		document.body.appendChild(mount);
		act(() => render(<ObserverPanel {...props()} />, mount as HTMLDivElement));

		expect(mount.textContent).toContain("opencode, claude, codex, and pi");
		expect(mount.textContent).toMatch(/pi setup can derive Direct API/i);
		const runtimeHelp = mount.querySelector('[aria-label="About connection mode"]');
		expect(runtimeHelp?.getAttribute("data-tooltip") ?? "").toMatch(/V2-captured sessions/i);
	});

	it("puts connection controls ahead of observer status", () => {
		mount = document.createElement("div");
		document.body.appendChild(mount);
		act(() =>
			render(
				<ObserverPanel
					{...props()}
					observerStatusBannerSlot={<div id="observerStatusBanner">Current connection</div>}
				/>,
				mount as HTMLDivElement,
			),
		);
		const groups = mount.querySelectorAll(".settings-group");
		const status = mount.querySelector("#observerStatusBanner");
		expect(
			groups[0]?.compareDocumentPosition(status as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			groups[1]?.compareDocumentPosition(status as Node) & Node.DOCUMENT_POSITION_PRECEDING,
		).toBeTruthy();
	});
});
