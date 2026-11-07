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
	// jsdom has no layout observer. Keep the real tooltip events and timers.
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.setSystemTime(new Date("2026-11-02T18:05:00Z"));
	document.body.innerHTML = '<div id="mount"></div>';
});
afterEach(() => {
	act(() => render(null, document.body.firstElementChild as HTMLElement));
	document.body.innerHTML = "";
	vi.useRealTimers();
	vi.unstubAllGlobals();
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

function term(label: string): HTMLButtonElement {
	const button = document.querySelector<HTMLButtonElement>(`[aria-label="About ${label}"]`);
	if (!button) throw new Error(`Missing sync term: ${label}`);
	return button;
}

function hover(target: HTMLElement) {
	const event = new MouseEvent("pointermove", { bubbles: true });
	Object.defineProperty(event, "pointerType", { value: "mouse" });
	act(() => {
		target.dispatchEvent(event);
	});
}

function advanceTime(ms: number) {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
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
		draw(health);
		// Assert
		expect(
			document.querySelectorAll(".device-sync-direction .sync-health-state")[0]?.textContent,
		).toContain("Not verified");
		expect(
			definitions(document.querySelectorAll(".device-sync-direction-details")[0] ?? null)[
				"Acknowledged operations (24h)"
			],
		).toBe("Not recorded");
		expect(
			document.querySelectorAll(".device-sync-direction .sync-health-state")[1]?.textContent,
		).toContain("Exchange succeeded");
		expect(
			definitions(document.querySelectorAll(".device-sync-direction-details")[1] ?? null)[
				"Applied operations (24h)"
			],
		).toBe("7");
		expect(definitions(document.querySelector(".device-sync-direction-details"))).toMatchObject({
			"Acknowledged operations (24h)": "Not recorded",
		});
	});

	it.each([undefined, null])("keeps missing direction evidence unknown (%s)", (health) => {
		// Arrange / Act
		const text = draw(health);
		// Assert
		expect(
			[...document.querySelectorAll(".device-sync-direction .sync-health-state")].map(
				(node) => node.textContent,
			),
		).toEqual(["•Not verified", "•Not verified"]);
		expect(text).not.toMatch(/No operations sent|No operations received|\b0 operations/);
		expect(text).not.toContain("0 pending");
		expect(
			[...document.querySelectorAll(".device-sync-activity")].map((node) => node.textContent),
		).toEqual(["Operations not recorded · Last 24h", "Operations not recorded · Last 24h"]);
	});

	it("distinguishes observed zero activity from absent evidence without inventing a queue", () => {
		// Arrange
		const health: PeerSyncHealth = {
			state: "exchange_succeeded",
			send: { ...success, pending_count: 0 },
			receive: success,
		};
		// Act
		const text = draw(health);
		// Assert
		expect(text).toContain("No operations sent · Last 24h");
		expect(text).toContain("No operations received · Last 24h");
		const details = document.querySelectorAll(".device-sync-direction-details");
		expect(definitions(details[0] ?? null)["Acknowledged operations (24h)"]).toBe("0");
		expect(definitions(details[1] ?? null)["Applied operations (24h)"]).toBe("0");
		expect(text).not.toMatch(/Unknown|pending|Queued for sync/);
		expect(document.querySelector("details")?.textContent).not.toContain(
			"Remote import is not confirmed.",
		);
		expect(
			[...document.querySelectorAll(".device-sync-direction .sync-health-state")].map(
				(node) => node.textContent,
			),
		).toEqual(["•Exchange succeeded", "•Exchange succeeded"]);
	});

	it.each([
		["transfer_failed", "Transfer failed. Check the device connection and retry sync."],
		["snapshot_failed", "Snapshot sync failed. Review sync diagnostics, then retry sync."],
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
		expect(
			document.querySelectorAll(".device-sync-direction .sync-health-state")[1]?.textContent,
		).toContain("Receive failed");
		if (copy) expect(document.querySelector("details")?.textContent).toContain(copy);
		expect(text).not.toContain(reason);
		const failure = document.querySelectorAll(".device-sync-direction .sync-health-state")[1];
		expect(document.querySelector("details")?.open).toBe(false);
		expect(failure?.closest("details")).toBeNull();
		expect(failure?.textContent).toMatch(/failed|rejected/i);
	});
});

