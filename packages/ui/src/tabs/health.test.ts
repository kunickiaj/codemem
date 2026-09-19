import type { ComponentChildren } from "preact";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../lib/api";
import * as api from "../lib/api";
import type {
	CachedStatsPayload,
	CachedUsagePayload,
	UsageEventSummary,
	UsageTotals,
} from "../lib/state";
import { beginHealthLoad, completeHealthLoad, healthNotLoaded, state } from "../lib/state";
import {
	markHealthStatusUnchecked,
	renderHealthOverview,
	renderSessionSummary,
	renderStats,
} from "./health";
import { renderAutomaticRecall } from "./health/components";
import { loadHealthData } from "./health/lifecycle";

vi.mock("../components/primitives/tooltip", () => ({
	Tooltip: ({ children, label }: { children?: ComponentChildren; label?: string }) =>
		h("span", { "data-tooltip": label }, children),
	TooltipProvider: ({ children }: { children?: unknown }) => children,
}));

const availableStatus: UpdateStatus = {
	current_version: "0.40.2",
	channel: "latest",
	latest_version: "0.41.0",
	update_available: true,
	first_seen_at: "2026-08-10T12:00:00.000Z",
	checked_at: "2026-08-10T12:00:00.000Z",
	stale: false,
	install_kind: "npm-global",
	auto_update_eligible: false,
	recommended_action: "npm install -g codemem@0.41.0 @codemem/embeddings@0.41.0",
	error: null,
};

const usageTotals: UsageTotals = {
	tokens_read: 0,
	tokens_written: 0,
	tokens_saved: 0,
	count: 0,
	token_unit: "tokens",
	measured_count: 0,
	estimated_count: 0,
	unavailable_count: 0,
	legacy_text_length_count: 0,
	legacy_unclassified_count: 0,
};

function usageEvent(overrides: Partial<UsageEventSummary>): UsageEventSummary {
	return {
		event: "pack",
		count: 0,
		total_tokens_read: 0,
		total_tokens_written: 0,
		total_tokens_saved: 0,
		token_unit: "tokens",
		measured_count: 0,
		estimated_count: 0,
		unavailable_count: 0,
		legacy_text_length_count: 0,
		legacy_unclassified_count: 0,
		...overrides,
	};
}

function statsPayload(overrides: Partial<CachedStatsPayload> = {}): CachedStatsPayload {
	return {
		automatic_recall: null,
		database: {
			path: "/home/example/.codemem/codemem.db",
			size_bytes: 2_000_000,
			active_memory_items: 0,
			vector_coverage: 0,
			tags_coverage: 0,
		},
		maintenance_jobs: [],
		...overrides,
	};
}

function usagePayload(overrides: Partial<CachedUsagePayload> = {}): CachedUsagePayload {
	return {
		events: [],
		events_global: [],
		events_filtered: null,
		totals: usageTotals,
		totals_global: usageTotals,
		totals_filtered: null,
		recent_packs: [],
		...overrides,
	};
}

function setUpdateStatus(status: UpdateStatus | null): void {
	state.lastUpdateStatus = status;
}

function mockSuccessfulHealthReads(): void {
	vi.spyOn(api, "loadStats").mockResolvedValue(statsPayload());
	vi.spyOn(api, "loadUsage").mockResolvedValue(usagePayload());
	vi.spyOn(api, "loadSession").mockResolvedValue({
		total: 5,
		memories: 2,
		artifacts: 1,
		prompts: 2,
		observations: 2,
	});
	vi.spyOn(api, "loadRawEvents").mockResolvedValue({ pending: 0, sessions: 0 });
}

function renderOverview(): void {
	act(() => renderHealthOverview());
}

function updateBannerText(): string {
	return document.getElementById("healthUpdateBanner")?.textContent ?? "";
}

function expectStaleHealthMeta(): void {
	const healthMeta = document.getElementById("healthMeta");
	expect(healthMeta?.textContent).toContain("Stale data");
	const staleBadge = document.querySelector("#healthStatus .badge");
	expect(staleBadge?.textContent).toBe("Stale data");
}

beforeEach(() => {
	// Arrange shared Health DOM and otherwise healthy state.
	document.body.innerHTML = `
		<div id="healthUpdateBanner"></div>
		<div id="healthGrid"></div>
		<div id="automaticRecallStats"></div>
		<div id="healthStatus"><div id="healthMeta" role="status" aria-live="polite" aria-atomic="true"></div></div>
		<div id="healthActions"></div>
		<div id="healthDot"></div>
		<div id="statsGrid"></div>
		<div id="metaLine"></div>
		<div id="sessionGrid"></div>
		<div id="sessionMeta"></div>
	`;
	state.healthStats = completeHealthLoad(statsPayload());
	state.healthUsage = completeHealthLoad(usagePayload());
	state.healthSession = completeHealthLoad({
		total: 0,
		memories: 0,
		artifacts: 0,
		prompts: 0,
		observations: 0,
	});
	state.healthRawEvents = completeHealthLoad({ pending: 0, sessions: 0 });
	state.currentProject = "";
	state.lastSyncStatus = { enabled: false, daemon_state: "disabled" };
	state.lastSyncPeers = [];
});

