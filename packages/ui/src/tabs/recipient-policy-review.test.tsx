import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
	RecipientPolicyReviewStaleError: class RecipientPolicyReviewStaleError extends Error {},
	resolveRecipientPolicyReview: vi.fn(),
	resolveRecipientPolicyReviewBulk: vi.fn(),
}));

import * as api from "../lib/api";
import type {
	RecipientPolicyBlockedItemV1,
	RecipientPolicyReviewItemV1,
	RecipientPolicyReviewListV1,
} from "../lib/api/sync";
import { renderRecipientPolicyReview } from "./recipient-policy-review";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function reviewItem(
	overrides: Partial<RecipientPolicyReviewItemV1> = {},
): RecipientPolicyReviewItemV1 {
	const preview = {
		affectedDeviceCount: 1,
		affectedMemoryCount: 3,
		affectedProjectCount: 1,
		effect: "none" as const,
		effectiveDevices: [
			{
				assignment: "assigned" as const,
				deviceId: "device-fixture",
				displayName: "Fixture device",
				identityId: "identity-fixture",
			},
		],
		projects: [{ canonicalIdentity: "project-fixture", displayName: "Fixture project" }],
		requiresDecisionInput: false,
	};
	return {
		conditionCode: "suggest_local_identity",
		finding: "Older sharing needs a decision.",
		options: [
			{
				affectedDeviceCount: 1,
				affectedMemoryCount: 3,
				affectedProjectCount: 1,
				decision: "keep_current_setup",
				effect: "none",
				label: "Keep current setup unchanged",
				preview,
			},
		],
		projectGroup: { displayName: "Fixture project", identity: "project-fixture" },
		reason: "Review the existing sharing evidence.",
		recommendedDecision: "keep_current_setup",
		resolution: null,
		reviewItemId: "review-fixture",
		sourceFingerprint: "fingerprint-fixture",
		state: "open",
		version: 1,
		...overrides,
	};
}

function itemWithChoices(
	id: string,
	displayName: string,
	requiresDecisionInput = false,
): RecipientPolicyReviewItemV1 {
	const item = reviewItem({
		projectGroup: { displayName, identity: `project-${id}` },
		reviewItemId: `review-${id}`,
		sourceFingerprint: `fingerprint-${id}`,
	});
	item.options = [
		...item.options,
		{
			...item.options[0],
			decision: "reject_suggestion",
			label: "Reject suggestion",
			preview: { ...item.options[0].preview, requiresDecisionInput },
		},
	];
	return item;
}

function review(overrides: Partial<RecipientPolicyReviewListV1> = {}): RecipientPolicyReviewListV1 {
	return {
		blockedItems: [],
		categoryCounts: { actionableReview: 1, blockedRepair: 0, preservedContinuity: 0 },
		continuity: null,
		reviewItems: [reviewItem()],
		version: 1,
		...overrides,
	};
}

function blockedItem(): RecipientPolicyBlockedItemV1 {
	return {
		blockedItemId: "blocked-fixture",
		finding: "Project identity needs repair.",
		ownerLabel: "Project owner",
		reason: "The source identity is unstable.",
		repair: {
			kind: "reassign_project",
			label: "Repair project identity",
			projectIdentity: "project-fixture",
		},
		repairAction: "Choose a stable project identity.",
		version: 1,
	};
}

describe("recipient policy review pending guards", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="mount"></div>';
		vi.mocked(api.resolveRecipientPolicyReview).mockResolvedValue({
			errorCode: null,
			idempotent: false,
			reviewItemId: "review-fixture",
			sourceFingerprint: "fingerprint-fixture",
			status: "applied",
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		document.body.innerHTML = "";
	});

	it("keeps decision controls pending until a slow refresh settles", async () => {
		const refresh = deferred();
		const onRefresh = vi.fn(() => refresh.promise);
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("review mount missing");
		renderRecipientPolicyReview(mount, review(), { onRefresh });
		const apply = mount.querySelector<HTMLButtonElement>('[data-review-control="apply"]');
		const select = mount.querySelector<HTMLSelectElement>(".recipient-policy-review-select");
		expect(select?.classList.contains("project-domain-select")).toBe(false);
		if (!apply || !select) throw new Error("review controls missing");

		await act(async () => {
			act(() => {
				apply.click();
				apply.click();
			});
			await Promise.resolve();
		});

		expect(api.resolveRecipientPolicyReview).toHaveBeenCalledTimes(1);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(apply.disabled).toBe(true);
		expect(select.disabled).toBe(true);
		apply.click();
		expect(api.resolveRecipientPolicyReview).toHaveBeenCalledTimes(1);
		act(() => renderRecipientPolicyReview(mount, review(), { onRefresh }));
		const remountedApply = mount.querySelector<HTMLButtonElement>('[data-review-control="apply"]');
		const remountedSelect = mount.querySelector<HTMLSelectElement>(
			".recipient-policy-review-select",
		);
		expect(remountedApply?.disabled).toBe(true);
		expect(remountedSelect?.disabled).toBe(true);

		await act(async () => {
			refresh.resolve();
			await refresh.promise;
		});

		expect(remountedApply?.disabled).toBe(false);
		expect(remountedSelect?.disabled).toBe(false);
	});

	it("runs a blocked repair once for same-turn clicks", async () => {
		const repair = deferred();
		const onRepair = vi.fn(() => repair.promise);
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("review mount missing");
		renderRecipientPolicyReview(
			mount,
			review({
				blockedItems: [blockedItem()],
				categoryCounts: { actionableReview: 0, blockedRepair: 1, preservedContinuity: 0 },
				reviewItems: [],
			}),
			{ onRepair },
		);
		const button = mount.querySelector<HTMLButtonElement>("button[aria-describedby]");
		if (!button) throw new Error("repair control missing");

		await act(async () => {
			act(() => {
				button.click();
				button.click();
			});
			await Promise.resolve();
		});

		expect(onRepair).toHaveBeenCalledTimes(1);
		act(() =>
			renderRecipientPolicyReview(
				mount,
				review({
					blockedItems: [blockedItem()],
					categoryCounts: { actionableReview: 0, blockedRepair: 1, preservedContinuity: 0 },
					reviewItems: [],
				}),
				{ onRepair },
			),
		);
		const remountedButton = mount.querySelector<HTMLButtonElement>("button[aria-describedby]");
		expect(remountedButton?.disabled).toBe(true);

		await act(async () => {
			repair.resolve();
			await repair.promise;
		});

		expect(remountedButton?.disabled).toBe(false);
	});
});