describe("zero-activity failures", () => {
	it.each(["send", "receive"] as const)(
		"keeps %s failure visible even when activity is zero",
		(direction) => {
			// Arrange: zero operations describe activity, not successful replication.
			const health: PeerSyncHealth = {
				state: "needs_attention",
				send: success,
				receive: success,
				[direction]: { ...success, state: "needs_attention", reason_code: "snapshot_failed" },
			};
			// Act
			draw(health);
			// Assert
			const metric =
				document.querySelectorAll(".device-sync-direction")[direction === "send" ? 0 : 1];
			expect(metric?.querySelector(".sync-health-state")?.textContent).toContain(
				`${direction === "send" ? "Send" : "Receive"} failed`,
			);
			expect(metric?.querySelector(".device-sync-activity")?.textContent).toContain(
				"No operations",
			);
			expect(metric?.textContent).not.toContain("Exchange succeeded");
			expect(document.querySelector("details")?.textContent).toContain("Snapshot sync failed.");
		},
	);
});

describe("latest attempt failure with historical directional success", () => {
	it.each([success.last_success_at, null])(
		"names the failed attempt without inventing its time (%s)",
		(last_success_at) => {
			// Arrange: aggregate failure has no new directional attempt or success timestamp.
			const historical = { ...success, last_success_at, last_attempt_at: last_success_at };
			const health: PeerSyncHealth = {
				state: "needs_attention",
				send: historical,
				receive: historical,
			};
			// Act
			draw(health);
			// Assert
			const failure = document.querySelector(".device-sync-health > .sync-health-state");
			expect(failure?.textContent).toBe("!Latest sync attempt failed");
			expect(failure?.closest("details")).toBeNull();
			expect(failure?.querySelector("[title], time")).toBeNull();
			expect(document.querySelector("details")?.open).toBe(false);
			expect(
				[...document.querySelectorAll(".device-sync-direction .sync-health-state")].map(
					(node) => node.textContent,
				),
			).toEqual(["•Exchange succeeded", "•Exchange succeeded"]);
			for (const direction of document.querySelectorAll(".device-sync-direction-details")) {
				expect(definitions(direction)).toMatchObject({
					"Last success": last_success_at ? formatTimestamp(last_success_at) : "Not verified",
					"Last attempt": last_success_at ? formatTimestamp(last_success_at) : "Not verified",
				});
			}
		},
	);

	it("removes the aggregate failure after recovery without changing historical success", () => {
		// Arrange
		draw({ state: "needs_attention", send: success, receive: success });
		// Act
		draw({ state: "exchange_succeeded", send: success, receive: success });
		// Assert
		expect(document.body.textContent).not.toContain("Latest sync attempt failed");
		expect(
			document.querySelectorAll(".device-sync-direction[data-state='succeeded']"),
		).toHaveLength(2);
		expect(
			definitions(document.querySelector(".device-sync-direction-details"))["Last success"],
		).toBe(formatTimestamp(success.last_success_at));
	});
});

describe("snapshot and attempt evidence", () => {
	it("keeps compact values in the disclosure without mounting inline definitions", () => {
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
		expect(disclosure?.textContent).not.toMatch(
			/Count definitions|Unique operations|Tracking began|Incoming connections|caught up/,
		);
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		const directions = disclosure?.querySelectorAll(".device-sync-direction-details");
		expect(definitions(directions?.[0] ?? null)).toMatchObject({
			"Snapshot entries (24h)": "Not recorded",
			"Last attempt": "Not verified",
			"Last success": "Not verified",
		});
		expect(definitions(directions?.[1] ?? null)).toMatchObject({
			"Applied operations (24h)": "0",
			"Snapshot entries (24h)": "2",
			"Last success": formatTimestamp(success.last_success_at),
		});
	});

	it.each(["send", "receive"] as const)(
		"preserves each %s state as text outside closed details",
		(direction) => {
			// Arrange: the opposite direction cannot supply this direction's status.
			const label = direction === "send" ? "Send" : "Receive";
			const states = [
				["succeeded", "Exchange succeeded"],
				["stale", "Stale"],
				["needs_attention", `${label} failed`],
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
				expect(metric?.textContent).toContain(label);
				expect(metric?.querySelector(".device-sync-metric-heading")?.textContent).toContain(label);
				expect(metric?.querySelector(".sync-health-state")?.textContent).toContain(copy);
				expect(metric?.querySelector(".device-sync-freshness")?.textContent).toBe(
					"Last success 5m ago",
				);
				expect(metric?.closest("details")).toBeNull();
				expect(metrics[direction === "send" ? 1 : 0]?.textContent).toContain("Not verified");
				expect(document.querySelector(".device-sync-directions")?.textContent).not.toMatch(
					/caught up|up to date/i,
				);
			}
		},
	);
});