it("marks the global Health indicator as unchecked when details are not loading", () => {
	const metaLine = document.getElementById("metaLine");
	state.healthStats = completeHealthLoad(
		statsPayload({
			database: {
				...statsPayload().database,
				path: "/home/example/.codemem/codemem.db",
				size_bytes: 2_000_000,
			},
		}),
	);
	renderStats();
	expect(metaLine?.textContent).toContain("codemem.db");
	markHealthStatusUnchecked();

	expect(document.getElementById("healthDot")?.className).toBe("health-dot status-unknown");
	expect(document.getElementById("healthDot")?.title).toBe("Open Health to check status");
	expect(metaLine?.textContent).toBe("");

	renderStats();
	expect(metaLine?.textContent).toContain("codemem.db");
});

it("animates loading while a stable announcer reports loading and completion", () => {
	state.healthStats = { status: "loading", previous: null, previousStatus: null };

	renderOverview();
	const announcer = document.getElementById("healthMeta");
	expect(announcer?.textContent).toBe("Loading health data…");
	expect(announcer?.getAttribute("role")).toBe("status");
	expect(announcer?.getAttribute("aria-live")).toBe("polite");
	expect(announcer?.getAttribute("aria-atomic")).toBe("true");
	expect(document.querySelector("#healthGrid [role='status']")).toBeNull();
	expect(document.querySelector("#healthStatus .presence-pip--syncing")).not.toBeNull();

	state.healthStats = completeHealthLoad(statsPayload());
	renderOverview();

	expect(document.getElementById("healthMeta")).toBe(announcer);
	expect(announcer?.textContent).toBe("0 issues");
	expect(document.querySelector("#healthGrid [role='status']")).toBeNull();
});

it("renders the four compact health tiles in contract order", () => {
	renderOverview();

	const tiles = [...document.querySelectorAll("#healthGrid .health-tile")];
	expect(tiles.map((tile) => tile.querySelector(".health-tile-label")?.textContent)).toEqual([
		"Pipeline",
		"Sync",
		"Retrieval",
		"Data freshness",
	]);
	expect(tiles.map((tile) => tile.querySelector(".health-tile-value")?.textContent)).toEqual([
		"Queue clear",
		"Off",
		"No packs yet",
		"No packs yet",
	]);
	expect(
		tiles.every(
			(tile) =>
				(tile
					.querySelector<HTMLElement>(".presence-pip")
					?.style.getPropertyValue("--presence-pip-size") ?? "") === "6px",
		),
	).toBe(true);
	expect(
		document
			.querySelector<HTMLElement>("#healthStatus .presence-pip")
			?.style.getPropertyValue("--presence-pip-size"),
	).toBe("8px");
	expect(document.querySelector("#healthGrid .stat")).toBeNull();
});

it("marks pending pipeline work and the current sync problem as degraded", () => {
	state.healthRawEvents = completeHealthLoad({ pending: 3, sessions: 1 });
	state.lastSyncStatus = { enabled: true, daemon_state: "stopped" };

	renderOverview();

	const values = [...document.querySelectorAll("#healthGrid .health-tile-value")];
	expect(values[0]?.textContent).toBe("3 pending");
	expect(values[0]?.querySelector(".presence-pip--degraded")).not.toBeNull();
	expect(values[1]?.textContent).toBe("Stopped");
	expect(values[1]?.querySelector(".presence-pip--degraded")).not.toBeNull();
});

it("marks pipeline reliability failures when the queue is clear", () => {
	state.healthStats = completeHealthLoad(
		statsPayload({
			reliability: {
				counts: { errored_batches: 0 },
				rates: { flush_success_rate: 0.8, dropped_event_rate: 0.03 },
			},
		}),
	);
	state.healthRawEvents = completeHealthLoad({ pending: 0, sessions: 0 });

	renderOverview();

	const pipeline = document.querySelectorAll("#healthGrid .health-tile-value")[0];
	expect(pipeline?.textContent).toBe("Events dropped");
	expect(pipeline?.querySelector(".presence-pip--attention")).not.toBeNull();
});

