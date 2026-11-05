import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OverallSyncHealth, PeerSyncHealth, SyncDirectionHealth } from "../lib/sync-health";
import { DirectionalSyncHealth, SyncHealthSummary } from "./sync-health";

const unknown: SyncDirectionHealth = {
	state: "not_verified",
	last_attempt_at: null,
	last_success_at: null,
	operations_24h: null,
	pending_count: null,
	reason_code: null,
};
const success: SyncDirectionHealth = {
	...unknown,
	state: "succeeded",
	last_attempt_at: "2026-11-02T18:00:00Z",
	last_success_at: "2026-11-02T18:00:00Z",
	operations_24h: 0,
};

beforeEach(() => {
	document.body.innerHTML = '<div id="mount"></div>';
});
afterEach(() => {
	act(() => render(null, document.body.firstElementChild as HTMLElement));
	document.body.innerHTML = "";
});

function draw(health?: PeerSyncHealth | null) {
	act(() =>
		render(
			<DirectionalSyncHealth health={health} />,
			document.body.firstElementChild as HTMLElement,
		),
	);
	return document.body.textContent ?? "";
}

describe("directional sync evidence", () => {
	it("shows inbound-only applied operations without inventing acknowledged sends", () => {
		// Arrange: inbound requests prove receiving independently of initiated exchanges.
		const health: PeerSyncHealth = {
			state: "not_verified",
			send: unknown,
			receive: { ...success, operations_24h: 7 },
		};
		// Act
		const text = draw(health);
		// Assert
		expect(text).toContain("Sending: Not verified");
		expect(text).toContain("Acknowledged (24h): Not verified");
		expect(text).toContain("Receiving: Exchange succeeded");
		expect(text).toContain("Applied (24h): 7");
		expect(text).toContain("Backlog: Not verified");
	});

	it.each([undefined, null])("keeps missing direction evidence unknown (%s)", (health) => {
		// Arrange / Act
		const text = draw(health);
		// Assert
		expect(text).toContain("Sending: Not verified");
		expect(text).toContain("Receiving: Not verified");
		expect(text).not.toContain("(24h): 0");
		expect(text).not.toContain("0 pending");
	});

	it("distinguishes observed zero activity and pending backlog from unknown backlog", () => {
		// Arrange
		const health: PeerSyncHealth = {
			state: "exchange_succeeded",
			send: { ...success, pending_count: 0 },
			receive: success,
		};
		// Act
		const text = draw(health);
		// Assert
		expect(text).toContain("Acknowledged (24h): 0");
		expect(text).toContain("Applied (24h): 0");
		expect(text).toContain("Backlog: 0 pending");
		expect(text).toContain("Backlog: Not verified");
		expect(
			document
				.querySelector('[title*="Snapshot entries are counted separately"]')
				?.getAttribute("title"),
		).toContain("Acknowledgment does not confirm remote import");
	});

	it.each([
		["transfer_failed", "Transfer failed. Check the device connection and retry sync."],
		[
			"apply_failed",
			"Received operations could not be applied. Review sync diagnostics, then retry.",
		],
		[
			"scope_rejected",
			"Received operations were rejected. Review shared-space access and sync diagnostics.",
		],
		["https://example.test/private?token=secret", null],
	] as const)("renders only safe reason copy for %s", (reason, copy) => {
		// Arrange
		const health: PeerSyncHealth = {
			state: "needs_attention",
			send: unknown,
			receive: { ...unknown, state: "needs_attention", reason_code: reason },
		};
		// Act
		const text = draw(health);
		// Assert
		expect(text).toContain("Receiving: Needs attention");
		if (copy) expect(text).toContain(copy);
		expect(text).not.toContain(reason);
	});
});

describe("snapshot and attempt evidence", () => {
	it.each([0, 12])("keeps %i snapshot entries separate from applied operations", (snapshots) => {
		// Arrange
		const health: PeerSyncHealth = {
			state: "exchange_succeeded",
			send: success,
			receive: { ...success, operations_24h: 3, snapshot_items_24h: snapshots },
		};
		// Act
		const text = draw(health);
		// Assert
		expect(text).toContain("Applied (24h): 3");
		expect(text.includes("Snapshot entries (24h): 12")).toBe(snapshots > 0);
		expect(text).not.toContain("Applied (24h): 15");
	});

	it.each(["succeeded", "needs_attention"] as const)(
		"shows last attempt only when attention is needed (%s)",
		(state) => {
			// Arrange
			const health: PeerSyncHealth = {
				state: "needs_attention",
				send: unknown,
				receive: { ...success, state },
			};
			// Act
			const text = draw(health);
			// Assert
			expect(text.includes("Last attempt:")).toBe(state === "needs_attention");
			expect(text).toContain("Last success:");
		},
	);
});

describe("overall sync summary", () => {
	it.each([
		["exchange_succeeded", "Recent exchange", 0, 0, 0],
		["needs_attention", "Needs attention", 1, 0, 0],
		["not_verified", "Not verified", 0, 1, 0],
		["stale", "Stale", 0, 0, 1],
	] as const)(
		"uses the server's all-peer %s result",
		(state, label, attention, unverified, stale) => {
			// Arrange: one good peer must not override the other peer's evidence.
			const health: OverallSyncHealth = {
				state,
				peer_count: 2,
				attention_count: attention,
				unverified_count: unverified,
				stale_count: stale,
			};
			// Act
			act(() =>
				render(
					<SyncHealthSummary health={health} />,
					document.body.firstElementChild as HTMLElement,
				),
			);
			// Assert
			const status = document.querySelector('[role="status"]');
			expect(status?.textContent).toContain(`Sync: ${label}`);
			expect(status?.textContent).toContain(
				`2 paired devices · ${attention} need attention · ${unverified} not verified · ${stale} stale`,
			);
			expect(status?.textContent).not.toMatch(/caught up|up to date/i);
		},
	);

	it("removes retained success when the refresh is unavailable", () => {
		// Arrange
		const mount = document.body.firstElementChild as HTMLElement;
		const health: OverallSyncHealth = {
			state: "exchange_succeeded",
			peer_count: 1,
			attention_count: 0,
			unverified_count: 0,
			stale_count: 0,
		};
		act(() => render(<SyncHealthSummary health={health} />, mount));
		expect(mount.textContent).toContain("Recent exchange");
		// Act
		act(() => render(<SyncHealthSummary health={health} unavailable />, mount));
		// Assert
		expect(mount.textContent).toContain("Sync: Not verified");
		expect(mount.textContent).toContain("Refresh to check again");
		expect(mount.textContent).not.toContain("Recent exchange");
	});
});
