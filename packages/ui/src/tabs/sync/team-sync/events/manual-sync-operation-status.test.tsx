import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/api", () => ({ triggerSync: vi.fn() }));
vi.mock("../../../../lib/form", () => ({
	clearFieldError: vi.fn(),
	friendlyError: vi.fn((_error: unknown, fallback: string) => fallback),
	markFieldError: vi.fn(() => false),
}));
vi.mock("../../../../lib/keyboard", () => ({ handlePrimaryActionKeyboard: vi.fn() }));
vi.mock("../../../../lib/notice", () => ({ showGlobalNotice: vi.fn() }));
vi.mock("../../../../lib/state", () => ({ state: {} }));
vi.mock("../../view-model", () => ({ summarizeSyncRunResult: vi.fn() }));
vi.mock("../data/state", () => ({ teamSyncState: { invitePolicy: "auto_admit" } }));
vi.mock("../helpers/invite-panel-dom", () => ({
	renderAdminSetupDisclosure: vi.fn(),
	renderInvitePolicySelect: vi.fn(),
	setInviteOutputVisibility: vi.fn(),
	setJoinFeedbackVisibility: vi.fn(),
}));
vi.mock("../../../project-sharing", () => ({ openProjectShareFlow: vi.fn() }));

import { mountOperationStatusHost } from "../../../../components/operation-status";
import * as api from "../../../../lib/api";
import { showGlobalNotice } from "../../../../lib/notice";
import { state } from "../../../../lib/state";
import { summarizeSyncRunResult } from "../../view-model";
import { summarizeSyncRunResult as realSummary } from "../../view-model/coordinator-approval";
import { initTeamSyncEvents } from "./init-team-sync-events";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

let request: ReturnType<typeof deferred<Awaited<ReturnType<typeof api.triggerSync>>>>;
let syncButton: HTMLButtonElement;
let navigation: HTMLButtonElement;
let host: HTMLElement;
let disposeHost: () => void;
const refresh = vi.fn();
const validItem = { peer_device_id: "peer-one", ok: true, opsIn: 0, opsOut: 2, addressErrors: [] };

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.mocked(summarizeSyncRunResult).mockReset().mockImplementation(realSummary);
	refresh.mockReset();
	state.viewerActorId = "actor-one";
	document.body.innerHTML = `
		<header><div id="operationStatusRoot"></div><button id="navDummy">Projects</button></header>
		<main>
			<section id="syncPanel" role="tabpanel"><button id="syncNowButton">Sync now</button></section>
			<section id="projectsPanel" role="tabpanel" hidden>Projects</section>
		</main>`;
	host = document.getElementById("operationStatusRoot") as HTMLElement;
	syncButton = document.getElementById("syncNowButton") as HTMLButtonElement;
	navigation = document.getElementById("navDummy") as HTMLButtonElement;
	navigation.addEventListener("click", () => {
		(document.getElementById("syncPanel") as HTMLElement).hidden = true;
		(document.getElementById("projectsPanel") as HTMLElement).hidden = false;
	});
	request = deferred();
	vi.mocked(api.triggerSync).mockReturnValue(request.promise);
	act(() => {
		disposeHost = mountOperationStatusHost(host);
	});
	initTeamSyncEvents(refresh, async () => {});
});