it("keeps reliability severity visible when events are also pending", () => {
	state.healthStats = completeHealthLoad(
		statsPayload({
			reliability: {
				counts: { errored_batches: 0 },
				rates: { flush_success_rate: 0.8, dropped_event_rate: 0.03 },
			},
		}),
	);
	state.healthRawEvents = completeHealthLoad({ pending: 1_000, sessions: 1 });

	renderOverview();

	const pipeline = document.querySelectorAll("#healthGrid .health-tile-value")[0];
	expect(pipeline?.textContent).toBe("1,000 pending · Events dropped");
	expect(pipeline?.querySelector(".presence-pip--attention")).not.toBeNull();
});

it("counts failed maintenance in the headline", () => {
	state.healthStats = completeHealthLoad(
		statsPayload({
			maintenance_jobs: [
				{
					error: "Retry the maintenance job.",
					kind: "vector-backfill",
					message: "Search index build failed",
					progress: { current: 2, total: 10, unit: "items" },
					status: "failed",
					title: "Build search index",
				},
			],
		}),
	);

	renderOverview();

	expect(document.getElementById("healthMeta")?.textContent).toContain(
		"1 issue · maintenance job failed",
	);
});

it("shows a recently successful degraded daemon as syncing", () => {
	state.lastSyncPeers = [{ peer_device_id: "peer-a" }];
	state.lastSyncStatus = {
		daemon_state: "degraded",
		enabled: true,
		last_sync_at: new Date().toISOString(),
	};

	renderOverview();

	const sync = document.querySelectorAll("#healthGrid .health-tile-value")[1];
	expect(sync?.textContent).toBe("Syncing");
	expect(sync?.querySelector(".presence-pip--online")).not.toBeNull();
	expect(document.getElementById("healthMeta")?.textContent).toContain("0 issues");
});

it("describes issue drivers below the degraded status threshold", () => {
	state.healthRawEvents = completeHealthLoad({ pending: 200, sessions: 1 });

	renderOverview();

	expect(document.getElementById("healthMeta")?.textContent).toContain(
		"1 issue · growing raw-event backlog",
	);
});

it("does not report unknown, unconfigured, or stale sync as online", () => {
	state.lastSyncStatus = { enabled: true };
	renderOverview();
	expect(document.querySelectorAll("#healthGrid .health-tile-value")[1]?.textContent).toBe(
		"Unknown",
	);

	state.lastSyncStatus = { enabled: true, daemon_state: "ok" };
	renderOverview();
	expect(document.querySelectorAll("#healthGrid .health-tile-value")[1]?.textContent).toBe(
		"No peers",
	);

	state.lastSyncPeers = [{ peer_device_id: "peer-a" }];
	state.lastSyncStatus = {
		enabled: true,
		daemon_state: "ok",
		last_sync_at: "2020-01-01T00:00:00.000Z",
	};
	renderOverview();
	const staleSync = document.querySelectorAll("#healthGrid .health-tile-value")[1];
	expect(staleSync?.textContent).toBe("Stale");
	expect(staleSync?.querySelector(".presence-pip--degraded")).not.toBeNull();
});

it("counts detected health risks instead of remediation rows", () => {
	state.lastSyncPeers = [{ peer_device_id: "peer-a" }];
	state.lastSyncStatus = { enabled: true, daemon_state: "needs_attention" };

	renderOverview();

	expect(document.getElementById("healthMeta")?.textContent).toMatch(
		/^1 issue · sync needs manual attention/,
	);
});

it("does not rewrite an unchanged Health announcement", () => {
	const announcer = document.getElementById("healthMeta");

	renderOverview();
	const announcement = announcer?.firstChild;
	renderOverview();

	expect(announcer?.firstChild).toBe(announcement);
});

it("does not animate a failed Health state", () => {
	state.healthStats = { status: "failed", error: "stats unavailable" };
	state.healthRawEvents = { status: "loading", previous: null, previousStatus: null };

	renderOverview();

	expect(document.querySelector("#healthGrid .health-loading-icon")).toBeNull();
	expect(document.querySelector("#healthGrid [role='status']")).toBeNull();
	expect(document.querySelector("#healthStatus .health-status-word")?.textContent).toBe(
		"Unavailable",
	);
});

it("replaces loading presence when the initial Health load fails", () => {
	state.healthStats = { status: "loading", previous: null, previousStatus: null };
	renderOverview();
	expect(document.querySelector("#healthStatus .presence-pip--syncing")).not.toBeNull();

	state.healthStats = { status: "failed", error: "stats unavailable" };
	renderOverview();

	expect(document.querySelector("#healthStatus .presence-pip--syncing")).toBeNull();
	expect(document.querySelector("#healthStatus .presence-pip--unknown")).not.toBeNull();
});

