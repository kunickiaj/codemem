import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTimestamp } from "../lib/format";
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
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-02T18:05:00Z"));
	document.body.innerHTML = '<div id="mount"></div>';
});
afterEach(() => {
	act(() => render(null, document.body.firstElementChild as HTMLElement));
	document.body.innerHTML = "";
	vi.useRealTimers();
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

function definitions(root: ParentNode | null) {
	return Object.fromEntries(
		[...(root?.querySelectorAll("dt") ?? [])].map((term) => [
			term.textContent,
			term.nextElementSibling?.textContent,
		]),
	);
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
		expect(text).toContain("Sent: Not verified");
		expect(text).toContain("Acknowledged operations in 24 hours: Not verified");
		expect(text).toContain("Received: OK");
		expect(text).toContain("Applied operations in 24 hours: 7");
		expect(definitions(document.querySelector(".device-sync-direction-details"))).toMatchObject({
			"Queued for sync": "Unknown",
		});
	});

	it.each([undefined, null])("keeps missing direction evidence unknown (%s)", (health) => {
		// Arrange / Act
		const text = draw(health);
		// Assert
		expect(text).toContain("Sent: Not verified");
		expect(text).toContain("Received: Not verified");
		expect(text).not.toContain("operations in 24 hours: 0");
		expect(text).not.toContain("0 pending");
		expect(
			[...document.querySelectorAll(".device-sync-metric-value strong > [aria-hidden]")].map(
				(node) => node.textContent,
			),
		).toEqual(["—", "—"]);
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
		expect(text).toContain("Acknowledged operations in 24 hours: 0");
		expect(text).toContain("Applied operations in 24 hours: 0");
		const details = document.querySelectorAll(".device-sync-direction-details");
		expect(definitions(details[0] ?? null)["Queued for sync"]).toBe("0 pending");
		expect(definitions(details[1] ?? null)["Queued for sync"]).toBe("Unknown");
		expect(document.querySelector("details")?.textContent).toContain(
			"Acknowledgment does not confirm remote import",
		);
		expect(
			[...document.querySelectorAll(".device-sync-metric-value strong > [aria-hidden]")].map(
				(node) => node.textContent,
			),
		).toEqual(["0", "0"]);
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
		expect(text).toContain("Received: Needs attention");
		if (copy) expect(document.querySelector("details")?.textContent).toContain(copy);
		expect(text).not.toContain(reason);
		const failure = document.querySelector(".device-sync-failure");
		expect(document.querySelector("details")?.open).toBe(false);
		expect(failure?.closest("details")).toBeNull();
		expect(failure?.textContent).toMatch(/failed|rejected/i);
	});
});

describe("snapshot and attempt evidence", () => {
	it("keeps count definitions, tracking coverage and unknown values inside the disclosure", () => {
		// Arrange
		const health: PeerSyncHealth = {
			state: "not_verified",
			send: unknown,
			receive: { ...success, observed_since: "2026-11-01T18:00:00Z", snapshot_items_24h: 2 },
		};
		// Act
		draw(health);
		// Assert: diagnostics remain available without presenting them as verified activity.
		const disclosure = document.querySelector("details");
		expect(disclosure?.textContent).toContain(
			"Sent shows unique operations acknowledged by the peer",
		);
		expect(disclosure?.textContent).toContain("Received shows unique operations applied here");
		expect(disclosure?.textContent).toContain("last 24 hours since tracking began");
		expect(disclosure?.textContent).toContain("Snapshot entries are counted separately");
		const directions = disclosure?.querySelectorAll(".device-sync-direction-details");
		expect(definitions(directions?.[0] ?? null)).toMatchObject({
			"Tracking began": "Not verified",
			"Snapshot entries (24h)": "Not verified",
			"Last attempt": "Not verified",
			"Last success": "Not verified",
		});
		expect(definitions(directions?.[1] ?? null)["Tracking began"]).toBe(
			formatTimestamp(health.receive.observed_since),
		);
	});

	it.each(["send", "receive"] as const)(
		"preserves each %s state as text outside closed details",
		(direction) => {
			// Arrange: the opposite direction cannot supply this direction's status.
			const states = [
				["succeeded", "OK · 5m ago"],
				["stale", "Stale · 5m ago"],
				["needs_attention", "Needs attention"],
				["not_verified", "Not verified"],
			] as const;
			for (const [state, copy] of states) {
				const health: PeerSyncHealth = {
					state: "not_verified",
					send: unknown,
					receive: unknown,
					[direction]: { ...success, state },
				};
				// Act
				draw(health);
				// Assert
				const metrics = document.querySelectorAll(".device-sync-direction");
				const metric = metrics[direction === "send" ? 0 : 1];
				expect(metric?.textContent).toContain(direction === "send" ? "Sent" : "Received");
				expect(metric?.querySelector(".device-sync-metric-heading")?.textContent).toContain(
					"Last 24h",
				);
				expect(metric?.querySelector(".device-sync-freshness")?.textContent).toBe(copy);
				expect(metric?.closest("details")).toBeNull();
				expect(metrics[direction === "send" ? 1 : 0]?.textContent).toContain("Not verified");
				expect(document.body.textContent).not.toMatch(/caught up|up to date/i);
			}
		},
	);

	it.each([false, true])(
		"preserves user disclosure state and focus through refresh (open=%s)",
		(open) => {
			// Arrange: no controlled open prop or focus effect may reset the native disclosure.
			draw({ state: "exchange_succeeded", send: success, receive: success });
			const details = document.querySelector("details") as HTMLDetailsElement;
			const summary = details.querySelector("summary") as HTMLElement;
			expect(details.open).toBe(false);
			expect(summary.textContent).toBe("Sync details");
			details.open = open;
			summary.focus();
			// Act
			draw({
				state: "needs_attention",
				send: success,
				receive: { ...unknown, state: "needs_attention" },
			});
			// Assert
			expect(document.querySelector("details")).toBe(details);
			expect(details.open).toBe(open);
			expect(document.activeElement).toBe(summary);
			expect(document.querySelector(".device-sync-failure")?.textContent).toContain(
				"Exchange failed",
			);
		},
	);

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
		expect(text).toContain("Applied operations in 24 hours: 3");
		expect(
			definitions(document.querySelectorAll(".device-sync-direction-details")[1] ?? null)[
				"Snapshot entries (24h)"
			],
		).toBe(String(snapshots));
		expect(text).not.toContain("Applied operations in 24 hours: 15");
	});

	it.each(["succeeded", "needs_attention"] as const)(
		"retains exact success and attempt timestamps inside details (%s)",
		(state) => {
			// Arrange
			const health: PeerSyncHealth = {
				state: "needs_attention",
				send: unknown,
				receive: { ...success, state },
			};
			// Act
			draw(health);
			// Assert
			const detail = document.querySelectorAll("details .device-sync-direction-details")[1] ?? null;
			expect(definitions(detail)).toMatchObject({
				"Last attempt": formatTimestamp(success.last_attempt_at),
				"Last success": formatTimestamp(success.last_success_at),
			});
		},
	);
});

