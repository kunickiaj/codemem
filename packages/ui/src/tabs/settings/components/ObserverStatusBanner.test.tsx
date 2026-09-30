import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserverStatusBanner } from "./ObserverStatusBanner";

afterEach(() => {
	act(() => render(null, document.body));
	document.body.innerHTML = "";
});

describe("ObserverStatusBanner diagnostics action", () => {
	it("keeps direct API credentials out of the way for a local Codex session", () => {
		act(() =>
			render(
				<ObserverStatusBanner
					status={{
						active: {
							provider: "openai",
							model: "sample-model",
							auth: { method: "codex_sidecar", token_present: false },
						},
						available_credentials: { openai: { api_key: false } },
					}}
				/>,
				document.body,
			),
		);

		const details = document.querySelector<HTMLDetailsElement>(".status-credentials");
		expect(document.querySelector(".status-active")?.textContent).toContain("Local Codex session");
		expect(document.querySelector('[aria-label="token missing"]')).toBeNull();
		expect(details?.open).toBe(false);
		expect(details?.querySelector("summary")?.textContent).toBe("Direct API credentials");
		expect(details?.textContent).toContain("Local sessions use their CLI login");
		expect(details?.textContent).toContain("openai: none");
	});

	it("puts a processing issue ahead of passive connection details", () => {
		act(() =>
			render(
				<ObserverStatusBanner
					status={{
						active: { provider: "openai", auth: { method: "codex_sidecar" } },
						latest_failure: { error_message: "Request failed" },
					}}
				/>,
				document.body,
			),
		);

		const issue = document.querySelector(".status-issue");
		const connection = document.querySelector(".status-active");
		expect(issue?.textContent).toContain("Request failed");
		expect(
			issue?.compareDocumentPosition(connection as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

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