it("does not animate a not-loaded Health state", () => {
	state.healthStats = healthNotLoaded();

	renderOverview();

	expect(document.querySelector("#healthGrid .health-loading-icon")).toBeNull();
	expect(document.querySelector("#healthGrid [role='status']")).toBeNull();
	expect(document.querySelector("#healthStatus .health-status-word")?.textContent).toBe(
		"Not loaded",
	);
});

it("keeps stale warnings visible while retrying a stale resource", () => {
	state.healthStats = beginHealthLoad({
		status: "stale",
		snapshot: { data: statsPayload(), loadedAt: 123, scopeKey: "" },
		error: "stats timeout",
	});
	state.healthSession = beginHealthLoad({
		status: "stale",
		snapshot: {
			data: { total: 1, memories: 1, artifacts: 0, prompts: 0, observations: 0 },
			loadedAt: 123,
			scopeKey: "",
		},
		error: "session timeout",
	});

	renderStats();
	renderOverview();
	renderSessionSummary();

	expectStaleHealthMeta();
	expect(document.getElementById("metaLine")?.textContent).toContain("showing stale data");
	expect(document.getElementById("sessionMeta")?.textContent).toContain("Showing stale data");
});

it("keeps last known critical risks visible when their snapshots are stale", () => {
	state.healthStats = {
		status: "stale",
		snapshot: {
			data: statsPayload({
				reliability: {
					counts: { errored_batches: 5 },
					rates: { flush_success_rate: 0.5, dropped_event_rate: 0.1 },
				},
			}),
			loadedAt: 123,
			scopeKey: "",
		},
		error: "stats timeout",
	};
	state.healthRawEvents = {
		status: "stale",
		snapshot: { data: { pending: 1_000, sessions: 1 }, loadedAt: 123, scopeKey: "" },
		error: "raw events timeout",
	};

	renderOverview();

	expect(document.getElementById("healthDot")?.title).toBe("Attention");
	expect(document.getElementById("healthMeta")?.textContent).toMatch(
		/^4 issues · high raw-event backlog/,
	);
});

describe("Usage metric provenance", () => {
	it("renders pack estimates instead of mixed observer and pack totals", () => {
		state.healthUsage = completeHealthLoad(
			usagePayload({
				totals_global: { ...usageTotals, tokens_read: 1_010, tokens_saved: 40 },
				events_global: [
					usageEvent({ event: "observer_call", total_tokens_read: 1_000, measured_count: 1 }),
					usageEvent({
						event: "pack",
						total_tokens_read: 10,
						total_tokens_saved: 40,
						estimated_count: 1,
					}),
				],
			}),
		);

		renderStats();
		renderHealthOverview();

		const stats = [...document.querySelectorAll("#statsGrid .stat")];
		const injected = stats.find((node) => node.querySelector(".label")?.textContent === "Injected");
		expect(injected?.querySelector(".value")?.textContent).toBe("10 tokens");
		expect(injected?.parentElement?.getAttribute("data-tooltip")).toContain(
			"Estimated tokens injected",
		);
		const retrieval = [...document.querySelectorAll("#healthGrid .health-tile")].find(
			(node) => node.querySelector(".health-tile-label")?.textContent === "Retrieval",
		);
		expect(retrieval?.textContent).toContain("80%");
		expect(retrieval?.getAttribute("title")).toContain("memory reuse");
	});

	it("renders unknown retrieval health when pack reduction is unavailable", () => {
		state.healthUsage = completeHealthLoad(
			usagePayload({
				events_global: [usageEvent({ event: "pack", total_tokens_read: 0, total_tokens_saved: 0 })],
			}),
		);

		renderHealthOverview();

		const retrieval = [...document.querySelectorAll("#healthGrid .health-tile")].find(
			(node) => node.querySelector(".health-tile-label")?.textContent === "Retrieval",
		);
		expect(retrieval?.textContent).toContain("Unknown");
		expect(retrieval?.querySelector(".presence-pip--unknown")).not.toBeNull();
	});

	it("renders unknown freshness for an invalid pack timestamp", () => {
		state.healthUsage = completeHealthLoad(
			usagePayload({
				events_global: [usageEvent({ event: "pack", total_tokens_read: 10 })],
				recent_packs: [
					{ created_at: "not-a-date", metadata_json: null, tokens_read: 10, tokens_saved: 5 },
				],
			}),
		);

		renderHealthOverview();

		const freshness = [...document.querySelectorAll("#healthGrid .health-tile")].find(
			(node) => node.querySelector(".health-tile-label")?.textContent === "Data freshness",
		);
		expect(freshness?.textContent).toContain("Unknown");
		expect(freshness?.querySelector(".presence-pip--unknown")).not.toBeNull();
	});

	it("keeps global pack values distinct in project tooltips", () => {
		state.currentProject = "codemem";
		state.healthUsage = completeHealthLoad(
			usagePayload({
				totals_filtered: { ...usageTotals, tokens_read: 10, tokens_saved: 40 },
				events: [usageEvent({ total_tokens_read: 10, total_tokens_saved: 40 })],
				events_filtered: [usageEvent({ total_tokens_read: 10, total_tokens_saved: 40 })],
				events_global: [usageEvent({ total_tokens_read: 100, total_tokens_saved: 400 })],
			}),
			Date.now(),
			"codemem",
		);

		renderStats();

		const injected = [...document.querySelectorAll("#statsGrid .stat")].find(
			(node) => node.querySelector(".label")?.textContent === "Injected (project)",
		);
		expect(injected?.parentElement?.getAttribute("data-tooltip")).toContain(
			"Global: 100 estimated injected",
		);
	});
});

