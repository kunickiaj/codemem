import type { ComponentChildren } from "preact";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../lib/api";
import * as api from "../lib/api";
import { state } from "../lib/state";
import { renderHealthOverview } from "./health";
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

function setUpdateStatus(status: UpdateStatus | null): void {
	state.lastUpdateStatus = status;
}

function renderOverview(): void {
	act(() => renderHealthOverview());
}

function updateBannerText(): string {
	return document.getElementById("healthUpdateBanner")?.textContent ?? "";
}

beforeEach(() => {
	// Arrange shared Health DOM and otherwise healthy state.
	document.body.innerHTML = `
		<div id="healthUpdateBanner"></div>
		<div id="healthGrid"></div>
		<div id="automaticRecallStats"></div>
		<div id="healthMeta"></div>
		<div id="healthActions"></div>
		<div id="healthDot"></div>
	`;
	state.lastStatsPayload = {};
	state.lastUsagePayload = {};
	state.lastRawEventsPayload = {};
	state.lastSyncStatus = { enabled: false, daemon_state: "disabled" };
	state.lastSyncPeers = [];
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
		vi.spyOn(api, "loadStats").mockResolvedValue({});
		vi.spyOn(api, "loadUsage").mockResolvedValue({});
		vi.spyOn(api, "loadSession").mockResolvedValue({});
		vi.spyOn(api, "loadRawEvents").mockResolvedValue({});
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
		expect(updateBannerText()).toMatch(/0\.40\.2.*up to date/i);
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

		const banner = updateBannerText();
		expect(banner).toContain("Running from repository source");
		expect(banner).toContain("Package metadata version: 0.44.0");
		expect(banner).toContain("git pull, pnpm install, and pnpm build");
		expect(banner).not.toMatch(/up to date|outdated|cached update|0\.44\.2 is available/i);
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
		expect(updateBannerText()).toMatch(/update check unavailable/i);
		expect(updateBannerText()).toContain("Verify the current codemem version and try again.");
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

		expect(updateBannerText()).toMatch(/latest rc release/i);
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

		expect(updateBannerText()).toMatch(/latest alpha release/i);
		expect(updateBannerText()).not.toMatch(/latest stable release/i);
	});

	it("shows an available release with npm-global installation guidance", () => {
		// Arrange
		setUpdateStatus(availableStatus);

		// Act
		renderOverview();

		// Assert
		expect(updateBannerText()).toContain("0.41.0");
		expect(updateBannerText()).toContain("0.40.2");
		expect(updateBannerText()).toContain("npm install -g codemem@0.41.0");
	});

	it("qualifies stale release guidance as cached instead of presenting it as fresh", () => {
		// Arrange
		setUpdateStatus({ ...availableStatus, stale: true, error: "registry offline" });

		// Act
		renderOverview();

		// Assert
		expect(updateBannerText()).toMatch(/cached|stale/i);
		expect(updateBannerText()).toContain("registry offline");
		expect(updateBannerText()).toContain(availableStatus.recommended_action);
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
		expect(updateBannerText()).toContain("registry request timed out");
		expect(updateBannerText()).toContain("Check network access and try again.");
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
		const banner = updateBannerText();
		expect(banner).toContain("CODEMEM_VERSION=0.41.0");
		expect(banner).toContain("docker compose build --pull");
		expect(banner).toContain("docker compose up -d");
		expect(banner).not.toMatch(/npm install|codemem update install|self-update/i);
	});
});
