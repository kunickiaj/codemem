import { afterEach, describe, expect, it } from "vitest";
import { state } from "../../../../lib/state";
import { renderSyncAttempts, shouldShowSyncAttemptRedactionHint } from "./sync-attempts";

afterEach(() => {
	document.body.innerHTML = "";
	localStorage.clear();
	state.lastSyncAttempts = [];
	state.lastSyncPeers = [];
	state.lastSyncStatus = null;
});

describe("shouldShowSyncAttemptRedactionHint", () => {
	it("shows the reveal hint only for explicitly redacted attempt errors", () => {
		expect(
			shouldShowSyncAttemptRedactionHint(
				{
					error_redacted: true,
				},
				true,
			),
		).toBe(true);
	});

	it("does not show the reveal hint for unredacted generic-looking errors", () => {
		expect(
			shouldShowSyncAttemptRedactionHint(
				{
					error_redacted: false,
				},
				true,
			),
		).toBe(false);
		expect(
			shouldShowSyncAttemptRedactionHint(
				{
					error_redacted: true,
				},
				false,
			),
		).toBe(false);
	});
});

describe("renderSyncAttempts", () => {
	it("links redacted failed attempts to the Advanced diagnostics redaction setting", () => {
		document.body.innerHTML = `<div id="syncAttempts"></div>`;
		state.lastSyncAttempts = [
			{
				status: "error",
				peer_device_id: "peer-device-123456",
				error: "sync attempt failed; enable diagnostics for details",
				error_redacted: true,
				started_at: "2026-06-11T17:00:00.000Z",
			},
		];

		renderSyncAttempts();

		const link = document.querySelector<HTMLAnchorElement>('a[href="#sync/diagnostics"]');
		expect(document.body.textContent).toContain(
			"Turn off Redact in Advanced diagnostics to reveal the full error.",
		);
		expect(link?.textContent).toBe("Open Advanced diagnostics Redact setting");
	});
});