describe("recipient policy review bulk actions", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="mount"></div>';
		vi.mocked(api.resolveRecipientPolicyReviewBulk).mockImplementation(async (requests) => ({
			results: requests.map((request) => ({
				errorCode: null,
				idempotent: false,
				reviewItemId: request.reviewItemId,
				sourceFingerprint: request.sourceFingerprint,
				status: "applied" as const,
			})),
			version: 1,
		}));
	});

	afterEach(() => {
		vi.clearAllMocks();
		document.body.innerHTML = "";
	});

	it("applies each selected row's current decision in one request", async () => {
		const first = itemWithChoices("first", "First project");
		const second = itemWithChoices("second", "Second project");
		const onRefresh = vi.fn();
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("review mount missing");
		renderRecipientPolicyReview(mount, review({ reviewItems: [first, second] }), {
			onRefresh,
		});
		const selects = mount.querySelectorAll<HTMLSelectElement>(".recipient-policy-review-select");
		act(() => {
			selects[1].value = "reject_suggestion";
			selects[1].dispatchEvent(new Event("change", { bubbles: true }));
			mount.querySelector<HTMLInputElement>('input[aria-label^="Select First project:"]')?.click();
			mount.querySelector<HTMLInputElement>('input[aria-label^="Select Second project:"]')?.click();
		});

		await act(async () => {
			const apply = [...mount.querySelectorAll("button")].find((button) =>
				button.textContent?.startsWith("Apply selected"),
			);
			apply?.click();
			await Promise.resolve();
		});

		expect(api.resolveRecipientPolicyReviewBulk).toHaveBeenCalledWith([
			{
				decision: "keep_current_setup",
				reviewItemId: "review-first",
				sourceFingerprint: "fingerprint-first",
			},
			{
				decision: "reject_suggestion",
				reviewItemId: "review-second",
				sourceFingerprint: "fingerprint-second",
			},
		]);
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it("applies all actionable rows and skips choices requiring input", async () => {
		const actionable = itemWithChoices("ready", "Ready project");
		const blocked = itemWithChoices("blocked", "Blocked project", true);
		blocked.recommendedDecision = "reject_suggestion";
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("review mount missing");
		renderRecipientPolicyReview(mount, review({ reviewItems: [actionable, blocked] }));

		await act(async () => {
			const applyAll = [...mount.querySelectorAll("button")].find(
				(button) => button.textContent === "Apply all (1)",
			);
			applyAll?.click();
			await Promise.resolve();
		});

		expect(api.resolveRecipientPolicyReviewBulk).toHaveBeenCalledWith([
			{
				decision: "keep_current_setup",
				reviewItemId: "review-ready",
				sourceFingerprint: "fingerprint-ready",
			},
		]);
		expect(
			mount.querySelector<HTMLInputElement>('input[aria-label^="Select Blocked project:"]')
				?.disabled,
		).toBe(true);
	});

	it("does not bulk-submit a row already applying individually", async () => {
		const pending = deferred();
		vi.mocked(api.resolveRecipientPolicyReview).mockReturnValueOnce(
			pending.promise.then(() => ({
				errorCode: null,
				idempotent: false,
				reviewItemId: "review-ready",
				sourceFingerprint: "fingerprint-ready",
				status: "applied" as const,
			})),
		);
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("review mount missing");
		renderRecipientPolicyReview(
			mount,
			review({ reviewItems: [itemWithChoices("ready", "Ready project")] }),
		);

		await act(async () => {
			mount.querySelector<HTMLButtonElement>('[data-review-control="apply"]')?.click();
			await Promise.resolve();
		});
		const applyAll = [...mount.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
			button.textContent?.startsWith("Apply all"),
		);
		expect(applyAll?.disabled).toBe(true);
		applyAll?.click();
		expect(api.resolveRecipientPolicyReview).toHaveBeenCalledTimes(1);
		expect(api.resolveRecipientPolicyReviewBulk).not.toHaveBeenCalled();

		await act(async () => {
			pending.resolve();
			await pending.promise;
		});
	});
});
