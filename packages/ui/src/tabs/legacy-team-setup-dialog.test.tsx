import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type LegacyTeamSetupAccessDeltaV1,
	type LegacyTeamSetupActionGateV1,
	LegacyTeamSetupApiError,
	type LegacyTeamSetupDetailResponseV1,
	type LegacyTeamSetupDeviceV1,
	type LegacyTeamSetupErrorCode,
	type LegacyTeamSetupIdentityChoiceV1,
	type LegacyTeamSetupProjectV1,
} from "../lib/api";

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

import {
	type LegacyTeamSetupDialogDependencies,
	mountLegacyTeamSetupDialog,
	openLegacyTeamSetup,
} from "./legacy-team-setup-dialog";

const identities: LegacyTeamSetupIdentityChoiceV1[] = [
	{ identityRef: "identity-ref-alex", displayName: "Alex" },
	{ identityRef: "identity-ref-sam", displayName: "Sam" },
];

function device(overrides: Partial<LegacyTeamSetupDeviceV1> = {}): LegacyTeamSetupDeviceV1 {
	const value = {
		deviceRef: "device-ref-one",
		displayName: "Work laptop",
		enabled: true,
		existingIdentityRef: null,
		suggestedIdentityRef: "identity-ref-alex",
		verifiedEvidenceKind: null,
		decision: "unresolved",
		targetIdentityRef: null,
		expectation: { kind: "absent" },
		...overrides,
	} as Omit<LegacyTeamSetupDeviceV1, "actions">;
	const enabled = { enabled: true, blockedReason: null } as const;
	const inactive = { enabled: false, blockedReason: "device_inactive" } as const;
	const assignmentEvidenceInactive =
		value.expectation.kind === "existing" && value.verifiedEvidenceKind !== "active_assignment";
	const assignmentGate: LegacyTeamSetupActionGateV1 = !value.enabled
		? inactive
		: assignmentEvidenceInactive
			? { enabled: false, blockedReason: "assignment_evidence_inactive" as const }
			: enabled;
	return {
		...value,
		actions: {
			assignIdentity: assignmentGate,
			include: value.enabled
				? assignmentEvidenceInactive
					? { enabled: false, blockedReason: "assignment_evidence_inactive" }
					: value.targetIdentityRef
						? enabled
						: { enabled: false, blockedReason: "assignment_required" }
				: inactive,
			exclude: value.enabled ? enabled : inactive,
			remove: value.enabled ? { enabled: false, blockedReason: "device_active" } : enabled,
			clearDecision:
				value.decision === "unresolved"
					? { enabled: false, blockedReason: "decision_unresolved" }
					: enabled,
		},
	};
}

function project(overrides: Partial<LegacyTeamSetupProjectV1> = {}): LegacyTeamSetupProjectV1 {
	const value = {
		projectRef: "project-ref-one",
		displayName: "Legacy Project",
		resolution: "unresolved",
		canonicalProjectRef: null,
		resolvedProjectRef: null,
		mappingChoices: [
			{ resolvedProjectRef: "resolved-project-alpha", displayName: "Project Alpha" },
			{ resolvedProjectRef: "resolved-project-beta", displayName: "Project Beta" },
		],
		...overrides,
	} as Omit<LegacyTeamSetupProjectV1, "actions">;
	return {
		...value,
		actions: {
			map:
				value.resolution === "deterministic"
					? { enabled: false, blockedReason: "automatic_mapping" }
					: { enabled: true, blockedReason: null },
		},
	};
}

function detail({
	canFinish = false,
	conflictState = null,
	draftState = "in_progress",
	attemptId = "opaque-attempt",
	accessDelta,
	devices,
	identityChoices = [],
	projects,
	unresolvedDeviceCount = 0,
	unresolvedProjectCount = 0,
	viewerAccessDeltaDigest = "opaque-viewer-access-digest",
}: {
	canFinish?: boolean;
	conflictState?: LegacyTeamSetupErrorCode | null;
	draftState?: "needs_setup" | "in_progress" | "stale" | "completed";
	attemptId?: string;
	accessDelta?: LegacyTeamSetupAccessDeltaV1;
	devices?: LegacyTeamSetupDeviceV1[];
	identityChoices?: LegacyTeamSetupIdentityChoiceV1[];
	projects?: LegacyTeamSetupProjectV1[];
	unresolvedDeviceCount?: number;
	unresolvedProjectCount?: number;
	viewerAccessDeltaDigest?: string;
} = {}): LegacyTeamSetupDetailResponseV1 {
	const base = {
		version: 1 as const,
		candidate: {
			candidateRef: "opaque-candidate",
			displayName: "Example Team",
			status: "in_progress" as const,
			deviceCount: devices?.length ?? 3,
			projectCount: projects?.length ?? 0,
			unresolvedDeviceCount,
			unresolvedProjectCount,
		},
		attemptId,
		unresolvedDeviceCount,
		unresolvedProjectCount,
		devices: devices ?? [],
		projects: projects ?? [],
		identityChoices,
	};
	if (draftState === "completed") {
		return {
			...base,
			state: "completed",
			devices: base.devices.map((item) => ({
				...item,
				actions: {
					assignIdentity: { enabled: false, blockedReason: "setup_completed" },
					include: { enabled: false, blockedReason: "setup_completed" },
					exclude: { enabled: false, blockedReason: "setup_completed" },
					remove: { enabled: false, blockedReason: "setup_completed" },
					clearDecision: { enabled: false, blockedReason: "setup_completed" },
				},
			})),
			projects: base.projects.map((item) => ({
				...item,
				actions: { map: { enabled: false, blockedReason: "setup_completed" } },
			})),
			actions: {
				refresh: { enabled: false, blockedReason: "setup_completed" },
				finish: { enabled: false, blockedReason: "setup_completed" },
			},
		};
	}
	if (draftState === "stale" || (conflictState && conflictState !== "team_setup_incomplete")) {
		return {
			...base,
			state: "unavailable",
			unavailableReason: conflictState ?? "team_setup_roster_changed",
			actions: {
				refresh: { enabled: true, blockedReason: null },
				finish: { enabled: false, blockedReason: "setup_unavailable" },
			},
			devices: base.devices.map((item) => ({
				...item,
				actions: {
					assignIdentity: { enabled: false, blockedReason: "setup_unavailable" },
					include: { enabled: false, blockedReason: "setup_unavailable" },
					exclude: { enabled: false, blockedReason: "setup_unavailable" },
					remove: { enabled: false, blockedReason: "setup_unavailable" },
					clearDecision: { enabled: false, blockedReason: "setup_unavailable" },
				},
			})),
			projects: base.projects.map((item) => ({
				...item,
				actions: { map: { enabled: false, blockedReason: "setup_unavailable" } },
			})),
		};
	}
	return canFinish
		? {
				...base,
				state: "ready_to_finish",
				actions: {
					refresh: { enabled: true, blockedReason: null },
					finish: { enabled: true, blockedReason: null },
				},
				finishDigest: "opaque-finish-digest",
				accessDeltaDigest: "opaque-access-digest",
				viewerAccessDeltaDigest,
				accessDelta: accessDelta ?? {
					teamChanges: [],
					membershipChanges: [],
					projectChanges: [],
					recipientChanges: [],
					deviceAccessChanges: [],
				},
			}
		: {
				...base,
				state: "reviewing",
				actions: {
					refresh: { enabled: true, blockedReason: null },
					finish: { enabled: false, blockedReason: "setup_incomplete" },
				},
			};
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
	input:
		| LegacyTeamSetupDialogDependencies["loadDetail"]
		| (Partial<LegacyTeamSetupDialogDependencies> & {
				loadDetail: LegacyTeamSetupDialogDependencies["loadDetail"];
		  }),
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
	const overrides = typeof input === "function" ? { loadDetail: input } : input;
	act(() => mountLegacyTeamSetupDialog(mount, overrides));
	trigger.focus();
	act(() => {
		openLegacyTeamSetup("opaque-candidate");
	});
	return { mount, trigger };
}

