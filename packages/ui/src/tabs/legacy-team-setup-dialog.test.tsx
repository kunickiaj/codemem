import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LegacyTeamSetupApiError,
	type LegacyTeamSetupDetailResponseV1,
	type LegacyTeamSetupDeviceV1,
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
	return {
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
	};
}

function project(overrides: Partial<LegacyTeamSetupProjectV1> = {}): LegacyTeamSetupProjectV1 {
	return {
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
	};
}

function detail({
	canFinish = false,
	conflictState = null,
	draftState = "in_progress",
	attemptId = "opaque-attempt",
	devices,
	identityChoices = [],
	projects,
	unresolvedDeviceCount = 0,
	unresolvedProjectCount = 0,
}: {
	canFinish?: boolean;
	conflictState?: LegacyTeamSetupDetailResponseV1["conflictState"];
	draftState?: "needs_setup" | "in_progress" | "stale" | "completed";
	attemptId?: string;
	devices?: LegacyTeamSetupDeviceV1[];
	identityChoices?: LegacyTeamSetupIdentityChoiceV1[];
	projects?: LegacyTeamSetupProjectV1[];
	unresolvedDeviceCount?: number;
	unresolvedProjectCount?: number;
} = {}): LegacyTeamSetupDetailResponseV1 {
	const base = {
		version: 1 as const,
		candidate: {
			candidateRef: "opaque-candidate",
			displayName: "Example Team",
			status: "in_progress" as const,
			deviceCount: devices?.length ?? 3,
			projectCount: projects?.length ?? 2,
			unresolvedDeviceCount,
			unresolvedProjectCount,
		},
		attemptId,
		draftState,
		unresolvedDeviceCount,
		unresolvedProjectCount,
		devices: devices ?? [],
		projects: projects ?? [],
		identityChoices,
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

function mutationResult() {
	return {
		version: 1 as const,
		candidateRef: "opaque-candidate",
		attemptId: "opaque-attempt",
		draftState: "in_progress" as const,
		canFinish: false,
		unresolvedDeviceCount: 1,
		unresolvedProjectCount: 0,
	};
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
		setup({ loadDetail, refreshCandidate });

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

	it("persists an identity assignment with exact expectation evidence and reloads detail", async () => {
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
			.mockResolvedValueOnce(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			)
			.mockResolvedValueOnce(
				detail({
					devices: [refreshedDevice],
					identityChoices: identities,
					unresolvedDeviceCount: 1,
				}),
			);
		const saveAssignment = vi.fn().mockResolvedValue(mutationResult());
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
			expect(loadDetail).toHaveBeenCalledTimes(2);
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
			.mockResolvedValueOnce(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			)
			.mockResolvedValueOnce(
				detail({
					devices: [{ ...initialDevice, targetIdentityRef: "identity-ref-alex" }],
					identityChoices: identities,
					unresolvedDeviceCount: 1,
				}),
			);
		const saveAssignment = vi.fn().mockResolvedValue(mutationResult());
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
			expect(loadDetail).toHaveBeenCalledTimes(2);
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
		const pendingDecision = deferred<ReturnType<typeof mutationResult>>();
		const initialDevice = device();
		const excludedDevice = device({ decision: "excluded", suggestedIdentityRef: null });
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			)
			.mockResolvedValueOnce(
				detail({
					devices: [excludedDevice],
					identityChoices: identities,
					unresolvedProjectCount: 1,
				}),
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

		pendingDecision.resolve(mutationResult());
		await vi.waitFor(() => {
			expect(document.body.textContent).toContain("Review Projects");
		});
		expect(document.activeElement?.id).toBe("legacy-team-setup-step-projects");
		expect(loadDetail).toHaveBeenCalledTimes(2);
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
			.mockResolvedValueOnce(assignedDetail)
			.mockResolvedValueOnce(assignedDetail)
			.mockResolvedValueOnce(
				detail({
					devices: [includedDevice],
					identityChoices: identities,
					unresolvedProjectCount: 1,
				}),
			);
		const saveAssignment = vi.fn().mockResolvedValue(mutationResult());
		const saveDecision = vi
			.fn()
			.mockRejectedValueOnce(new Error("private decision failure"))
			.mockResolvedValueOnce(mutationResult());
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
			expect(loadDetail).toHaveBeenCalledTimes(2);
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
		expect(loadDetail).toHaveBeenCalledTimes(4);
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
			.mockResolvedValueOnce(detail({ devices: [initialDevice], unresolvedDeviceCount: 1 }))
			.mockResolvedValueOnce(detail({ devices: [removedDevice], unresolvedProjectCount: 1 }));
		const saveDecision = vi.fn().mockResolvedValue(mutationResult());
		const saveAssignment = vi.fn();
		setup({ loadDetail, saveAssignment, saveDecision });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Device no longer active"));
		expect(document.querySelector<HTMLSelectElement>(".legacy-team-device-select")?.disabled).toBe(
			true,
		);
		expect(button("Save assignment").getAttribute("aria-disabled")).toBe("true");
		act(() => button("Save assignment").click());
		expect(saveAssignment).not.toHaveBeenCalled();

		act(() => button("Remove").click());
		await vi.waitFor(() => expect(document.body.textContent).toContain("Review Projects"));
		expect(saveDecision).toHaveBeenCalledWith("opaque-candidate", "device-ref-one", {
			attemptId: "opaque-attempt",
			decision: "removed",
		});
		expect(loadDetail).toHaveBeenCalledTimes(2);
	});

	it("reports a saved device change separately when its authoritative reload fails", async () => {
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(
				detail({ devices: [device()], identityChoices: identities, unresolvedDeviceCount: 1 }),
			)
			.mockRejectedValueOnce(new Error("private reload failure"));
		const saveDecision = vi.fn().mockResolvedValue(mutationResult());
		setup({ loadDetail, saveDecision });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Work laptop"));

		act(() => button("Exclude").click());

		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"was saved, but the latest Team setup details could not be loaded",
			);
		});
		expect(document.body.textContent).not.toContain("private reload failure");
		expect(document.body.textContent).not.toContain("device change could not be saved");
		expect(saveDecision).toHaveBeenCalledTimes(1);
		expect(loadDetail).toHaveBeenCalledTimes(2);
	});

	it("clears a persisted decision with the current attempt and reloads detail", async () => {
		const excludedDevice = device({ decision: "excluded", suggestedIdentityRef: null });
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(detail({ devices: [excludedDevice], unresolvedDeviceCount: 0 }))
			.mockResolvedValueOnce(
				detail({ devices: [device()], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		const clearDecision = vi.fn().mockResolvedValue(mutationResult());
		setup({ clearDecision, loadDetail });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Review and finish"));
		act(() => button("Devices").click());
		expect(document.body.textContent).toContain("Clear decision");

		act(() => button("Clear decision").click());
		await vi.waitFor(() => expect(document.body.textContent).toContain("Needs a decision"));
		expect(clearDecision).toHaveBeenCalledWith("opaque-candidate", "device-ref-one", {
			attemptId: "opaque-attempt",
		});
		expect(loadDetail).toHaveBeenCalledTimes(2);
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
			)
			.mockResolvedValueOnce(
				detail({
					attemptId: "refreshed-attempt",
					devices: [refreshedDevice],
					identityChoices: identities,
					unresolvedDeviceCount: 1,
				}),
			);
		const refreshCandidate = vi.fn().mockResolvedValue({});
		const saveDecision = vi
			.fn()
			.mockRejectedValue(new LegacyTeamSetupApiError(409, "team_setup_assignment_changed"));
		setup({ loadDetail, refreshCandidate, saveDecision });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Work laptop"));

		act(() => button("Exclude").click());
		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"changed since it was last reviewed",
			);
			expect(document.body.textContent).toContain("Current assignment: Sam");
		});
		expect(loadDetail).toHaveBeenCalledTimes(2);
		const exclude = button("Exclude");
		expect(exclude.disabled).toBe(false);
		expect(exclude.getAttribute("aria-disabled")).toBe("true");
		exclude.focus();
		expect(document.activeElement).toBe(exclude);

		act(() => document.getElementById("legacy-team-setup-retry")?.click());
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
		expect(refreshCandidate).toHaveBeenCalledWith("opaque-candidate");
		expect(refreshCandidate.mock.invocationCallOrder[0]).toBeLessThan(
			loadDetail.mock.invocationCallOrder[2],
		);
		expect(loadDetail).toHaveBeenCalledTimes(3);
	});

	it("refreshes the candidate before retrying a stale post-mutation detail", async () => {
		const initialDevice = device();
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			)
			.mockResolvedValueOnce(
				detail({
					draftState: "stale",
					devices: [initialDevice],
					identityChoices: identities,
					unresolvedDeviceCount: 1,
				}),
			)
			.mockResolvedValueOnce(
				detail({ devices: [initialDevice], identityChoices: identities, unresolvedDeviceCount: 1 }),
			);
		const refreshCandidate = vi.fn().mockResolvedValue({});
		setup({ loadDetail, refreshCandidate, saveDecision: vi.fn().mockResolvedValue({}) });
		await vi.waitFor(() => expect(document.body.textContent).toContain("Work laptop"));

		act(() => button("Exclude").click());
		await vi.waitFor(() =>
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"changed since it was last reviewed",
			),
		);
		act(() => document.getElementById("legacy-team-setup-retry")?.click());

		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
		expect(refreshCandidate).toHaveBeenCalledWith("opaque-candidate");
		expect(refreshCandidate.mock.invocationCallOrder[0]).toBeLessThan(
			loadDetail.mock.invocationCallOrder[2],
		);
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

	it("persists one explicit Project mapping and advances after authoritative reload", async () => {
		const initialProject = project();
		const mappedProject = project({
			resolution: "explicit",
			resolvedProjectRef: "resolved-project-beta",
		});
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(detail({ projects: [initialProject], unresolvedProjectCount: 1 }))
			.mockResolvedValueOnce(detail({ projects: [mappedProject] }));
		const saveProjectMapping = vi.fn().mockResolvedValue(mutationResult());
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
		select.value = "resolved-project-beta";
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
		expect(loadDetail).toHaveBeenCalledTimes(2);
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
		const refreshCandidate = vi.fn().mockResolvedValue({});
		setup({ loadDetail, refreshCandidate, saveProjectMapping });

		const select = await vi.waitFor(() => {
			const match = document.querySelector<HTMLSelectElement>(".legacy-team-project-select");
			if (!match) throw new Error("Project mapping select missing");
			return match;
		});
		select.value = "resolved-project-alpha";
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
		expect(button("Save mapping").getAttribute("aria-disabled")).toBe("true");

		act(() => document.getElementById("legacy-team-setup-retry")?.click());
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
		expect(document.querySelector<HTMLSelectElement>(".legacy-team-project-select")?.value).toBe(
			"",
		);
		expect(button("Save mapping").getAttribute("aria-disabled")).toBe("true");
		expect(loadDetail).toHaveBeenCalledTimes(3);
		expect(refreshCandidate).toHaveBeenCalledWith("opaque-candidate");
	});

	it("reports a saved mapping separately when its authoritative reload fails", async () => {
		const loadDetail = vi
			.fn()
			.mockResolvedValueOnce(detail({ projects: [project()], unresolvedProjectCount: 1 }))
			.mockRejectedValueOnce(new Error("private reload failure"));
		const saveProjectMapping = vi.fn().mockResolvedValue(mutationResult());
		setup({ loadDetail, saveProjectMapping });

		const select = await vi.waitFor(() => {
			const match = document.querySelector<HTMLSelectElement>(".legacy-team-project-select");
			if (!match) throw new Error("Project mapping select missing");
			return match;
		});
		select.value = "resolved-project-alpha";
		act(() => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		act(() => button("Save mapping").click());

		await vi.waitFor(() => {
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				"was saved, but the latest Team setup details could not be loaded",
			);
		});
		expect(document.body.textContent).not.toContain("private reload failure");
		expect(document.body.textContent).not.toContain("mapping could not be saved");
		expect(saveProjectMapping).toHaveBeenCalledTimes(1);
		expect(loadDetail).toHaveBeenCalledTimes(2);
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
