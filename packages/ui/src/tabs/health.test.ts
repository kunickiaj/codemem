import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../lib/api";
import * as api from "../lib/api";
import { state } from "../lib/state";
import { renderHealthOverview } from "./health";
import { loadHealthData } from "./health/lifecycle";

vi.mock("../components/primitives/tooltip", () => ({
	Tooltip: ({ children }: { children?: unknown }) => children,
	TooltipProvider: ({ children }: { children?: unknown }) => children,
}));

const availableStatus: UpdateStatus = {
	current_version: "0.40.2",
	latest_version: "0.41.0",
	update_available: true,
	first_seen_at: "2026-08-10T12:00:00.000Z",
	checked_at: "2026-08-10T12:00:00.000Z",
	stale: false,
	install_kind: "npm-global",
	auto_update_eligible: false,
	recommended_action: "npm install -g codemem@0.41.0",
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
	for (const id of ["healthUpdateBanner", "healthGrid", "healthActions"]) {
		const element = document.getElementById(id);
		if (element) act(() => render(null, element));
	}
	document.body.innerHTML = "";
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

	it("does not present an unparseable installed version as current", () => {
		// Arrange
		setUpdateStatus({
			...availableStatus,
			current_version: "0.41.0-rc.1",
			update_available: false,
			recommended_action: "Verify the current codemem version and try again.",
		});

		// Act
		renderOverview();

		// Assert
		expect(updateBannerText()).toMatch(/unable to compare/i);
		expect(updateBannerText()).toContain("Verify the current codemem version and try again.");
		expect(updateBannerText()).not.toMatch(/up to date|latest stable release/i);
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