describe("disclosure refresh and exact evidence", () => {
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
			expect(
				document.querySelectorAll(".device-sync-direction .sync-health-state")[1]?.textContent,
			).toContain("Receive failed");
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
		expect(document.querySelectorAll(".device-sync-activity")[1]?.textContent).toBe(
			"3 operations · Last 24h",
		);
		expect(
			definitions(document.querySelectorAll(".device-sync-direction-details")[1] ?? null)[
				"Snapshot entries (24h)"
			],
		).toBe(String(snapshots));
		expect(text).not.toContain("15 operations · Last 24h");
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

describe("sync term hover help", () => {
	it("opens a term definition on activation without toggling the native disclosure", () => {
		// Arrange
		draw({ state: "exchange_succeeded", send: success, receive: success });
		const details = document.querySelector("details") as HTMLDetailsElement;
		details.open = true;
		const trigger = term("Acknowledged operations (24h)");
		// Act
		act(() => trigger.click());
		advanceTime(1000);
		// Assert
		const tooltip = document.querySelector('[role="tooltip"]');
		expect(tooltip?.textContent).toContain("Remote import is not confirmed.");
		expect(trigger.getAttribute("aria-describedby")).toBe(tooltip?.id);
		expect(details.open).toBe(true);
		expect(trigger.type).toBe("button");
	});

	it("delays definitions for 700ms and dismisses them with Escape", () => {
		// Arrange: opening details must not open its explanations.
		draw({ state: "exchange_succeeded", send: success, receive: success });
		const details = document.querySelector("details") as HTMLDetailsElement;
		details.open = true;
		const trigger = term("Acknowledged operations (24h)");
		// Act
		hover(trigger);
		advanceTime(699);
		// Assert: transient hover leaves the compact disclosure unchanged.
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(trigger.hasAttribute("aria-describedby")).toBe(false);
		// Act
		advanceTime(1);
		advanceTime(1000);
		// Assert: the explanation remains available after opening effects.
		const tooltip = document.querySelector('[role="tooltip"]');
		expect(tooltip?.textContent).toContain("Remote import is not confirmed.");
		expect(trigger.getAttribute("aria-describedby")).toBe(tooltip?.id);
		expect(details.contains(tooltip)).toBe(false);
		expect(details.textContent).not.toContain("Unique operations");
		// Act
		act(() => {
			trigger.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		advanceTime(1000);
		// Assert
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(trigger.hasAttribute("aria-describedby")).toBe(false);
		expect(details.open).toBe(true);
	});

	it("does not open a definition after the pointer leaves before the delay", () => {
		// Arrange
		draw({ state: "exchange_succeeded", send: success, receive: success });
		const trigger = term("Last successful connection");
		// Act
		hover(trigger);
		advanceTime(699);
		act(() => {
			trigger.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
		});
		advanceTime(1000);
		// Assert
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(trigger.hasAttribute("aria-describedby")).toBe(false);
	});
});

describe("sync term keyboard help", () => {
	it.each([
		[
			"Acknowledged operations (24h)",
			"Unique operations acknowledged by the paired device. Remote import is not confirmed.",
		],
		["Applied operations (24h)", "Unique operations applied on this device."],
		["Snapshot entries (24h)", "Snapshot entries are counted separately from operations."],
		["Last success", "A successful exchange can transfer zero operations."],
		["Last successful connection", "Incoming connections are not recorded."],
	])("exposes the %s explanation through keyboard focus", (label, description) => {
		// Arrange
		draw({ state: "exchange_succeeded", send: success, receive: success });
		const details = document.querySelector("details") as HTMLDetailsElement;
		details.open = true;
		const trigger = term(label);
		// Act
		act(() => trigger.focus());
		advanceTime(1000);
		// Assert
		const tooltip = document.querySelector('[role="tooltip"]');
		expect(tooltip?.textContent).toContain(description);
		expect(trigger.getAttribute("aria-describedby")).toBe(tooltip?.id);
		expect(document.activeElement).toBe(trigger);
		// Act
		act(() => {
			trigger.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		advanceTime(1000);
		// Assert: dismissal must not move focus or collapse the native disclosure.
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		expect(details.open).toBe(true);
	});

	it.each([null, "2026-11-01T18:00:00Z"])(
		"exposes recorded tracking start without inventing a timestamp (%s)",
		(observed_since) => {
			// Arrange
			draw({ state: "exchange_succeeded", send: success, receive: { ...success, observed_since } });
			const details = document.querySelector("details") as HTMLDetailsElement;
			details.open = true;
			// Act
			act(() => term("Applied operations (24h)").focus());
			// Assert
			const text = document.querySelector('[role="tooltip"]')?.textContent;
			expect(text).toContain("Counts cover the last 24 hours since tracking began.");
			expect(text).toContain("Zero does not confirm that devices are caught up.");
			if (observed_since)
				expect(text).toContain(`Tracking began ${formatTimestamp(observed_since)}.`);
			else expect(text).not.toContain("Tracking began");
			expect(details.textContent).not.toContain("Tracking began");
		},
	);
});

describe("last successful connection", () => {
	it.each(["direct", "relay"] as const)(
		"renders recorded %s transport independently of direction state",
		(transport) => {
			// Arrange: a later failure does not invalidate a recorded successful connection.
			const health: PeerSyncHealth = {
				state: "needs_attention",
				send: { ...unknown, state: "needs_attention" },
				receive: success,
				last_successful_connection: { transport, at: success.last_success_at },
			};
			// Act
			draw(health);
			// Assert
			const connection = document.querySelector(".device-sync-connection");
			expect(connection?.querySelector("strong")?.textContent).toBe(
				transport === "direct" ? "Direct" : "Relay",
			);
			expect(connection?.textContent).toContain("Last successful connection");
			expect(connection?.textContent).toContain("5m ago");
			expect(connection?.querySelector("[title]")?.getAttribute("title")).toBe(
				formatTimestamp(success.last_success_at),
			);
			expect(connection?.closest("details")).toBeNull();
			expect(document.querySelector("details")?.textContent).not.toContain("Incoming connections");
		},
	);

	it.each([
		{ label: "legacy payload", connection: undefined, expected: "Not recorded" },
		{
			label: "unknown transport",
			connection: { transport: null, at: success.last_success_at },
			expected: "Not recorded",
		},
		{
			label: "transport without time",
			connection: { transport: "direct" as const, at: null },
			expected: "Direct",
		},
	])("does not invent connection evidence for $label", ({ connection, expected }) => {
		// Arrange
		const health: PeerSyncHealth = {
			state: "exchange_succeeded",
			send: success,
			receive: success,
			last_successful_connection: connection,
		};
		// Act
		draw(health);
		// Assert
		const summary = document.querySelector(".device-sync-connection");
		expect(summary?.querySelector("strong")?.textContent).toBe(expected);
		expect(summary?.querySelector("[title]")).toBeNull();
		expect(summary?.textContent).not.toContain("ago");
	});

	it.each([undefined, null])(
		"clears retained transport when health becomes unavailable (%s)",
		(health) => {
			// Arrange
			draw({
				state: "exchange_succeeded",
				send: success,
				receive: success,
				last_successful_connection: { transport: "relay", at: success.last_success_at },
			});
			// Act
			draw(health);
			// Assert
			const summary = document.querySelector(".device-sync-connection");
			expect(summary?.querySelector("strong")?.textContent).toBe("Not verified");
			expect(summary?.textContent).not.toMatch(/Relay|Direct|ago/);
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
