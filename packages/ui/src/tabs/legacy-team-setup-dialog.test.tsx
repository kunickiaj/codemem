import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LegacyTeamSetupApiError, type LegacyTeamSetupDetailResponseV1 } from "../lib/api";

const dialogControls = vi.hoisted(() => ({
	onCloseAutoFocus: undefined as undefined | ((event: { preventDefault: () => void }) => void),
	onOpenAutoFocus: undefined as undefined | ((event: { preventDefault: () => void }) => void),
	onOpenChange: undefined as undefined | ((open: boolean) => void),
}));

vi.mock("../components/primitives/radix-dialog", () => ({
	RadixDialog: (props: {
		children?: ComponentChildren;
		contentId: string;
		onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
		onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
		onOpenChange: (open: boolean) => void;
		open: boolean;
	}) => {
		dialogControls.onCloseAutoFocus = props.onCloseAutoFocus;
		dialogControls.onOpenAutoFocus = props.onOpenAutoFocus;
		dialogControls.onOpenChange = props.onOpenChange;
		return props.open ? (
			<div id={props.contentId} role="dialog">
				{props.children}
			</div>
		) : null;
	},
}));

import { mountLegacyTeamSetupDialog, openLegacyTeamSetup } from "./legacy-team-setup-dialog";

function detail({
	canFinish = false,
	conflictState = null,
	draftState = "in_progress",
	unresolvedDeviceCount = 0,
	unresolvedProjectCount = 0,
}: {
	canFinish?: boolean;
	conflictState?: LegacyTeamSetupDetailResponseV1["conflictState"];
	draftState?: "needs_setup" | "in_progress" | "stale" | "completed";
	unresolvedDeviceCount?: number;
	unresolvedProjectCount?: number;
} = {}): LegacyTeamSetupDetailResponseV1 {
	const base = {
		version: 1 as const,
		candidate: {
			candidateRef: "opaque-candidate",
			displayName: "Example Team",
			status: "in_progress" as const,
			deviceCount: 3,
			projectCount: 2,
			unresolvedDeviceCount,
			unresolvedProjectCount,
		},
		attemptId: "opaque-attempt",
		draftState,
		unresolvedDeviceCount,
		unresolvedProjectCount,
		devices: [],
		projects: [],
		identityChoices: [],
	};
	return canFinish
		? {
				...base,
				canFinish: true,
				conflictState: null,
				finishDigest: "opaque-finish-digest",
				accessDeltaDigest: "opaque-access-digest",
				accessDelta: {
					teamChanges: [],
					membershipChanges: [],
					projectChanges: [],
					recipientChanges: [],
					deviceAccessChanges: [],
				},
			}
		: { ...base, canFinish: false, conflictState };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

function setup(
	loadDetail: (candidateRef: string) => Promise<LegacyTeamSetupDetailResponseV1>,
	overrides: Parameters<typeof mountLegacyTeamSetupDialog>[1] = {},
) {
	document.body.innerHTML = `
		<button class="tab-btn" id="tabBtn-sharing" aria-current="page">Sharing</button>
		<section id="team-setup-panel"><button id="team-setup-trigger">Continue setup</button></section>
		<div id="legacyTeamSetupMount"></div>
	`;
	const mount = document.getElementById("legacyTeamSetupMount");
	const trigger = document.getElementById("team-setup-trigger");
	if (!(mount instanceof HTMLElement) || !(trigger instanceof HTMLButtonElement)) {
		throw new Error("Team setup test fixture missing");
	}
	act(() => mountLegacyTeamSetupDialog(mount, { ...overrides, loadDetail }));
	trigger.focus();
	act(() => {
		openLegacyTeamSetup("opaque-candidate");
	});
	return { mount, trigger };
}

afterEach(() => {
	const mount = document.getElementById("legacyTeamSetupMount");
	if (mount) act(() => render(null, mount));
	document.body.innerHTML = "";
	vi.clearAllMocks();
	dialogControls.onCloseAutoFocus = undefined;
	dialogControls.onOpenAutoFocus = undefined;
	dialogControls.onOpenChange = undefined;
});

describe("legacy Team setup dialog", () => {
	it("opens with loading state and selects Devices from authoritative detail", async () => {
		const pending = deferred<LegacyTeamSetupDetailResponseV1>();
		const loadDetail = vi.fn().mockReturnValue(pending.promise);
		setup(loadDetail);

		expect(loadDetail).toHaveBeenCalledWith("opaque-candidate");
		expect(document.body.textContent).toContain("Loading the latest Team setup details");
		expect(document.querySelector(".legacy-team-setup-card")?.getAttribute("aria-busy")).toBe(
			"true",
		);

		pending.resolve(detail({ unresolvedDeviceCount: 2, unresolvedProjectCount: 1 }));
		await vi.waitFor(() => {
			expect(document.body.textContent).toContain("Set up Example Team");
			expect(document.body.textContent).toContain("2 of 3 Team devices");
		});
		expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Devices");
		expect(document.querySelector('[role="alert"]')).toBeNull();
		const projectsButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Projects",
		);
		expect(projectsButton?.disabled).toBe(false);
		expect(projectsButton?.getAttribute("aria-disabled")).toBe("true");
		expect(projectsButton?.getAttribute("aria-describedby")).toBe(
			"legacy-team-setup-block-devices",
		);
		expect(document.getElementById("legacy-team-setup-block-devices")?.textContent).toContain(
			"Finish the device decisions",
		);
		act(() => projectsButton?.click());
		expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Devices");
	});

	it("treats incomplete setup as normal progress rather than changed state", async () => {
		setup(
			vi.fn().mockResolvedValue(
				detail({
					conflictState: "team_setup_incomplete",
					unresolvedDeviceCount: 2,
					unresolvedProjectCount: 1,
				}),
			),
		);

		await vi.waitFor(() => expect(document.body.textContent).toContain("2 of 3 Team devices"));
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(document.body.textContent).not.toContain("changed since it was last reviewed");
	});

	it("selects Projects, Review, and completion from fresh server state", async () => {
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(detail({ unresolvedProjectCount: 1 }))
			.mockResolvedValueOnce(detail({ canFinish: true }))
			.mockResolvedValueOnce(detail({ draftState: "completed" }));
		const { trigger } = setup(loadDetail);

		await vi.waitFor(() => {
			expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Projects");
		});
		act(() =>
			document.querySelector<HTMLButtonElement>(".legacy-team-setup-actions button")?.click(),
		);
		trigger.focus();
		act(() => {
			openLegacyTeamSetup("opaque-candidate");
		});
		await vi.waitFor(() => {
			expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Review");
		});
		act(() =>
			document.querySelector<HTMLButtonElement>(".legacy-team-setup-actions button")?.click(),
		);
		trigger.focus();
		act(() => {
			openLegacyTeamSetup("opaque-candidate");
		});
		await vi.waitFor(() => {
			expect(document.body.textContent).toContain("Team setup complete");
		});
		expect(document.querySelector(".legacy-team-setup-steps")).toBeNull();
		expect(loadDetail).toHaveBeenCalledTimes(3);
	});

	it("shows safe error copy and retries without exposing exception text", async () => {
		const retry = deferred<LegacyTeamSetupDetailResponseV1>();
		const loadDetail = vi
			.fn()
			.mockRejectedValueOnce(new Error("private coordinator response"))
			.mockReturnValueOnce(retry.promise);
		setup(loadDetail);

		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"temporarily unavailable",
			);
		});
		expect(document.body.textContent).not.toContain("private coordinator response");

		const retryButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Retry",
		);
		retryButton?.focus();
		act(() => retryButton?.click());
		expect(retryButton?.disabled).toBe(false);
		expect(retryButton?.getAttribute("aria-disabled")).toBe("true");
		expect(document.activeElement).toBe(retryButton);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"temporarily unavailable",
		);
		retry.resolve(detail({ unresolvedProjectCount: 1 }));
		await vi.waitFor(() => {
			expect(document.body.textContent).toContain("Review Projects");
		});
		expect(document.activeElement?.id).toBe("legacy-team-setup-step-projects");
		expect(loadDetail).toHaveBeenCalledTimes(2);
	});

	it("uses changed-state copy for stale API errors and stale detail", async () => {
		const loadDetail = vi
			.fn()
			.mockRejectedValueOnce(new LegacyTeamSetupApiError(409, "team_setup_conflict"))
			.mockResolvedValueOnce(detail({ draftState: "stale", unresolvedProjectCount: 1 }))
			.mockResolvedValueOnce(detail({ unresolvedProjectCount: 1 }));
		const refreshCandidate = vi.fn().mockResolvedValue({});
		setup(loadDetail, { refreshCandidate });

		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"changed since it was last reviewed",
			);
		});
		act(() => {
			document.getElementById("legacy-team-setup-retry")?.click();
		});
		await vi.waitFor(() => {
			expect(document.body.textContent).toContain("Review Projects");
		});
		expect(refreshCandidate).toHaveBeenCalledTimes(1);
		expect(refreshCandidate.mock.invocationCallOrder[0]).toBeLessThan(
			loadDetail.mock.invocationCallOrder[1],
		);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"changed since it was last reviewed",
		);
		act(() => {
			document.getElementById("legacy-team-setup-retry")?.click();
		});
		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')).toBeNull();
		});
		expect(refreshCandidate).toHaveBeenCalledTimes(2);
		expect(loadDetail).toHaveBeenCalledTimes(3);
	});

	it("focuses explicit step navigation and restores the connected trigger on dismissal", async () => {
		const loadDetail = vi.fn().mockResolvedValue(detail({ unresolvedProjectCount: 1 }));
		const { trigger } = setup(loadDetail);
		await vi.waitFor(() => {
			expect(document.body.textContent).toContain("Review Projects");
		});

		const preventOpenDefault = vi.fn();
		act(() => dialogControls.onOpenAutoFocus?.({ preventDefault: preventOpenDefault }));
		expect(preventOpenDefault).toHaveBeenCalled();
		expect(document.activeElement?.id).toBe("legacy-team-setup-title");

		act(() => {
			[...document.querySelectorAll<HTMLButtonElement>("button")]
				.find((button) => button.textContent === "Devices")
				?.click();
		});
		await vi.waitFor(() => {
			expect(document.activeElement?.id).toBe("legacy-team-setup-step-devices");
		});
		const reviewButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Review",
		);
		expect(reviewButton?.getAttribute("aria-describedby")).toBe("legacy-team-setup-block-projects");
		expect(document.getElementById("legacy-team-setup-block-projects")).not.toBeNull();
		act(() => {
			[...document.querySelectorAll<HTMLButtonElement>("button")]
				.find((button) => button.textContent === "Devices")
				?.click();
		});

		act(() => dialogControls.onOpenChange?.(false));
		expect(document.getElementById("legacyTeamSetupDialog")).toBeNull();
		const preventCloseDefault = vi.fn();
		act(() => dialogControls.onCloseAutoFocus?.({ preventDefault: preventCloseDefault }));
		expect(preventCloseDefault).toHaveBeenCalled();
		expect(document.activeElement).toBe(trigger);

		trigger.focus();
		act(() => {
			openLegacyTeamSetup("opaque-candidate");
		});
		act(() => dialogControls.onOpenAutoFocus?.({ preventDefault: vi.fn() }));
		await vi.waitFor(() => {
			expect(loadDetail).toHaveBeenCalledTimes(2);
		});
		expect(document.activeElement?.id).toBe("legacy-team-setup-title");
		const triggerPanel = document.getElementById("team-setup-panel");
		if (!(triggerPanel instanceof HTMLElement)) throw new Error("trigger panel missing");
		triggerPanel.style.display = "none";
		act(() => dialogControls.onOpenChange?.(false));
		act(() => dialogControls.onCloseAutoFocus?.({ preventDefault: vi.fn() }));
		expect(document.activeElement?.id).toBe("tabBtn-sharing");

		triggerPanel.style.display = "";
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		expect(document.activeElement).toBe(document.body);
		act(() => {
			openLegacyTeamSetup("opaque-candidate");
		});
		await vi.waitFor(() => {
			expect(loadDetail).toHaveBeenCalledTimes(3);
		});
		act(() => dialogControls.onOpenChange?.(false));
		act(() => dialogControls.onCloseAutoFocus?.({ preventDefault: vi.fn() }));
		expect(document.activeElement?.id).toBe("tabBtn-sharing");
	});
});