afterEach(() => {
	act(() => disposeHost());
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("manual sync header status", () => {
	it("names the pending sync immediately without moving focus or blocking navigation", async () => {
		// Arrange: no task is visible until the user starts one.
		expect(host.textContent).toBe("");
		navigation.focus();

		// Act
		await act(async () => syncButton.click());

		// Assert: the real request starts, but only the triggering action is disabled.
		expect(api.triggerSync).toHaveBeenCalledOnce();
		expect(syncButton.disabled).toBe(true);
		expect(navigation.disabled).toBe(false);
		expect(document.activeElement).toBe(navigation);
		const status = host.querySelector('[role="status"]');
		expect(status).not.toBeNull();
		expect(status?.getAttribute("aria-label")).toMatch(/sync/i);
		expect(status?.textContent).toMatch(/syncing|in progress|running/i);
		expect(status?.textContent).not.toMatch(/\d+%/);
	});

	it("keeps unresolved work visible beyond toast expiry and across tab navigation", async () => {
		// Arrange
		await act(async () => syncButton.click());

		// Act: navigate away and back while the same request remains unresolved.
		await act(async () => {
			navigation.click();
			syncButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await vi.advanceTimersByTimeAsync(9_000);
		});
		const hiddenSyncPanel = document.getElementById("syncPanel") as HTMLElement;

		// Assert: navigation works without hiding, completing, or duplicating the task.
		expect(hiddenSyncPanel.hidden).toBe(true);
		expect(host.closest('[role="tabpanel"]')).toBeNull();
		expect(host.textContent).toMatch(/syncing|in progress|running/i);
		expect(host.textContent).not.toMatch(/completed|cancelled|canceled|done/i);
		hiddenSyncPanel.hidden = false;
		syncButton.click();
		expect(syncButton.disabled).toBe(true);
		expect(api.triggerSync).toHaveBeenCalledOnce();
		expect(refresh).not.toHaveBeenCalled();
	});

	it.each([
		{ message: "Sync pass finished for 2 devices.", warning: false, ok: true },
		{
			message:
				"1 of 2 device sync attempts failed. Open the affected device cards for the specific errors.",
			warning: true,
			ok: false,
		},
	])("preserves the confirmed result: $message", async (summary) => {
		// Arrange: the existing summary remains the source of result wording and severity.
		const result = { items: [] };
		vi.mocked(summarizeSyncRunResult).mockReturnValue(summary);
		await act(async () => syncButton.click());
		navigation.focus();

		// Act
		await act(async () => request.resolve(result));

		// Assert
		expect(summarizeSyncRunResult).toHaveBeenCalledWith(result);
		expect(showGlobalNotice).not.toHaveBeenCalled();
		expect(host.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe(
			summary.warning ? "warning" : "success",
		);
		expect(syncButton.disabled).toBe(false);
		expect(refresh).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(navigation);
		expect(host.textContent).toContain(summary.message);
		expect(host.textContent).not.toMatch(/syncing|in progress/i);
	});

	it("reports an unknown outcome after a lost response instead of claiming cancellation or completion", async () => {
		// Arrange
		await act(async () => syncButton.click());
		navigation.focus();

		// Act
		await act(async () => request.reject(new TypeError("Failed to fetch")));

		// Assert: a network failure cannot tell us whether the server finished the sync.
		expect(syncButton.disabled).toBe(false);
		expect(navigation.disabled).toBe(false);
		expect(document.activeElement).toBe(navigation);
		expect(summarizeSyncRunResult).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(host.textContent).toMatch(
			/unknown|could not confirm|couldn.t confirm|unable to confirm/i,
		);
		expect(host.textContent).not.toMatch(/cancelled|canceled|completed|done|failed to start/i);
	});
});

describe("manual sync response validation", () => {
	it.each([
		{ actor: "actor-one", changed: false },
		{ actor: "actor-two", changed: true },
	])(
		"handles sync_disabled with actor=$actor without leaking stale guidance",
		async ({ actor, changed }) => {
			// Arrange: the server rejects disabled sync before any sync work starts.
			await act(async () => syncButton.click());
			state.viewerActorId = actor;
			// Act
			await act(async () => request.reject(new Error("sync_disabled")));
			// Assert: only the unchanged actor can receive profile-specific Settings guidance.
			expect(host.querySelector('[data-tone="warning"]')).not.toBeNull();
			expect(syncButton.disabled).toBe(false);
			expect(api.triggerSync).toHaveBeenCalledOnce();
			expect(summarizeSyncRunResult).not.toHaveBeenCalled();
			expect(refresh).not.toHaveBeenCalled();
			expect(showGlobalNotice).not.toHaveBeenCalled();
			if (changed) {
				expect(host.textContent).toMatch(
					/unknown|could not confirm|couldn.t confirm|unable to confirm/i,
				);
				expect(host.textContent).not.toMatch(/disabled|settings|sync_disabled/i);
				return;
			}
			expect(host.textContent).toMatch(/sync.{0,20}disabled/i);
			expect(host.textContent).toMatch(/settings/i);
			expect(host.textContent).not.toMatch(/unknown|couldn.t confirm|sync_disabled/i);
		},
	);

	it.each([
		{ items: null },
		{ items: [null] },
		{ items: [{}] },
		{ items: [{ ...validItem, opsIn: "" }] },
		{ items: [{ ...validItem, opsOut: -1 }] },
		{ items: [{ ...validItem, opsSkipped: Number.NaN }] },
	])("treats malformed response %j as unconfirmed", async (result) => {
		// Arrange
		await act(async () => syncButton.click());
		// Act: exercise runtime validation despite the API's static response type.
		await act(async () => request.resolve(result as unknown as api.SyncRunResponse));
		// Assert
		expect(host.textContent).toMatch(/confirm/i);
		expect(host.querySelector('[data-tone="warning"]')).not.toBeNull();
		expect(summarizeSyncRunResult).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(api.triggerSync).toHaveBeenCalledOnce();
	});

	it("accepts real partial results, including optional server fields, without losing warning detail", async () => {
		// Arrange: use the real summary, not a stubbed success fallback.
		const result = {
			items: [
				validItem,
				{
					...validItem,
					peer_device_id: "peer-two",
					ok: false,
					error: "Connection refused",
					address: "https://peer.example.test",
					opsSkipped: 1,
					skipped_out: { reason: "project_filter", skipped_count: 1, project: null },
					addressErrors: [{ address: "https://peer.example.test", error: "Connection refused" }],
				},
			],
		};
		await act(async () => syncButton.click());
		// Act
		await act(async () => request.resolve(result));
		// Assert
		expect(host.textContent).toContain("1 of 2 device sync attempts failed.");
		expect(host.querySelector('[data-tone="warning"]')).not.toBeNull();
		expect(host.textContent).not.toMatch(/couldn.t confirm/i);
		expect(showGlobalNotice).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("does not show a previous actor's raw result after the active actor changes", async () => {
		// Arrange
		await act(async () => syncButton.click());
		state.viewerActorId = "actor-two";
		// Act
		await act(async () =>
			request.resolve({ items: [{ ...validItem, ok: false, error: "Previous actor detail" }] }),
		);
		// Assert
		expect(host.textContent).toMatch(/confirm/i);
		expect(host.textContent).not.toContain("Previous actor detail");
		expect(summarizeSyncRunResult).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(api.triggerSync).toHaveBeenCalledOnce();
	});

	it("requests a view refresh through the void callback without losing the confirmed result", async () => {
		// Arrange
		refresh.mockReturnValueOnce(undefined);
		await act(async () => syncButton.click());
		// Act
		await act(async () => request.resolve({ items: [validItem] }));
		// Assert
		expect(host.textContent).toContain("Sync pass finished for 1 device.");
		expect(host.querySelector('[data-tone="success"]')).not.toBeNull();
		expect(refresh).toHaveBeenCalledOnce();
		expect(showGlobalNotice).not.toHaveBeenCalled();
		expect(api.triggerSync).toHaveBeenCalledOnce();
		expect(syncButton.disabled).toBe(false);
	});
});