describe("Health resource load outcomes", () => {
	it("keeps successful resources when one Health request fails", async () => {
		state.healthStats = healthNotLoaded();
		state.healthUsage = healthNotLoaded();
		state.healthSession = healthNotLoaded();
		state.healthRawEvents = healthNotLoaded();
		mockSuccessfulHealthReads();
		vi.mocked(api.loadUsage).mockRejectedValueOnce(new Error("usage unavailable"));

		await loadHealthData();

		expect(state.healthStats.status).toBe("available");
		expect(state.healthUsage).toEqual({ status: "failed", error: "usage unavailable" });
		expect(state.healthSession).toMatchObject({
			status: "available",
			snapshot: { data: { total: 5 } },
		});
		expect(state.healthRawEvents.status).toBe("available");
		expect(document.getElementById("healthStatus")?.textContent).toContain("Unavailable");
		expect(document.getElementById("healthStatus")?.textContent).not.toContain("Healthy");
		expect(document.getElementById("sessionGrid")?.textContent).toContain("n/a");
		expect(document.getElementById("sessionMeta")?.textContent).toContain(
			"Pack totals unavailable",
		);
	});

	it("renders a measured zero only when usage loaded successfully", () => {
		state.healthUsage = completeHealthLoad(usagePayload());

		renderSessionSummary();

		const packs = [...document.querySelectorAll("#sessionGrid .stat")].find(
			(node) => node.querySelector(".label")?.textContent === "Packs",
		);
		expect(packs?.querySelector(".value")?.textContent).toBe("0");
		expect(document.getElementById("sessionMeta")?.textContent).toContain("No packs yet");
	});

	it("retains prior data explicitly as stale after a failed refresh", async () => {
		state.healthStats = completeHealthLoad(
			statsPayload({
				database: { ...statsPayload().database, active_memory_items: 7 },
			}),
			123,
		);
		mockSuccessfulHealthReads();
		vi.mocked(api.loadStats).mockRejectedValueOnce(new Error("stats timeout"));

		await loadHealthData();

		expect(state.healthStats).toEqual({
			status: "stale",
			error: "stats timeout",
			snapshot: {
				data: expect.objectContaining({
					database: expect.objectContaining({ active_memory_items: 7 }),
				}),
				loadedAt: 123,
				scopeKey: "",
			},
		});
		expect(document.getElementById("healthStatus")?.textContent).toContain("Stale");
		expectStaleHealthMeta();
		expect(document.getElementById("metaLine")?.textContent).toContain("showing stale data");
	});

	it("does not commit Health responses after the refresh is aborted", async () => {
		state.healthStats = completeHealthLoad(
			statsPayload({
				database: { ...statsPayload().database, active_memory_items: 7 },
			}),
			123,
		);
		mockSuccessfulHealthReads();
		vi.mocked(api.loadStats).mockResolvedValueOnce(
			statsPayload({
				database: { ...statsPayload().database, active_memory_items: 99 },
			}),
		);
		const controller = new AbortController();
		controller.abort();

		await loadHealthData({ signal: controller.signal });

		expect(state.healthStats.status).toBe("loading");
		expect(state.healthStats).toMatchObject({
			previous: { data: { database: { active_memory_items: 7 } }, loadedAt: 123 },
		});
		expect(document.getElementById("statsGrid")?.textContent).toContain("7");
		expect(document.getElementById("statsGrid")?.textContent).not.toContain("99");
	});

	it("does not reuse stale data after the project scope changes", async () => {
		state.healthUsage = completeHealthLoad(usagePayload(), 123, "old-project");
		state.currentProject = "new-project";
		mockSuccessfulHealthReads();
		vi.mocked(api.loadUsage).mockRejectedValueOnce(new Error("usage unavailable"));

		await loadHealthData();

		expect(state.healthUsage).toEqual({ status: "failed", error: "usage unavailable" });
		expect(document.getElementById("healthStatus")?.textContent).toContain("Unavailable");
	});

	it("clears prior-project values before the new project requests settle", async () => {
		state.currentProject = "old-project";
		state.healthUsage = completeHealthLoad(
			usagePayload({ events: [usageEvent({ count: 7 })] }),
			123,
			"old-project",
		);
		renderSessionSummary();
		expect(document.getElementById("sessionMeta")?.textContent).toContain("7 packs");
		state.currentProject = "new-project";
		let resolveUsage: ((payload: CachedUsagePayload) => void) | undefined;
		mockSuccessfulHealthReads();
		vi.mocked(api.loadUsage).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveUsage = resolve;
				}),
		);

		const loading = loadHealthData();

		expect(document.getElementById("sessionMeta")?.textContent).toContain(
			"Pack totals unavailable",
		);
		expect(document.getElementById("sessionMeta")?.textContent).not.toContain("7 packs");
		resolveUsage?.(usagePayload());
		await loading;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	state.activeTab = "feed";
	setUpdateStatus(null);
	for (const id of ["healthUpdateBanner", "healthGrid", "automaticRecallStats", "healthActions"]) {
		const element = document.getElementById(id);
		if (element) act(() => render(null, element));
	}
	document.body.innerHTML = "";
});