function button(label: string): HTMLButtonElement {
	const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label,
	);
	if (!match) throw new Error(`button missing: ${label}`);
	return match;
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

		pending.resolve(
			detail({
				devices: [
					device(),
					device({ deviceRef: "device-ref-two", displayName: "Second laptop" }),
					device({ deviceRef: "device-ref-three", decision: "excluded" }),
				],
				unresolvedDeviceCount: 2,
				unresolvedProjectCount: 1,
			}),
		);
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
		expect(document.activeElement?.id).toBe("legacy-team-device-row-0");
		expect(document.body.textContent).toContain(
			"Finish the device decisions before mapping Projects.",
		);
	});

	it("moves blocked Review navigation to the unresolved Projects step", async () => {
		setup(vi.fn().mockResolvedValue(detail({ projects: [project()], unresolvedProjectCount: 1 })));
		await vi.waitFor(() => {
			expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Projects");
		});
		act(() => button("Devices").click());
		expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Devices");

		act(() => button("Review").click());
		await vi.waitFor(() => {
			expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Projects");
			expect(document.activeElement?.id).toBe("legacy-team-project-row-0");
		});
		expect(document.body.textContent).toContain(
			"Finish the Project mappings before reviewing access.",
		);
	});

	it("moves to Projects after the final device decision when deterministic Projects remain", async () => {
		// Arrange
		const deterministicProject = project({
			canonicalProjectRef: "opaque-canonical-project",
			mappingChoices: [],
			resolution: "deterministic",
			resolvedProjectRef: "opaque-resolved-project",
		});
		const loadDetail = vi
			.fn()
			.mockResolvedValue(
				detail({ devices: [device()], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		const saved = detail({
			devices: [device({ decision: "excluded", suggestedIdentityRef: null })],
			projects: [deterministicProject],
			unresolvedProjectCount: 0,
		});
		setup({ loadDetail, saveDecision: vi.fn().mockResolvedValue(saved) });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Work laptop"));

		// Act
		act(() => button("Exclude").click());

		// Assert
		await vi.waitFor(() => {
			expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Projects");
		});
		expect(document.body.textContent).toContain("Review Projects");
		expect(document.body.textContent).not.toContain("Review and finish");
		expect(loadDetail).toHaveBeenCalledTimes(1);
	});

	it("renders explicit numbered step hooks with list and current-step semantics", async () => {
		// Arrange
		setup(vi.fn().mockResolvedValue(detail({ devices: [device()], unresolvedDeviceCount: 1 })));

		// Act
		const steps = await vi.waitFor(() => {
			const match = document.querySelector<HTMLElement>(".legacy-team-setup-steps");
			if (!match) throw new Error("ordered Team setup steps missing");
			return match;
		});

		// Assert
		expect(steps.getAttribute("aria-label")).toBe("Team setup steps");
		expect(steps.getAttribute("role")).toBe("list");
		const items = [...steps.children];
		expect(items).toHaveLength(3);
		expect(items.every((item) => item.classList.contains("legacy-team-setup-step"))).toBe(true);
		expect(items.every((item) => item.getAttribute("role") === "listitem")).toBe(true);
		expect(
			items.map((item) =>
				item.querySelector(".legacy-team-setup-step-number")?.textContent?.trim(),
			),
		).toEqual(["1", "2", "3"]);
		expect(steps.querySelectorAll('button[aria-current="step"]')).toHaveLength(1);
		expect(steps.querySelector('button[aria-current="step"]')?.textContent).toContain("Devices");
		expect(
			[...steps.querySelectorAll<HTMLButtonElement>("button")].map((step) =>
				step.getAttribute("aria-label"),
			),
		).toEqual(["Step 1: Devices", "Step 2: Projects", "Step 3: Review"]);
	});

	it("opens an unfinished ready draft on Projects before Review", async () => {
		const deterministicProject = project({
			canonicalProjectRef: "opaque-canonical-project",
			mappingChoices: [],
			resolution: "deterministic",
			resolvedProjectRef: "opaque-resolved-project",
		});
		setup(
			vi.fn().mockResolvedValue(
				detail({
					canFinish: true,
					projects: [deterministicProject],
					unresolvedDeviceCount: 0,
					unresolvedProjectCount: 0,
				}),
			),
		);

		await vi.waitFor(() => {
			expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Projects");
		});
		expect(document.body.textContent).toContain("Review Projects");
		expect(document.body.textContent).not.toContain("Review and finish");
		act(() => button("Continue to Review").click());
		expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Review");
		expect(document.body.textContent).toContain("Review and finish");
		expect(document.body.textContent).toContain(
			"Review device ownership and Project access before this Team can be used for sharing",
		);
		expect(document.body.textContent).not.toMatch(/confirmation evidence|server-provided work/i);
	});

	it("returns a ready draft to Projects when the dialog is reopened", async () => {
		const readyDetail = detail({
			canFinish: true,
			projects: [
				project({
					mappingChoices: [],
					resolution: "deterministic",
					resolvedProjectRef: "opaque-resolved-project",
				}),
			],
		});
		const loadDetail = vi.fn().mockResolvedValue(readyDetail);
		setup({ loadDetail });

		await vi.waitFor(() => expect(document.body.textContent).toContain("Review Projects"));
		act(() => button("Continue to Review").click());
		expect(document.body.textContent).toContain("Review and finish");
		act(() => button("Close").click());
		act(() => {
			openLegacyTeamSetup("opaque-candidate");
		});

		await vi.waitFor(() => {
			expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Projects");
		});
		expect(loadDetail).toHaveBeenCalledTimes(2);
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
		const onCompleted = vi.fn().mockRejectedValue(new Error("private refresh failure"));
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(detail({ unresolvedProjectCount: 1 }))
			.mockResolvedValueOnce(detail({ canFinish: true }))
			.mockResolvedValueOnce(detail({ draftState: "completed" }));
		const { trigger } = setup({ loadDetail, onCompleted });

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
			expect(document.body.textContent).toContain(
				"Sharing or Projects could not be refreshed; use that view's Refresh control.",
			);
		});
		expect(document.querySelector(".legacy-team-setup-steps")).toBeNull();
		expect(loadDetail).toHaveBeenCalledTimes(3);
		expect(onCompleted).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).not.toContain("private refresh failure");
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

	it("directs roster-unavailable recovery to coordinator connection and settings", async () => {
		setup(
			vi.fn().mockRejectedValue(new LegacyTeamSetupApiError(503, "team_setup_roster_unavailable")),
		);

		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"Check the coordinator connection and settings, then retry.",
			);
		});
		expect(document.body.textContent).not.toContain("team_setup_roster_unavailable");
	});

	it("uses changed-state copy for stale API errors and stale detail", async () => {
		const loadDetail = vi
			.fn()
			.mockRejectedValueOnce(new LegacyTeamSetupApiError(409, "team_setup_conflict"));
		const refreshCandidate = vi
			.fn()
			.mockResolvedValueOnce(detail({ draftState: "stale", unresolvedProjectCount: 1 }))
			.mockResolvedValueOnce(detail({ unresolvedProjectCount: 1 }));
		setup({ loadDetail, refreshCandidate });

		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("changed since it was last reviewed"),
		);
		expect(document.querySelector('[role="alert"]')).not.toBeNull();
		act(() => {
			document.getElementById("legacy-team-setup-retry")?.click();
		});
		await vi.waitFor(() => {
			expect(document.body.textContent).toContain("Review Projects");
		});
		expect(refreshCandidate).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"changed since it was last reviewed",
		);
		expect(document.getElementById("legacy-team-setup-retry")).toBeNull();
		expect(document.activeElement?.id).toBe("legacy-team-setup-refresh");
		act(() => {
			button("Refresh Team setup").click();
		});
		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')).toBeNull();
		});
		expect(refreshCandidate).toHaveBeenCalledTimes(2);
		expect(loadDetail).toHaveBeenCalledTimes(1);
	});

	it("persists an identity assignment with exact expectation evidence", async () => {
		const initialDevice = device({
			existingIdentityRef: "identity-ref-alex",
			suggestedIdentityRef: null,
			verifiedEvidenceKind: "active_assignment",
			expectation: {
				kind: "existing",
				assignmentVersion: 7,
				identityRef: "identity-ref-alex",
			},
		});
		const refreshedDevice = device({
			...initialDevice,
			targetIdentityRef: "identity-ref-sam",
		});
		const loadDetail = vi
			.fn()
			.mockResolvedValue(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		const saveAssignment = vi.fn().mockResolvedValue(
			detail({
				devices: [refreshedDevice],
				identityChoices: identities,
				unresolvedDeviceCount: 1,
			}),
		);
		setup({ loadDetail, saveAssignment });

		const select = await vi.waitFor(() => {
			const match = document.querySelector<HTMLSelectElement>(".legacy-team-device-select");
			if (!match) throw new Error("identity select missing");
			return match;
		});
		select.value = "identity-ref-sam";
		act(() => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(saveAssignment).not.toHaveBeenCalled();
		act(() => button("Save assignment").click());

		await vi.waitFor(() => {
			expect(saveAssignment).toHaveBeenCalledWith("opaque-candidate", "device-ref-one", {
				attemptId: "opaque-attempt",
				targetIdentityRef: "identity-ref-sam",
				expectation: {
					kind: "existing",
					assignmentVersion: 7,
					identityRef: "identity-ref-alex",
				},
			});
			expect(document.querySelector<HTMLSelectElement>(".legacy-team-device-select")?.value).toBe(
				"identity-ref-sam",
			);
			expect(loadDetail).toHaveBeenCalledTimes(1);
		});
	});

	it("lets users confirm an existing assignment before including its device", async () => {
		const initialDevice = device({
			existingIdentityRef: "identity-ref-alex",
			suggestedIdentityRef: null,
			verifiedEvidenceKind: "active_assignment",
			expectation: {
				kind: "existing",
				assignmentVersion: 7,
				identityRef: "identity-ref-alex",
			},
		});
		const loadDetail = vi
			.fn()
			.mockResolvedValue(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		const saveAssignment = vi.fn().mockResolvedValue(
			detail({
				devices: [device({ ...initialDevice, targetIdentityRef: "identity-ref-alex" })],
				identityChoices: identities,
				unresolvedDeviceCount: 1,
			}),
		);
		setup({ loadDetail, saveAssignment });

		await vi.waitFor(() => {
			expect(document.querySelector<HTMLSelectElement>(".legacy-team-device-select")?.value).toBe(
				"identity-ref-alex",
			);
		});
		expect(button("Save assignment").getAttribute("aria-disabled")).toBeNull();
		expect(button("Include").getAttribute("aria-disabled")).toBe("true");
		act(() => button("Save assignment").click());

		await vi.waitFor(() => {
			expect(saveAssignment).toHaveBeenCalledWith("opaque-candidate", "device-ref-one", {
				attemptId: "opaque-attempt",
				targetIdentityRef: "identity-ref-alex",
				expectation: initialDevice.expectation,
			});
			expect(loadDetail).toHaveBeenCalledTimes(1);
			expect(button("Include").getAttribute("aria-disabled")).toBeNull();
		});
	});

	it("blocks Include while a different selected assignment is unsaved", async () => {
		const savedDevice = device({
			existingIdentityRef: "identity-ref-alex",
			suggestedIdentityRef: null,
			verifiedEvidenceKind: "active_assignment",
			targetIdentityRef: "identity-ref-alex",
			expectation: {
				kind: "existing",
				assignmentVersion: 7,
				identityRef: "identity-ref-alex",
			},
		});
		const saveDecision = vi.fn();
		setup({
			loadDetail: vi
				.fn()
				.mockResolvedValue(
					detail({ devices: [savedDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
				),
			saveDecision,
		});

		const select = await vi.waitFor(() => {
			const match = document.querySelector<HTMLSelectElement>(".legacy-team-device-select");
			if (!match) throw new Error("identity select missing");
			return match;
		});
		expect(button("Include").getAttribute("aria-disabled")).toBeNull();
		select.value = "identity-ref-sam";
		act(() => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});

		expect(button("Include").getAttribute("aria-disabled")).toBe("true");
		const includeDescription = button("Include").getAttribute("aria-describedby") ?? "";
		expect(
			includeDescription
				.split(" ")
				.map((id) => document.getElementById(id)?.textContent)
				.join(" "),
		).toContain("Save the selected person assignment");
		act(() => button("Include").click());
		expect(saveDecision).not.toHaveBeenCalled();
	});

	it("blocks assignment and Include when the existing assignment evidence is inactive", async () => {
		const saveAssignment = vi.fn();
		const saveDecision = vi.fn();
		setup({
			loadDetail: vi.fn().mockResolvedValue(
				detail({
					devices: [
						device({
							existingIdentityRef: "identity-ref-alex",
							suggestedIdentityRef: null,
							targetIdentityRef: "identity-ref-alex",
							expectation: {
								kind: "existing",
								assignmentVersion: 7,
								identityRef: "identity-ref-alex",
							},
						}),
					],
					identityChoices: identities,
					unresolvedDeviceCount: 1,
				}),
			),
			saveAssignment,
			saveDecision,
		});

		await vi.waitFor(() => expect(document.body.textContent).toContain("Current assignment: Alex"));
		expect(button("Save assignment").getAttribute("aria-disabled")).toBe("true");
		expect(button("Include").getAttribute("aria-disabled")).toBe("true");
		expect(document.body.textContent).toContain("Reconcile this device in Devices or exclude it");
		act(() => {
			button("Save assignment").click();
			button("Include").click();
		});
		expect(saveAssignment).not.toHaveBeenCalled();
		expect(saveDecision).not.toHaveBeenCalled();
	});

	it("blocks assignment and inclusion when the selected person is unavailable", async () => {
		const unavailableAssignment = {
			existingIdentityRef: "identity-ref-missing",
			suggestedIdentityRef: "identity-ref-missing",
			verifiedEvidenceKind: "active_assignment" as const,
			expectation: {
				kind: "existing" as const,
				assignmentVersion: 7,
				identityRef: "identity-ref-missing",
			},
		};
		const saveAssignment = vi.fn();
		const saveDecision = vi.fn();
		setup({
			loadDetail: vi.fn().mockResolvedValue(
				detail({
					devices: [
						device({ ...unavailableAssignment, displayName: "Unsaved device" }),
						device({
							...unavailableAssignment,
							deviceRef: "device-ref-two",
							displayName: "Saved device",
							targetIdentityRef: "identity-ref-missing",
						}),
					],
					identityChoices: identities,
					unresolvedDeviceCount: 2,
				}),
			),
			saveAssignment,
			saveDecision,
		});

		const rows = await vi.waitFor(() => {
			const matches = [
				...document.querySelectorAll<HTMLFieldSetElement>(".legacy-team-device-row"),
			];
			if (matches.length !== 2) throw new Error("device rows missing");
			return matches;
		});
		const action = (row: HTMLFieldSetElement, label: string) =>
			[...row.querySelectorAll<HTMLButtonElement>("button")].find(
				(candidate) => candidate.textContent === label,
			);
		const save = action(rows[0], "Save assignment");
		const include = action(rows[1], "Include");
		expect(rows[0].textContent).toContain("This person is no longer available");
		expect(rows[1].textContent).toContain("This person is no longer available");
		expect(save?.getAttribute("aria-disabled")).toBe("true");
		expect(include?.getAttribute("aria-disabled")).toBe("true");
		expect(rows[0].querySelector("select")?.getAttribute("aria-describedby")).toContain(
			"legacy-team-device-assignment-help-0",
		);
		act(() => {
			save?.click();
			include?.click();
		});
		expect(saveAssignment).not.toHaveBeenCalled();
		expect(saveDecision).not.toHaveBeenCalled();
	});

	it("shows suggestions without treating them as reviewed assignments", async () => {
		const loadDetail = vi
			.fn()
			.mockResolvedValue(
				detail({ devices: [device()], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		setup({ loadDetail });

		const select = await vi.waitFor(() => {
			const match = document.querySelector<HTMLSelectElement>(".legacy-team-device-select");
			if (!match) throw new Error("identity select missing");
			return match;
		});
		expect(select.value).toBe("");
		expect(document.body.textContent).toContain("Suggested person: Alex");
		expect(button("Include").getAttribute("aria-disabled")).toBe("true");
	});

	it("persists exclude once while controls remain focusable and busy-guarded", async () => {
		const pendingDecision = deferred<LegacyTeamSetupDetailResponseV1>();
		const initialDevice = device();
		const excludedDevice = device({ decision: "excluded", suggestedIdentityRef: null });
		const loadDetail = vi
			.fn()
			.mockResolvedValue(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		const saveDecision = vi.fn().mockReturnValue(pendingDecision.promise);
		setup({ loadDetail, saveDecision });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Work laptop"));

		const exclude = button("Exclude");
		exclude.focus();
		act(() => {
			exclude.click();
			exclude.click();
		});
		expect(saveDecision).toHaveBeenCalledTimes(1);
		expect(saveDecision).toHaveBeenCalledWith("opaque-candidate", "device-ref-one", {
			attemptId: "opaque-attempt",
			decision: "excluded",
		});
		expect(exclude.disabled).toBe(false);
		expect(exclude.getAttribute("aria-disabled")).toBe("true");
		expect(document.activeElement).toBe(exclude);
		act(() => dialogControls.onOpenChange?.(false));
		expect(document.getElementById("legacyTeamSetupDialog")).not.toBeNull();
		expect(document.body.textContent).toContain(
			"Team setup will stay open while this change saves",
		);
		act(() => {
			openLegacyTeamSetup("another-candidate");
		});
		expect(document.body.textContent).toContain(
			"Wait for the current Team setup change to finish before opening another Team",
		);
		expect(loadDetail).toHaveBeenCalledTimes(1);

		pendingDecision.resolve(
			detail({
				devices: [excludedDevice],
				identityChoices: identities,
				unresolvedProjectCount: 1,
			}),
		);
		await vi.waitFor(() => {
			expect(document.body.textContent).toContain("Review Projects");
		});
		expect(document.activeElement?.id).toBe("legacy-team-setup-step-projects");
		expect(loadDetail).toHaveBeenCalledTimes(1);
	});

	it("keeps a saved assignment resumable when include fails, then resumes only the decision", async () => {
		const initialDevice = device({
			existingIdentityRef: "identity-ref-alex",
			suggestedIdentityRef: null,
			verifiedEvidenceKind: "active_assignment",
			expectation: {
				kind: "existing",
				assignmentVersion: 4,
				identityRef: "identity-ref-alex",
			},
		});
		const assignedDevice = device({
			...initialDevice,
			targetIdentityRef: "identity-ref-sam",
		});
		const includedDevice = device({
			...assignedDevice,
			decision: "included",
		});
		const assignedDetail = detail({
			attemptId: "attempt-after-assignment",
			devices: [assignedDevice],
			identityChoices: identities,
			unresolvedDeviceCount: 1,
		});
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(
				detail({
					attemptId: "attempt-before-assignment",
					devices: [initialDevice],
					identityChoices: identities,
					unresolvedDeviceCount: 1,
				}),
			)
			.mockResolvedValueOnce(assignedDetail);
		const saveAssignment = vi.fn().mockResolvedValue(assignedDetail);
		const saveDecision = vi
			.fn()
			.mockRejectedValueOnce(new Error("private decision failure"))
			.mockResolvedValueOnce(
				detail({
					devices: [includedDevice],
					identityChoices: identities,
					unresolvedProjectCount: 1,
				}),
			);
		setup({ loadDetail, saveAssignment, saveDecision });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Work laptop"));

		const select = document.querySelector<HTMLSelectElement>(".legacy-team-device-select");
		if (!select) throw new Error("identity select missing");
		select.value = "identity-ref-sam";
		act(() => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		act(() => button("Save assignment").click());
		await vi.waitFor(() => {
			expect(loadDetail).toHaveBeenCalledTimes(1);
			expect(button("Include").getAttribute("aria-disabled")).toBeNull();
			expect(document.querySelector<HTMLSelectElement>(".legacy-team-device-select")?.value).toBe(
				"identity-ref-sam",
			);
		});
		act(() => button("Include").click());
		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
		});
		expect(document.body.textContent).not.toContain("private decision failure");
		expect(saveAssignment).toHaveBeenCalledWith("opaque-candidate", "device-ref-one", {
			attemptId: "attempt-before-assignment",
			targetIdentityRef: "identity-ref-sam",
			expectation: {
				kind: "existing",
				assignmentVersion: 4,
				identityRef: "identity-ref-alex",
			},
		});
		expect(saveDecision).toHaveBeenLastCalledWith("opaque-candidate", "device-ref-one", {
			attemptId: "attempt-after-assignment",
			decision: "included",
			expectedTargetIdentityRef: "identity-ref-sam",
		});
		expect(document.querySelector<HTMLSelectElement>(".legacy-team-device-select")?.value).toBe(
			"identity-ref-sam",
		);

		act(() => document.getElementById("legacy-team-setup-retry")?.click());
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
		act(() => button("Include").click());
		await vi.waitFor(() => expect(document.body.textContent).toContain("Review Projects"));
		expect(saveAssignment).toHaveBeenCalledTimes(1);
		expect(saveDecision).toHaveBeenCalledTimes(2);
		expect(loadDetail).toHaveBeenCalledTimes(2);
	});

	it("persists remove for inactive devices and reloads authoritative detail", async () => {
		const initialDevice = device({ enabled: false, suggestedIdentityRef: null });
		const removedDevice = device({
			enabled: false,
			suggestedIdentityRef: null,
			decision: "removed",
		});
		const loadDetail = vi
			.fn()
			.mockResolvedValue(detail({ devices: [initialDevice], unresolvedDeviceCount: 1 }));
		const saveDecision = vi
			.fn()
			.mockResolvedValue(detail({ devices: [removedDevice], unresolvedProjectCount: 1 }));
		const saveAssignment = vi.fn();
		setup({ loadDetail, saveAssignment, saveDecision });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Device no longer active"));
		const inactiveSelect = document.querySelector<HTMLSelectElement>(".legacy-team-device-select");
		expect(inactiveSelect?.disabled).toBe(true);
		expect(
			(inactiveSelect?.getAttribute("aria-describedby") ?? "")
				.split(" ")
				.map((id) => document.getElementById(id)?.textContent)
				.join(" "),
		).toContain("Inactive devices can only be removed");
		expect(button("Save assignment").getAttribute("aria-disabled")).toBe("true");
		act(() => button("Save assignment").click());
		expect(saveAssignment).not.toHaveBeenCalled();

		act(() => button("Remove").click());
		await vi.waitFor(() => expect(document.body.textContent).toContain("Review Projects"));
		expect(saveDecision).toHaveBeenCalledWith("opaque-candidate", "device-ref-one", {
			attemptId: "opaque-attempt",
			decision: "removed",
		});
		expect(loadDetail).toHaveBeenCalledTimes(1);
	});

	it("applies the authoritative device mutation response without a compensating reload", async () => {
		const loadDetail = vi
			.fn()
			.mockResolvedValue(
				detail({ devices: [device()], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		const saveDecision = vi.fn().mockResolvedValue(
			detail({
				devices: [device({ decision: "excluded", suggestedIdentityRef: null })],
				unresolvedProjectCount: 1,
			}),
		);
		setup({ loadDetail, saveDecision });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Work laptop"));

		act(() => button("Exclude").click());

		await vi.waitFor(() => expect(document.body.textContent).toContain("Review Projects"));
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(saveDecision).toHaveBeenCalledTimes(1);
		expect(loadDetail).toHaveBeenCalledTimes(1);
	});

	it("clears a persisted decision with the current attempt and reloads detail", async () => {
		const excludedDevice = device({ decision: "excluded", suggestedIdentityRef: null });
		const loadDetail = vi
			.fn()
			.mockResolvedValue(detail({ devices: [excludedDevice], unresolvedDeviceCount: 0 }));
		const clearDecision = vi
			.fn()
			.mockResolvedValue(
				detail({ devices: [device()], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		setup({ clearDecision, loadDetail });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Review and finish"));
		act(() => button("Devices").click());
		expect(document.body.textContent).toContain("Clear decision");

		act(() => button("Clear decision").click());
		await vi.waitFor(() => expect(document.body.textContent).toContain("Needs a decision"));
		expect(clearDecision).toHaveBeenCalledWith("opaque-candidate", "device-ref-one", {
			attemptId: "opaque-attempt",
		});
		expect(loadDetail).toHaveBeenCalledTimes(1);
	});

	it("reloads authoritative detail after a stale mutation and blocks more changes safely", async () => {
		const initialDevice = device();
		const refreshedDevice = device({
			existingIdentityRef: "identity-ref-sam",
			suggestedIdentityRef: null,
			expectation: {
				kind: "existing",
				assignmentVersion: 9,
				identityRef: "identity-ref-sam",
			},
		});
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			)
			.mockResolvedValueOnce(
				detail({
					attemptId: "fresh-attempt",
					devices: [refreshedDevice],
					identityChoices: identities,
					unresolvedDeviceCount: 1,
				}),
			);
		const refreshCandidate = vi.fn().mockResolvedValue(
			detail({
				attemptId: "refreshed-attempt",
				devices: [refreshedDevice],
				identityChoices: identities,
				unresolvedDeviceCount: 1,
			}),
		);
		const saveDecision = vi
			.fn()
			.mockRejectedValue(new LegacyTeamSetupApiError(409, "team_setup_assignment_changed"));
		setup({ loadDetail, refreshCandidate, saveDecision });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Work laptop"));

		act(() => button("Exclude").click());
		await vi.waitFor(() => {
			expect(document.body.textContent).toContain("changed since it was last reviewed");
			expect(document.body.textContent).toContain("Current assignment: Sam");
		});
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"changed since it was last reviewed",
		);
		expect(loadDetail).toHaveBeenCalledTimes(2);
		const exclude = button("Exclude");
		expect(exclude.disabled).toBe(false);
		expect(exclude.getAttribute("aria-disabled")).toBe("true");
		exclude.focus();
		expect(document.activeElement).toBe(exclude);

		act(() => document.getElementById("legacy-team-setup-retry")?.click());
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
		expect(refreshCandidate).toHaveBeenCalledWith("opaque-candidate");
		expect(loadDetail).toHaveBeenCalledTimes(2);
	});

	it("uses an unavailable mutation view to block edits until authoritative refresh", async () => {
		const initialDevice = device();
		const loadDetail = vi
			.fn()
			.mockResolvedValue(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		const refreshCandidate = vi
			.fn()
			.mockResolvedValue(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		setup({
			loadDetail,
			refreshCandidate,
			saveDecision: vi.fn().mockResolvedValue(
				detail({
					draftState: "stale",
					devices: [initialDevice],
					identityChoices: identities,
					unresolvedDeviceCount: 1,
				}),
			),
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Work laptop"));

		act(() => button("Exclude").click());
		await vi.waitFor(() =>
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"changed since it was last reviewed",
			),
		);
		act(() => document.getElementById("legacy-team-setup-refresh")?.click());

		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
		expect(refreshCandidate).toHaveBeenCalledWith("opaque-candidate");
		expect(loadDetail).toHaveBeenCalledTimes(1);
	});

	it("shows deterministic Project mappings as read-only server evidence", async () => {
		const deterministic = project({
			canonicalProjectRef: "opaque-canonical-project",
			mappingChoices: [],
			resolution: "deterministic",
			resolvedProjectRef: "opaque-resolved-project",
		});
		const unresolved = project({ projectRef: "project-ref-two", displayName: "Needs mapping" });
		const loadDetail = vi.fn().mockResolvedValue(
			detail({
				projects: [deterministic, unresolved],
				unresolvedProjectCount: 1,
			}),
		);
		setup({ loadDetail });

		await vi.waitFor(() => expect(document.body.textContent).toContain("Mapped automatically"));
		expect(document.body.textContent).toContain("Legacy Project");
		expect(document.body.textContent).not.toContain("opaque-canonical-project");
		expect(document.querySelectorAll(".legacy-team-project-select")).toHaveLength(1);
	});

	it("stacks all Project rows with legends outside their inner grid content", async () => {
		const projects = Array.from({ length: 12 }, (_, index) =>
			project({
				projectRef: `project-ref-${index + 1}`,
				displayName: `Project ${index + 1} with a very long display name that must wrap inside the dialog`,
			}),
		);
		setup({
			loadDetail: vi.fn().mockResolvedValue(
				detail({
					projects,
					unresolvedProjectCount: projects.length,
				}),
			),
		});

		const rows = await vi.waitFor(() => {
			const matches = [
				...document.querySelectorAll<HTMLFieldSetElement>(".legacy-team-project-row"),
			];
			if (matches.length !== projects.length) throw new Error("Project rows missing");
			return matches;
		});

		expect(rows).toHaveLength(12);
		for (const [index, row] of rows.entries()) {
			expect(row.children[0]?.tagName).toBe("LEGEND");
			expect(row.children[0]?.textContent).toContain(`Project ${index + 1}`);
			expect(row.children[1]?.classList.contains("legacy-team-project-row-content")).toBe(true);
		}
	});

	it("states that every automatically mapped Project will be included", async () => {
		// Arrange
		const deterministic = project({
			canonicalProjectRef: "opaque-canonical-project",
			mappingChoices: [],
			resolution: "deterministic",
			resolvedProjectRef: "opaque-resolved-project",
		});
		setup({
			loadDetail: vi.fn().mockResolvedValue(
				detail({
					projects: [
						deterministic,
						project({ projectRef: "project-ref-two", displayName: "Needs mapping" }),
					],
					unresolvedProjectCount: 1,
				}),
			),
		});

		// Act
		const projectsStep = await vi.waitFor(() => {
			const match = document.querySelector<HTMLElement>(
				'[aria-labelledby="legacy-team-setup-step-projects"]',
			);
			if (!match) throw new Error("Projects step missing");
			return match;
		});

		// Assert
		expect(projectsStep.textContent).toContain("1 of 2 Team Projects need attention.");
		expect(projectsStep.textContent).toContain(
			"Review the automatic mappings below before continuing.",
		);
		expect(projectsStep.textContent).not.toMatch(/confirm the automatic/i);
		expect(projectsStep.textContent).not.toContain("1 of 0 Team Projects");
		expect(projectsStep.textContent).not.toMatch(
			/choose (?:or|and) exclude automatically mapped Projects/i,
		);
		expect(projectsStep.querySelectorAll(".legacy-team-project-select")).toHaveLength(1);
	});

	it("persists one explicit Project mapping and applies the authoritative response", async () => {
		const initialProject = project();
		const mappedProject = project({
			resolution: "explicit",
			resolvedProjectRef: "resolved-project-beta",
		});
		const loadDetail = vi
			.fn()
			.mockResolvedValue(detail({ projects: [initialProject], unresolvedProjectCount: 1 }));
		const saveProjectMapping = vi.fn().mockResolvedValue(detail({ projects: [mappedProject] }));
		setup({ loadDetail, saveProjectMapping });

		const select = await vi.waitFor(() => {
			const match = document.querySelector<HTMLSelectElement>(".legacy-team-project-select");
			if (!match) throw new Error("Project mapping select missing");
			return match;
		});
		expect([...select.options].map((option) => option.textContent)).toEqual([
			"Choose a Project",
			"Project Alpha",
			"Project Beta",
		]);
		select.value = "project-choice-2";
		act(() => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(saveProjectMapping).not.toHaveBeenCalled();
		act(() => {
			button("Save mapping").click();
			button("Save mapping").click();
		});

		expect(saveProjectMapping).toHaveBeenCalledTimes(1);
		expect(saveProjectMapping).toHaveBeenCalledWith("opaque-candidate", "project-ref-one", {
			attemptId: "opaque-attempt",
			resolvedProjectRef: "resolved-project-beta",
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Review and finish"));
		expect(document.activeElement?.id).toBe("legacy-team-setup-step-review");
		expect(loadDetail).toHaveBeenCalledTimes(1);
	});

	it("gives reversed same-label mapping choices stable private labels and saves the exact choice", async () => {
		const privatePath = "/private/worktrees/codemem";
		const privateRemote = "ssh://git@private.example.test/codemem.git";
		const mappingChoices = [
			{ resolvedProjectRef: privateRemote, displayName: "codemem" },
			{ resolvedProjectRef: privatePath, displayName: "codemem" },
		];
		const initialProject = project({ mappingChoices });
		const mappedProject = project({
			mappingChoices,
			resolution: "explicit",
			resolvedProjectRef: privatePath,
		});
		const loadDetail = vi
			.fn()
			.mockResolvedValue(detail({ projects: [initialProject], unresolvedProjectCount: 1 }));
		const saveProjectMapping = vi.fn().mockResolvedValue(detail({ projects: [mappedProject] }));
		setup({ loadDetail, saveProjectMapping });

		const select = await vi.waitFor(() => {
			const match = document.querySelector<HTMLSelectElement>(".legacy-team-project-select");
			if (!match) throw new Error("Project mapping select missing");
			return match;
		});
		expect([...select.options].map((option) => option.textContent)).toEqual([
			"Choose a Project",
			"codemem — Project 2 of 2",
			"codemem — Project 1 of 2",
		]);
		expect([...select.options].map((option) => option.value)).toEqual([
			"",
			"project-choice-2",
			"project-choice-1",
		]);
		expect(document.body.outerHTML).not.toContain(privatePath);
		expect(document.body.outerHTML).not.toContain(privateRemote);

		select.value = "project-choice-1";
		act(() => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		act(() => button("Save mapping").click());

		expect(saveProjectMapping).toHaveBeenCalledWith("opaque-candidate", "project-ref-one", {
			attemptId: "opaque-attempt",
			resolvedProjectRef: privatePath,
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Review and finish"));
		expect(document.body.outerHTML).not.toContain(privatePath);
		expect(document.body.outerHTML).not.toContain(privateRemote);
	});

	it("reloads stale Project mapping evidence and keeps safe recovery copy", async () => {
		const initialProject = project();
		const refreshedProject = project({
			mappingChoices: [
				{ resolvedProjectRef: "resolved-project-gamma", displayName: "Project Gamma" },
			],
		});
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(detail({ projects: [initialProject], unresolvedProjectCount: 1 }))
			.mockResolvedValueOnce(
				detail({
					attemptId: "fresh-attempt",
					projects: [refreshedProject],
					unresolvedProjectCount: 1,
				}),
			)
			.mockResolvedValue(
				detail({
					attemptId: "fresh-attempt",
					projects: [refreshedProject],
					unresolvedProjectCount: 1,
				}),
			);
		const saveProjectMapping = vi
			.fn()
			.mockRejectedValue(new LegacyTeamSetupApiError(409, "team_setup_confirmation_stale"));
		const refreshCandidate = vi.fn().mockResolvedValue(
			detail({
				attemptId: "fresh-attempt",
				projects: [refreshedProject],
				unresolvedProjectCount: 1,
			}),
		);
		setup({ loadDetail, refreshCandidate, saveProjectMapping });

		const select = await vi.waitFor(() => {
			const match = document.querySelector<HTMLSelectElement>(".legacy-team-project-select");
			if (!match) throw new Error("Project mapping select missing");
			return match;
		});
		select.value = "project-choice-1";
		act(() => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		act(() => button("Save mapping").click());

		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"changed since it was last reviewed",
			);
			expect(document.body.textContent).toContain("Project Gamma");
			expect(document.querySelector<HTMLSelectElement>(".legacy-team-project-select")?.value).toBe(
				"",
			);
		});
		expect(document.body.textContent).not.toContain("team_setup_confirmation_stale");
		expect(loadDetail).toHaveBeenCalledTimes(2);
		expect(document.querySelector<HTMLSelectElement>(".legacy-team-project-select")?.disabled).toBe(
			true,
		);
		expect(button("Save mapping").getAttribute("aria-disabled")).toBe("true");

		act(() => document.getElementById("legacy-team-setup-retry")?.click());
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
		expect(document.querySelector<HTMLSelectElement>(".legacy-team-project-select")?.value).toBe(
			"",
		);
		expect(button("Save mapping").getAttribute("aria-disabled")).toBe("true");
		expect(loadDetail).toHaveBeenCalledTimes(2);
		expect(refreshCandidate).toHaveBeenCalledWith("opaque-candidate");
	});

	it("does not reload after an authoritative Project mapping response", async () => {
		const loadDetail = vi
			.fn()
			.mockResolvedValue(detail({ projects: [project()], unresolvedProjectCount: 1 }));
		const saveProjectMapping = vi.fn().mockResolvedValue(
			detail({
				projects: [
					project({ resolution: "explicit", resolvedProjectRef: "resolved-project-alpha" }),
				],
			}),
		);
		setup({ loadDetail, saveProjectMapping });

		const select = await vi.waitFor(() => {
			const match = document.querySelector<HTMLSelectElement>(".legacy-team-project-select");
			if (!match) throw new Error("Project mapping select missing");
			return match;
		});
		select.value = "project-choice-1";
		act(() => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		act(() => button("Save mapping").click());

		await vi.waitFor(() => expect(document.body.textContent).toContain("Review and finish"));
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(saveProjectMapping).toHaveBeenCalledTimes(1);
		expect(loadDetail).toHaveBeenCalledTimes(1);
	});

	it("renders every server access-delta entry with human labels and no opaque refs", async () => {
		const reviewedDevice = device({
			decision: "included",
			existingIdentityRef: "identity-ref-alex",
			targetIdentityRef: "identity-ref-alex",
		});
		const reviewedProject = project({
			canonicalProjectRef: "canonical-project-ref",
			resolution: "explicit",
			resolvedProjectRef: "resolved-project-beta",
		});
		const loadDetail = vi.fn().mockResolvedValue(
			detail({
				canFinish: true,
				devices: [reviewedDevice],
				identityChoices: identities,
				projects: [reviewedProject],
				accessDelta: {
					teamChanges: [
						{
							teamRef: "opaque-team-ref",
							teamDisplayName: "Example Team",
							change: "update",
							fromDeviceEligibilityMode: "person_all_devices",
							toDeviceEligibilityMode: "reviewed_allowlist",
						},
					],
					membershipChanges: [
						{
							teamRef: "opaque-team-ref",
							teamDisplayName: "Example Team",
							identityRef: "identity-ref-alex",
							identityDisplayName: "Alex",
							change: "add",
						},
					],
					projectChanges: [
						{
							projectRef: "project-ref-one",
							projectDisplayName: "Legacy Project",
							fromResolvedProjectRef: "resolved-project-old",
							fromResolvedProjectDisplayName: "Previous Project",
							toResolvedProjectRef: "resolved-project-beta",
							toResolvedProjectDisplayName: "Project Beta",
							change: "update",
						},
					],
					recipientChanges: [
						{
							canonicalProjectRef: "canonical-project-ref",
							canonicalProjectDisplayName: "Legacy Project",
							recipientKind: "team",
							recipientRef: "opaque-team-ref",
							recipientDisplayName: "Example Team",
							change: "add",
						},
					],
					deviceAccessChanges: [
						{
							canonicalProjectRef: "canonical-project-ref",
							canonicalProjectDisplayName: "Legacy Project",
							deviceRef: "device-ref-one",
							deviceDisplayName: "Work laptop",
							change: "add",
						},
						{
							canonicalProjectRef: "external-canonical-project-ref",
							canonicalProjectDisplayName: "External Project",
							deviceRef: "external-device-ref",
							deviceDisplayName: "External laptop",
							change: "remove",
						},
					],
				},
			}),
		);
		setup({ loadDetail });

		await vi.waitFor(() => expect(document.body.textContent).toContain("Review Projects"));
		act(() => button("Review").click());
		expect(document.body.textContent).toContain("Review every");
		const text = document.body.textContent ?? "";
		expect(text).toContain(
			"Update Example Team: change device access from all devices assigned to each person to the reviewed device list.",
		);
		expect(text).toContain("Add Alex to Example Team.");
		expect(text).toContain("Update Legacy Project: Previous Project to Project Beta.");
		expect(text).toContain("Add Example Team as a recipient for Legacy Project.");
		expect(text).toContain("Add Work laptop access to Legacy Project.");
		expect(text).toContain("Remove External laptop access from External Project.");
		expect(text).toContain("6 exact access changes to review.");
		expect(text).not.toContain("opaque-team-ref");
		expect(text).not.toContain("resolved-project-old");
		expect(document.querySelectorAll(".legacy-team-setup-exact-list li")).toHaveLength(6);
		expect(document.querySelectorAll(".legacy-team-setup-delta details")).toHaveLength(0);
	});

	it("summarizes a 63 Project by 6 device migration while preserving all 509 exact rows", async () => {
		const devices = Array.from({ length: 6 }, (_, index) =>
			device({
				deviceRef: `internal-device-ref-${index + 1}`,
				displayName: index < 2 ? "Work laptop" : `Device ${index + 1}`,
				decision: "included",
				existingIdentityRef: `internal-identity-ref-${index + 1}`,
				suggestedIdentityRef: null,
				targetIdentityRef: `internal-identity-ref-${index + 1}`,
			}),
		);
		const projects = Array.from({ length: 63 }, (_, index) => {
			const displayName = index < 34 ? "greenroom" : `Project ${index + 1}`;
			return project({
				projectRef: `internal-project-ref-${index + 1}`,
				displayName,
				resolution: "deterministic",
				canonicalProjectRef: `internal-canonical-ref-${index + 1}`,
				resolvedProjectRef: `internal-resolved-ref-${index + 1}`,
				mappingChoices: [],
			});
		});
		const accessDelta: LegacyTeamSetupAccessDeltaV1 = {
			teamChanges: [
				{
					teamRef: "internal-team-ref",
					teamDisplayName: "Example Team",
					change: "update",
					fromDeviceEligibilityMode: "person_all_devices",
					toDeviceEligibilityMode: "reviewed_allowlist",
				},
			],
			membershipChanges: Array.from({ length: 4 }, (_, index) => ({
				teamRef: "internal-team-ref",
				teamDisplayName: "Example Team",
				identityRef: `internal-member-ref-${index + 1}`,
				identityDisplayName: `Person ${index + 1}`,
				change: "add" as const,
			})),
			projectChanges: projects.map((entry) => ({
				projectRef: entry.projectRef,
				projectDisplayName: entry.displayName,
				fromResolvedProjectRef: null,
				fromResolvedProjectDisplayName: null,
				toResolvedProjectRef: entry.resolvedProjectRef,
				toResolvedProjectDisplayName: entry.displayName,
				change: "add" as const,
			})),
			recipientChanges: projects.map((entry) => ({
				canonicalProjectRef: entry.canonicalProjectRef ?? "",
				canonicalProjectDisplayName: entry.displayName,
				recipientKind: "team" as const,
				recipientRef: "internal-team-ref",
				recipientDisplayName: "Example Team",
				change: "add" as const,
			})),
			deviceAccessChanges: projects.flatMap((entry) =>
				devices.map((entryDevice) => ({
					canonicalProjectRef: entry.canonicalProjectRef ?? "",
					canonicalProjectDisplayName: entry.displayName,
					deviceRef: entryDevice.deviceRef,
					deviceDisplayName: entryDevice.displayName,
					change: "add" as const,
				})),
			),
		};
		setup({
			loadDetail: vi.fn().mockResolvedValue(
				detail({
					canFinish: true,
					devices,
					projects,
					accessDelta,
				}),
			),
		});

		await vi.waitFor(() => expect(document.body.textContent).toContain("Review Projects"));
		act(() => button("Review").click());
		const review = document.querySelector<HTMLElement>(
			'[aria-labelledby="legacy-team-setup-step-review"]',
		);
		if (!review) throw new Error("Review step missing");
		const section = (title: string) => {
			const heading = [...review.querySelectorAll("h4")].find(
				(candidate) => candidate.textContent === title,
			);
			if (!(heading?.parentElement instanceof HTMLElement)) {
				throw new Error(`${title} section missing`);
			}
			return heading.parentElement;
		};

		expect(review.textContent).toContain("509 exact access changes");
		expect(review.textContent).toContain("1 Team policy change");
		expect(review.textContent).toContain("4 membership changes");
		expect(review.textContent).toContain("63 Project changes");
		expect(review.textContent).toContain("63 recipient changes");
		expect(review.textContent).toContain("63 Projects included");
		expect(review.textContent).toContain("6 included devices");
		expect(review.textContent).toContain("378 device-access changes");
		expect(section("Projects").textContent).toContain(
			"greenroom — 34 Projects with this name, 34 Project changes",
		);
		expect(section("Recipients").textContent).toContain(
			"greenroom — 34 Projects with this name, 34 recipient changes",
		);
		expect(section("Device access").textContent).toContain(
			"greenroom — 34 Projects with this name, 204 device-access changes",
		);
		expect(review.textContent).not.toContain("internal-");

		const expectedExactRows = new Map([
			["Team policy", 1],
			["Memberships", 4],
			["Projects", 63],
			["Recipients", 63],
			["Device access", 378],
		]);
		for (const [title, expectedCount] of expectedExactRows) {
			expect(section(title).querySelectorAll(".legacy-team-setup-exact-list > li")).toHaveLength(
				expectedCount,
			);
		}
		expect(review.querySelectorAll(".legacy-team-setup-exact-list > li")).toHaveLength(509);
		expect(
			[...review.querySelectorAll("details > summary")].map((summary) => summary.textContent),
		).toEqual([
			"Show all 63 exact Project changes",
			"Show all 63 exact recipient changes",
			"Show all 378 exact device-access changes",
		]);
		expect(review.querySelectorAll("details")).toHaveLength(3);
		expect([...review.querySelectorAll("details")].every((details) => !details.open)).toBe(true);
		expect(
			[...section("Projects").querySelectorAll(".legacy-team-setup-exact-list > li")].filter(
				(row) => row.textContent === "Add greenroom: no Project to greenroom.",
			),
		).toHaveLength(34);
		expect(
			[...section("Device access").querySelectorAll(".legacy-team-setup-exact-list > li")].filter(
				(row) => row.textContent === "Add Work laptop access to greenroom.",
			),
		).toHaveLength(68);
	});

	it("keeps a large exact section visible when its labels cannot be usefully grouped", async () => {
		const accessDelta: LegacyTeamSetupAccessDeltaV1 = {
			teamChanges: [],
			membershipChanges: [],
			projectChanges: Array.from({ length: 11 }, (_, index) => ({
				projectRef: `opaque-project-${index}`,
				projectDisplayName: `Project ${index + 1}`,
				fromResolvedProjectRef: null,
				fromResolvedProjectDisplayName: null,
				toResolvedProjectRef: `opaque-resolved-project-${index}`,
				toResolvedProjectDisplayName: `Project ${index + 1}`,
				change: "add" as const,
			})),
			recipientChanges: [],
			deviceAccessChanges: [],
		};
		setup({
			loadDetail: vi.fn().mockResolvedValue(detail({ canFinish: true, accessDelta })),
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("11 exact access changes"));

		const heading = [...document.querySelectorAll(".legacy-team-setup-delta h4")].find(
			(candidate) => candidate.textContent === "Projects",
		);
		const projects = heading?.parentElement;
		if (!projects) throw new Error("Projects section missing");
		expect(projects.querySelector("details")).toBeNull();
		expect(projects.querySelector(".legacy-team-setup-delta-summary")).toBeNull();
		expect(projects.querySelectorAll(".legacy-team-setup-exact-list > li")).toHaveLength(11);
	});

	it("requires explicit confirmation and submits exact displayed finish evidence once", async () => {
		const pendingFinish = deferred<{
			version: 1;
			status: "completed";
			teamRef: string;
			attemptId: string;
			accessDeltaDigest: string;
			completedAt: string;
		}>();
		const finish = vi.fn().mockReturnValue(pendingFinish.promise);
		const onCompleted = vi.fn();
		const accessDelta: LegacyTeamSetupAccessDeltaV1 = {
			teamChanges: [],
			membershipChanges: [],
			projectChanges: Array.from({ length: 11 }, (_, index) => ({
				projectRef: "opaque-project-ref",
				projectDisplayName: "Legacy Project",
				fromResolvedProjectRef: null,
				fromResolvedProjectDisplayName: null,
				toResolvedProjectRef: "opaque-resolved-project-ref",
				toResolvedProjectDisplayName: "Canonical Project",
				change: index % 2 === 0 ? ("add" as const) : ("remove" as const),
			})),
			recipientChanges: [],
			deviceAccessChanges: [],
		};
		setup({
			finish,
			loadDetail: vi.fn().mockResolvedValue(detail({ canFinish: true, accessDelta })),
			onCompleted,
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Finish Team setup"));

		const finishButton = button("Finish Team setup");
		expect(finishButton.getAttribute("aria-disabled")).toBe("true");
		act(() => finishButton.click());
		expect(finish).not.toHaveBeenCalled();
		const summaries = [...document.querySelectorAll<HTMLElement>("details > summary")];
		expect(summaries).toHaveLength(1);
		expect(document.body.textContent).toContain(
			"Legacy Project — 1 Project with this name, 11 Project changes",
		);
		for (const summary of summaries) act(() => summary.click());
		expect(finishButton.getAttribute("aria-disabled")).toBe("true");
		const confirmation = document.querySelector<HTMLInputElement>(
			".legacy-team-setup-confirmation input",
		);
		if (!confirmation) throw new Error("finish confirmation missing");
		confirmation.checked = true;
		act(() => {
			confirmation.dispatchEvent(new Event("change", { bubbles: true }));
		});
		for (const summary of summaries) {
			act(() => summary.click());
			act(() => summary.click());
		}
		expect(confirmation.checked).toBe(true);
		expect(finishButton.getAttribute("aria-disabled")).toBeNull();
		act(() => {
			finishButton.click();
			finishButton.click();
		});
		expect(finish).toHaveBeenCalledTimes(1);
		expect(finish).toHaveBeenCalledWith("opaque-candidate", {
			attemptId: "opaque-attempt",
			finishDigest: "opaque-finish-digest",
			confirmedAccessDeltaDigest: "opaque-access-digest",
			confirmedViewerAccessDeltaDigest: "opaque-viewer-access-digest",
		});
		expect(confirmation.getAttribute("aria-disabled")).toBe("true");
		expect(confirmation.getAttribute("aria-describedby")).toBeTruthy();
		act(() => confirmation.click());
		expect(confirmation.checked).toBe(true);

		pendingFinish.resolve({
			version: 1,
			status: "completed",
			teamRef: "opaque-team-ref",
			attemptId: "opaque-attempt",
			accessDeltaDigest: "opaque-access-digest",
			completedAt: "2026-08-25T00:00:00.000Z",
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Team setup complete"));
		expect(document.activeElement?.id).toBe("legacy-team-setup-step-completed");
		expect(onCompleted).toHaveBeenCalledTimes(1);
	});

	it("ignores a completion refresh after closing and opening another Team", async () => {
		const completedRefresh = deferred<void>();
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(detail({ canFinish: true }))
			.mockResolvedValueOnce(detail({ devices: [device()], unresolvedDeviceCount: 1 }));
		setup({
			finish: vi.fn().mockResolvedValue({
				version: 1,
				status: "completed",
				teamRef: "opaque-team-ref",
				attemptId: "opaque-attempt",
				accessDeltaDigest: "opaque-access-digest",
				completedAt: "2026-08-25T00:00:00.000Z",
			}),
			loadDetail,
			onCompleted: vi.fn().mockReturnValue(completedRefresh.promise),
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Finish Team setup"));
		const confirmation = document.querySelector<HTMLInputElement>(
			".legacy-team-setup-confirmation input",
		);
		if (!confirmation) throw new Error("finish confirmation missing");
		confirmation.checked = true;
		act(() => {
			confirmation.dispatchEvent(new Event("change", { bubbles: true }));
		});
		act(() => button("Finish Team setup").click());
		await vi.waitFor(() => expect(document.body.textContent).toContain("Team setup complete"));

		act(() => dialogControls.onOpenChange?.(false));
		act(() => {
			openLegacyTeamSetup("another-candidate");
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Review devices"));
		expect(document.body.textContent).not.toContain("Team setup complete. Sharing and Projects");

		await act(async () => {
			completedRefresh.resolve();
			await Promise.resolve();
		});
		expect(document.body.textContent).not.toContain("Sharing and Projects are up to date");
	});

	it("reuses an in-flight completion refresh when reopening the same attempt", async () => {
		const completedRefresh = deferred<void>();
		const completedDetail = detail({ draftState: "completed" });
		const onCompleted = vi.fn().mockReturnValue(completedRefresh.promise);
		setup({
			finish: vi.fn().mockResolvedValue({
				version: 1,
				status: "completed",
				teamRef: "opaque-team-ref",
				attemptId: "opaque-attempt",
				accessDeltaDigest: "opaque-access-digest",
				completedAt: "2026-08-25T00:00:00.000Z",
			}),
			loadDetail: vi
				.fn()
				.mockResolvedValueOnce(detail({ canFinish: true }))
				.mockResolvedValueOnce(completedDetail),
			onCompleted,
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Finish Team setup"));
		const confirmation = document.querySelector<HTMLInputElement>(
			".legacy-team-setup-confirmation input",
		);
		if (!confirmation) throw new Error("finish confirmation missing");
		confirmation.checked = true;
		act(() => {
			confirmation.dispatchEvent(new Event("change", { bubbles: true }));
		});
		act(() => button("Finish Team setup").click());
		await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(button("Close").getAttribute("aria-disabled")).toBeNull());

		act(() => dialogControls.onOpenChange?.(false));
		act(() => {
			openLegacyTeamSetup("opaque-candidate");
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Team setup complete"));
		expect(onCompleted).toHaveBeenCalledTimes(1);

		await act(async () => {
			completedRefresh.reject(new Error("private refresh failure"));
			await Promise.resolve();
		});
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				"Sharing or Projects could not be refreshed; use that view's Refresh control.",
			),
		);
		expect(document.body.textContent).not.toContain("private refresh failure");
	});

	it("refreshes completed surfaces again after the previous refresh settles", async () => {
		const onCompleted = vi.fn().mockResolvedValue(undefined);
		setup({
			loadDetail: vi.fn().mockResolvedValue(detail({ draftState: "completed" })),
			onCompleted,
		});
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				"Team setup complete. Sharing and Projects are up to date.",
			),
		);
		expect(onCompleted).toHaveBeenCalledTimes(1);

		act(() => dialogControls.onOpenChange?.(false));
		act(() => {
			openLegacyTeamSetup("opaque-candidate");
		});

		await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(2));
	});

	it("offers an explicit server refresh when final confirmation is not ready", async () => {
		const refreshCandidate = vi.fn().mockResolvedValue(detail({ canFinish: true }));
		const loadDetail = vi.fn().mockResolvedValue(detail());
		setup({ loadDetail, refreshCandidate });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Refresh Team setup"));
		expect(document.getElementById("legacy-team-setup-retry")).toBeNull();

		act(() => button("Refresh Team setup").click());

		await vi.waitFor(() => expect(document.body.textContent).toContain("Finish Team setup"));
		expect(refreshCandidate).toHaveBeenCalledWith("opaque-candidate");
		expect(loadDetail).toHaveBeenCalledTimes(1);
	});

	it("refreshes dependent views when an explicit refresh discovers completion", async () => {
		const onCompleted = vi.fn();
		const refreshCandidate = vi.fn().mockResolvedValue(
			detail({
				conflictState: "team_setup_conflict",
				draftState: "completed",
				devices: [device()],
				unresolvedDeviceCount: 1,
			}),
		);
		const loadDetail = vi.fn().mockResolvedValue(detail());
		setup({ loadDetail, onCompleted, refreshCandidate });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Refresh Team setup"));

		act(() => button("Refresh Team setup").click());

		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				"Team setup complete. Sharing and Projects are up to date.",
			),
		);
		expect(onCompleted).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(document.body.textContent).not.toContain("Review devices");
	});

	it("allows an unresolved stale draft to refresh from its current step", async () => {
		const refreshCandidate = vi
			.fn()
			.mockResolvedValue(detail({ devices: [device()], unresolvedDeviceCount: 1 }));
		const loadDetail = vi
			.fn()
			.mockResolvedValue(
				detail({ draftState: "stale", devices: [device()], unresolvedDeviceCount: 1 }),
			);
		setup({ loadDetail, refreshCandidate });

		await vi.waitFor(() => expect(document.body.textContent).toContain("Refresh Team setup"));
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"changed since it was last reviewed",
		);
		expect(document.getElementById("legacy-team-setup-retry")).toBeNull();
		expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Devices");

		act(() => button("Refresh Team setup").click());

		await vi.waitFor(() => expect(document.body.textContent).toContain("Team setup refreshed."));
		expect(refreshCandidate).toHaveBeenCalledWith("opaque-candidate");
		expect(loadDetail).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});

	it("offers refresh for a roster-unavailable draft from the Devices step", async () => {
		const unavailable = detail({
			conflictState: "team_setup_roster_unavailable",
			draftState: "stale",
			devices: [device()],
			unresolvedDeviceCount: 1,
		});
		const refreshCandidate = vi.fn().mockResolvedValue(
			detail({
				devices: [device()],
				unresolvedDeviceCount: 1,
			}),
		);
		setup({ loadDetail: vi.fn().mockResolvedValue(unavailable), refreshCandidate });

		await vi.waitFor(() => expect(document.body.textContent).toContain("Refresh Team setup"));
		expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Devices");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Team device details are temporarily unavailable",
		);

		act(() => button("Refresh Team setup").click());

		await vi.waitFor(() => expect(refreshCandidate).toHaveBeenCalledWith("opaque-candidate"));
	});

	it("shows Projects again when refresh returns a new setup attempt", async () => {
		const refreshCandidate = vi.fn();
		const oldProject = project({
			displayName: "Old automatic Project",
			resolution: "deterministic",
		});
		const newProject = project({
			displayName: "New automatic Project",
			projectRef: "new-project-ref",
			resolution: "deterministic",
		});
		const fresh = detail({
			attemptId: "new-attempt",
			canFinish: true,
			projects: [newProject],
		});
		refreshCandidate.mockResolvedValue(fresh);
		const loadDetail = vi.fn().mockResolvedValue(
			detail({
				attemptId: "old-attempt",
				draftState: "stale",
				projects: [oldProject],
			}),
		);
		setup({ loadDetail, refreshCandidate });

		await vi.waitFor(() => expect(document.body.textContent).toContain("Old automatic Project"));
		act(() => button("Refresh Team setup").click());

		await vi.waitFor(() => expect(document.body.textContent).toContain("New automatic Project"));
		expect(document.querySelector('button[aria-current="step"]')?.textContent).toBe("Projects");
		expect(document.body.textContent).not.toContain("Review and finish");
	});

	it("reports a refresh failure as a refresh failure without private details", async () => {
		const refreshCandidate = vi.fn().mockRejectedValue(new Error("private refresh response"));
		setup({ loadDetail: vi.fn().mockResolvedValue(detail()), refreshCandidate });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Refresh Team setup"));

		act(() => button("Refresh Team setup").click());

		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"Team setup could not be refreshed",
			);
		});
		expect(document.body.textContent).not.toContain("private refresh response");
		expect(document.body.textContent).not.toContain("device change could not be saved");
	});

	it("fails closed and resets confirmation when finish evidence becomes stale", async () => {
		const accessDelta = (identityDisplayName: string): LegacyTeamSetupAccessDeltaV1 => ({
			teamChanges: [],
			membershipChanges: [
				{
					teamRef: "opaque-team-ref",
					teamDisplayName: "Example Team",
					identityRef: "opaque-identity-ref",
					identityDisplayName,
					change: "add",
				},
			],
			projectChanges: [],
			recipientChanges: [],
			deviceAccessChanges: [],
		});
		const initial = detail({ canFinish: true, accessDelta: accessDelta("Alex") });
		const refreshed = detail({
			canFinish: true,
			accessDelta: accessDelta("Sam"),
			viewerAccessDeltaDigest: "fresh-viewer-access-digest",
		});
		const loadDetail = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
		const finish = vi
			.fn()
			.mockRejectedValue(new LegacyTeamSetupApiError(409, "team_setup_confirmation_stale"));
		setup({ finish, loadDetail });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Finish Team setup"));
		const confirmation = document.querySelector<HTMLInputElement>(
			".legacy-team-setup-confirmation input",
		);
		if (!confirmation) throw new Error("finish confirmation missing");
		confirmation.checked = true;
		act(() => {
			confirmation.dispatchEvent(new Event("change", { bubbles: true }));
		});
		act(() => button("Finish Team setup").click());

		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("changed since it was last reviewed"),
		);
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"changed since it was last reviewed",
		);
		expect(loadDetail).toHaveBeenCalledTimes(2);
		expect(finish).toHaveBeenCalledWith("opaque-candidate", {
			attemptId: "opaque-attempt",
			finishDigest: "opaque-finish-digest",
			confirmedAccessDeltaDigest: "opaque-access-digest",
			confirmedViewerAccessDeltaDigest: "opaque-viewer-access-digest",
		});
		expect(
			document.querySelector<HTMLInputElement>(".legacy-team-setup-confirmation input")?.checked,
		).toBe(false);
		expect(document.body.textContent).toContain("Add Sam to Example Team.");
		expect(button("Finish Team setup").getAttribute("aria-disabled")).toBe("true");
	});

	it("treats a stale finish recovery that is already completed as success", async () => {
		const onCompleted = vi.fn().mockRejectedValue(new Error("private refresh failure"));
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(detail({ canFinish: true }))
			.mockResolvedValueOnce(detail({ draftState: "completed" }));
		setup({
			finish: vi
				.fn()
				.mockRejectedValue(new LegacyTeamSetupApiError(409, "team_setup_confirmation_stale")),
			loadDetail,
			onCompleted,
		});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Finish Team setup"));
		const confirmation = document.querySelector<HTMLInputElement>(
			".legacy-team-setup-confirmation input",
		);
		if (!confirmation) throw new Error("finish confirmation missing");
		confirmation.checked = true;
		act(() => {
			confirmation.dispatchEvent(new Event("change", { bubbles: true }));
		});
		act(() => button("Finish Team setup").click());

		await vi.waitFor(() => {
			expect(document.body.textContent).toContain("Team setup complete");
			expect(document.body.textContent).toContain(
				"Sharing or Projects could not be refreshed; use that view's Refresh control.",
			);
		});
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(onCompleted).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).not.toContain("private refresh failure");
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
