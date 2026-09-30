import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserverStatusBanner } from "./ObserverStatusBanner";

afterEach(() => {
	act(() => render(null, document.body));
	document.body.innerHTML = "";
});

it("describes sidecar login without incorrectly reporting a missing API token", () => {
	act(() =>
		render(
			<ObserverStatusBanner
				status={{
					active: {
						provider: "openai",
						model: "gpt-6-luna",
						auth: { method: "codex_sidecar", token_present: false },
					},
				}}
			/>,
			document.body,
		),
	);
	expect(document.querySelector(".status-active")?.textContent).toContain("Local Codex session");
	expect(document.querySelector('[aria-label="token missing"]')).toBeNull();
});

it.each(["codex_sidecar", "claude_sidecar", "opencode_v2"])(
	"hides the unrelated credential inventory for %s",
	(method) => {
		act(() =>
			render(
				<ObserverStatusBanner
					status={{
						active: { auth: { method, token_present: false } },
						available_credentials: { openai: { api_key: false } },
					}}
				/>,
				document.body,
			),
		);
		expect(document.querySelector(".status-credentials")).toBeNull();
	},
);

it("keeps other credentials available for direct connections", () => {
	act(() =>
		render(
			<ObserverStatusBanner
				status={{
					active: { auth: { method: "api_direct" } },
					available_credentials: { openai: { api_key: true } },
				}}
			/>,
			document.body,
		),
	);
	const details = document.querySelector<HTMLDetailsElement>(".status-credentials");
	expect(details?.open).toBe(false);
	expect(details?.querySelector("summary")?.textContent).toBe("API keys and saved sign-ins");
	expect(details?.textContent).toContain("openai: API key");
});

it("keeps a missing Direct API key actionable", () => {
	act(() =>
		render(
			<ObserverStatusBanner
				status={{ active: { auth: { method: "none", token_present: false } } }}
			/>,
			document.body,
		),
	);
	expect(document.querySelector(".status-token-warning")?.textContent).toContain(
		"Check your credentials",
	);
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