describe("Automatic recall disclosure", () => {
	const stats = {
		availability: "available",
		periodStart: "2026-08-08T12:00:00.000Z",
		periodEnd: "2026-09-07T12:00:00.000Z",
		windowLimit: 1000,
		captureVersion: "opencode-retained-v1",
		freshEvaluations: 4,
		evaluationsWithDuplicates: 1,
		candidateItems: 8,
		duplicatesOmitted: 2,
		beforeTokens: 100,
		afterTokens: 60,
		estimatedTokensAvoided: 40,
		missingRetainedMetadata: 1,
		invalidRetainedMetadata: 0,
		packMetadataGaps: 0,
		unmeasuredAttempts: 2,
	};
	function draw(payload: unknown) {
		const container = document.getElementById("automaticRecallStats");
		act(() => renderAutomaticRecall(container, payload));
		return container as HTMLElement;
	}
	it("shows measured recall outcomes as the existing stat tiles", () => {
		const container = draw(stats);
		const details = container.querySelector("details") as HTMLDetailsElement;
		expect(details.open).toBe(false);
		expect(details.querySelector("summary")?.textContent).toBe("Automatic recall");
		expect(details.querySelector("section")?.getAttribute("aria-label")).toBe(
			"Automatic recall measurements",
		);
		expect([...container.querySelectorAll(".stat .label")].map((node) => node.textContent)).toEqual(
			["Recalls with repeats", "Memories skipped", "Repeated tokens removed", "Recalls checked"],
		);
		expect([...container.querySelectorAll(".stat .value")].map((node) => node.textContent)).toEqual(
			["25%", "2", "~40 tokens", "4"],
		);
		expect(container.textContent).not.toContain(stats.periodStart);
		expect(container.textContent).not.toContain("opencode-retained-v1");
		expect(container.querySelector(`time[datetime="${stats.periodStart}"]`)).not.toBeNull();
		expect(container.querySelector(`time[datetime="${stats.periodEnd}"]`)).not.toBeNull();
		expect(container.querySelectorAll("dl")).toHaveLength(0);
		expect(container.querySelectorAll(".stat[tabindex='0']")).toHaveLength(4);
		expect(container.querySelector("[data-tooltip*='1 of 4 automatic recalls']")).not.toBeNull();
		expect(
			container.querySelector("[data-tooltip*='Some results may be incomplete']"),
		).not.toBeNull();
		details.open = true;
		draw({ ...stats, unmeasuredAttempts: 3 });
		expect(details.open).toBe(true);
	});
	it("distinguishes an empty window from zero measured savings", () => {
		const empty = Object.fromEntries(
			Object.entries(stats).map(([key, value]) => [
				key,
				typeof value === "number" && key !== "windowLimit" ? 0 : value,
			]),
		);
		const noData = draw({ ...empty, availability: "no_data", unmeasuredAttempts: 404 });
		expect(noData.textContent).toContain("No recalls were checked, so savings are unknown");
		expect([...noData.querySelectorAll(".stat .label")].map((node) => node.textContent)).toEqual([
			"Recalls checked",
			"Not checked",
		]);
		expect([...noData.querySelectorAll(".stat .value")].map((node) => node.textContent)).toEqual([
			"0",
			"404",
		]);
		const measuredZero = draw({
			...stats,
			evaluationsWithDuplicates: 0,
			duplicatesOmitted: 0,
			afterTokens: 100,
			estimatedTokensAvoided: 0,
		});
		expect(
			[...measuredZero.querySelectorAll(".stat .value")].map((node) => node.textContent),
		).toEqual(["0%", "0", "~0 tokens", "4"]);
	});
	it("keeps a small nonzero reduction distinct from zero", () => {
		const container = draw({
			...stats,
			freshEvaluations: 900,
			evaluationsWithDuplicates: 2,
			candidateItems: 900,
			duplicatesOmitted: 2,
			missingRetainedMetadata: 0,
		});
		expect(container.querySelector(".stat .value")?.textContent).toBe("<1%");
	});
	it("keeps a high non-total reduction distinct from 100 percent", () => {
		const container = draw({
			...stats,
			freshEvaluations: 900,
			evaluationsWithDuplicates: 899,
			candidateItems: 900,
			duplicatesOmitted: 899,
			beforeTokens: 900,
			afterTokens: 1,
			estimatedTokensAvoided: 899,
			missingRetainedMetadata: 0,
		});
		expect(container.querySelector(".stat .value")?.textContent).toBe(">99%");
	});
	it.each([
		undefined,
		{},
		{ ...stats, freshEvaluations: -1 },
		{ ...stats, estimatedTokensAvoided: 999 },
		{ ...stats, periodStart: "invalid" },
	])("fails closed for absent or invalid stats", (payload) => {
		expect(draw(payload).textContent).toContain("Automatic recall details aren’t available");
	});
});