describe("overall sync summary", () => {
	it.each([undefined, null])("hides invented counts without a payload (%s)", (health) => {
		// Arrange
		const mount = document.body.firstElementChild as HTMLElement;
		// Act
		act(() => render(<SyncHealthSummary health={health} />, mount));
		// Assert
		expect(mount.querySelector(".sync-health-kpis")).toBeNull();
		expect(mount.textContent).toContain("Refresh to check sync");
		expect(mount.textContent).not.toMatch(/\bOK\b|caught up|up to date/i);
	});

	it.each([
		["disabled", "Sync off", "Turn on sync", false],
		["no_peers", "No paired devices", "Pair a device", true],
	] as const)("handles %s without claiming an exchange", (state, label, guidance, counts) => {
		// Arrange
		const health: OverallSyncHealth = {
			state,
			peer_count: 0,
			attention_count: 0,
			unverified_count: 0,
			stale_count: 0,
		};
		const mount = document.body.firstElementChild as HTMLElement;
		// Act
		act(() => render(<SyncHealthSummary health={health} />, mount));
		// Assert
		expect(mount.querySelector(".sync-health-state")?.textContent).toContain(label);
		expect(mount.textContent).toContain(guidance);
		expect(mount.querySelector(".sync-health-kpis") !== null).toBe(counts);
		if (counts) expect(definitions(mount)["Paired devices"]).toBe("0");
		expect(mount.textContent).not.toMatch(/\bOK\b|Recent checks passed|caught up|up to date/i);
	});

	it.each([
		["exchange_succeeded", "OK", 0, 0, 0],
		["needs_attention", "Sync needs attention", 1, 0, 0],
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
			expect(status?.querySelector(".sync-health-state")?.textContent).toContain(label);
			expect(definitions(status)).toEqual({
				"Paired devices": "2",
				"Need attention": String(attention),
				"Not verified": String(unverified),
			});
			expect(status?.textContent?.includes(`${stale} stale devices.`)).toBe(stale > 0);
			expect(status?.textContent).not.toMatch(/Backlog|Queued for sync/);
			expect(status?.querySelector(".sync-health-coverage")?.textContent).toContain(
				"Activity · Last 24h",
			);
			if (attention > 0) {
				expect(status?.textContent).toContain("Review device sync details");
				expect(status?.textContent).not.toContain("Sync service issue");
			}
			expect(status?.textContent).not.toMatch(/caught up|up to date/i);
		},
	);

	it.each([0, 3])("directs service attention to diagnostics with %i paired devices", (peers) => {
		// Arrange: service failures do not imply that a peer exchange failed.
		const health: OverallSyncHealth = {
			state: "needs_attention",
			peer_count: peers,
			attention_count: 0,
			unverified_count: 0,
			stale_count: 0,
		};
		const mount = document.body.firstElementChild as HTMLElement;
		// Act
		act(() => render(<SyncHealthSummary health={health} />, mount));
		// Assert
		expect(mount.querySelector(".sync-health-state")?.textContent).toContain(
			"Sync needs attention",
		);
		expect(mount.textContent).toContain("Sync service issue · Diagnostics in Advanced");
		expect(mount.textContent).not.toContain("Review device sync details");
		expect(definitions(mount)).toEqual({
			"Paired devices": String(peers),
			"Need attention": "0",
			"Not verified": "0",
		});
	});

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
		expect(mount.textContent).toContain("OK");
		// Act
		act(() => render(<SyncHealthSummary health={health} unavailable />, mount));
		// Assert
		expect(mount.querySelector(".sync-health-state")?.textContent).toContain("Not verified");
		expect(mount.querySelector(".sync-health-kpis")).toBeNull();
		expect(mount.textContent).toContain("Refresh to check sync");
		expect(mount.textContent).not.toContain("OK");
	});
});