describe("Health update banner", () => {
	it("loads update status only once after the Health tab becomes active", async () => {
		// Arrange
		vi.spyOn(api, "loadStats").mockResolvedValue(statsPayload());
		vi.spyOn(api, "loadUsage").mockResolvedValue(usagePayload());
		vi.spyOn(api, "loadSession").mockResolvedValue({
			total: 0,
			memories: 0,
			artifacts: 0,
			prompts: 0,
			observations: 0,
		});
		vi.spyOn(api, "loadRawEvents").mockResolvedValue({ pending: 0, sessions: 0 });
		const loadUpdateStatus = vi.spyOn(api, "loadUpdateStatus").mockResolvedValue(availableStatus);

		// Act
		state.activeTab = "feed";
		await loadHealthData();
		state.activeTab = "health";
		await loadHealthData();
		await loadHealthData();

		// Assert
		expect(loadUpdateStatus).toHaveBeenCalledTimes(1);
	});

	it("shows the current installed version as up to date", () => {
		// Arrange
		setUpdateStatus({
			...availableStatus,
			latest_version: "0.40.2",
			update_available: false,
			recommended_action: "No action required; codemem is up to date.",
		});

		// Act
		renderOverview();

		// Assert
		expect(updateBannerText()).toBe("Up to date · 0.40.2");
		expect(updateBannerText()).not.toContain("npm install");
		const banner = document.querySelector("#healthUpdateBanner [role='status']");
		expect(banner?.getAttribute("aria-label")).toBe("Codemem update status");
		expect(banner?.getAttribute("aria-atomic")).toBe("true");
		expect(banner?.querySelector("[data-lucide]")?.getAttribute("data-lucide")).toBe(
			"circle-arrow-up",
		);
	});

	it("describes repository source without release freshness claims", () => {
		setUpdateStatus({
			...availableStatus,
			current_version: "0.44.0",
			latest_version: "0.44.2",
			update_available: true,
			stale: true,
			install_kind: "repo-dev",
			recommended_action:
				"Package-release updates do not apply to repository source. Run git pull, pnpm install, and pnpm build in the codemem repository.",
		});

		renderOverview();

		const banner = document.querySelector("#healthUpdateBanner .badge");
		expect(banner?.textContent).toBe("Source build · 0.44.0");
		expect(banner?.getAttribute("title")).toContain("Package metadata version: 0.44.0");
		expect(banner?.getAttribute("title")).toContain("git pull, pnpm install, and pnpm build");
		expect(
			document.querySelector("#healthUpdateBanner .health-update-detail")?.textContent,
		).toContain("git pull, pnpm install, and pnpm build");
		expect(updateBannerText()).not.toMatch(/up to date|outdated|0\.44\.2 is available/i);
	});

	it("shows unavailable status for an unsupported installed version", () => {
		// Arrange
		setUpdateStatus({
			...availableStatus,
			current_version: "0.41.0-rc.1",
			channel: null,
			latest_version: null,
			update_available: false,
			recommended_action: "Verify the current codemem version and try again.",
			error: "unsupported installed release channel",
		});

		// Act
		renderOverview();

		// Assert
		expect(updateBannerText()).toContain("Unsupported channel");
		expect(
			document.querySelector("#healthUpdateBanner .health-update-detail")?.textContent,
		).toContain("Verify the current codemem version and try again.");
		expect(document.querySelector("#healthUpdateBanner .badge")?.getAttribute("title")).toContain(
			"Verify the current codemem version and try again.",
		);
		expect(updateBannerText()).not.toMatch(/up to date|latest stable release/i);
	});
});

describe("Health update banner channels and guidance", () => {
	it("identifies an up-to-date rc installation as rc", () => {
		setUpdateStatus({
			...availableStatus,
			current_version: "0.44.0-rc.2",
			channel: "rc",
			latest_version: "0.44.0-rc.2",
			update_available: false,
			recommended_action: "No action required; codemem is on the latest rc release.",
		});

		renderOverview();

		expect(document.querySelector("#healthUpdateBanner .badge")?.getAttribute("title")).toMatch(
			/latest rc release/i,
		);
		expect(updateBannerText()).not.toMatch(/latest stable release/i);
	});

	it("identifies an up-to-date alpha installation as alpha", () => {
		setUpdateStatus({
			...availableStatus,
			current_version: "0.44.0-alpha.2",
			channel: "alpha",
			latest_version: "0.44.0-alpha.2",
			update_available: false,
			recommended_action: "No action required; codemem is on the latest alpha release.",
		});

		renderOverview();

		expect(document.querySelector("#healthUpdateBanner .badge")?.getAttribute("title")).toMatch(
			/latest alpha release/i,
		);
		expect(updateBannerText()).not.toMatch(/latest stable release/i);
	});

	it("shows an available release with npm-global installation guidance", () => {
		// Arrange
		setUpdateStatus(availableStatus);

		// Act
		renderOverview();

		// Assert
		expect(updateBannerText()).toBe("Update available · 0.41.0Copy command");
		expect(document.querySelector("#healthUpdateBanner .badge-online")).not.toBeNull();
		const copy = document.querySelector<HTMLButtonElement>("#healthUpdateBanner button");
		expect(copy?.title).toBe(availableStatus.recommended_action);
	});

	it("qualifies stale release guidance as cached instead of presenting it as fresh", () => {
		// Arrange
		setUpdateStatus({ ...availableStatus, stale: true, error: "registry offline" });

		// Act
		renderOverview();

		// Assert
		expect(updateBannerText()).toMatch(/cached|stale/i);
		expect(
			document.querySelector("#healthUpdateBanner .badge[title*='stale']")?.getAttribute("title"),
		).toContain("registry offline");
		expect(document.querySelector<HTMLButtonElement>("#healthUpdateBanner button")?.title).toBe(
			availableStatus.recommended_action,
		);
	});

	it("shows a recoverable unavailable state without claiming the installation is current", () => {
		// Arrange
		setUpdateStatus({
			...availableStatus,
			latest_version: null,
			update_available: false,
			first_seen_at: null,
			checked_at: null,
			install_kind: "unknown",
			recommended_action: "Check network access and try again.",
			error: "registry request timed out",
		});

		// Act
		renderOverview();

		// Assert
		expect(updateBannerText()).toMatch(/unavailable|could not check|couldn't check/i);
		expect(document.querySelector("#healthUpdateBanner .badge")?.getAttribute("title")).toContain(
			"registry request timed out",
		);
		expect(document.querySelector("#healthUpdateBanner .badge")?.getAttribute("title")).toContain(
			"Check network access and try again.",
		);
		expect(
			document.querySelector("#healthUpdateBanner .health-update-detail")?.textContent,
		).toContain("Check network access and try again.");
		expect(updateBannerText()).not.toMatch(/up to date/i);
	});

	it("keeps Docker guidance rebuild-only and never offers an in-container update", () => {
		// Arrange
		setUpdateStatus({
			...availableStatus,
			install_kind: "docker",
			recommended_action:
				"Set CODEMEM_VERSION=0.41.0, then run CODEMEM_VERSION=0.41.0 docker compose build --pull and docker compose up -d.",
		});

		// Act
		renderOverview();

		// Assert
		const guidance = document.querySelector<HTMLButtonElement>("#healthUpdateBanner button")?.title;
		expect(guidance).toContain("CODEMEM_VERSION=0.41.0");
		expect(guidance).toContain("docker compose build --pull");
		expect(guidance).toContain("docker compose up -d");
		expect(guidance).not.toMatch(/npm install|codemem update install|self-update/i);
	});
});
