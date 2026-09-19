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

function reviewItem(): RecipientPolicyReviewItemV1 {
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
	};
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
		if (!apply || !select) throw new Error("review controls missing");

		await act(async () => {
			apply.click();
			apply.click();
			await Promise.resolve();
		});

		expect(api.resolveRecipientPolicyReview).toHaveBeenCalledTimes(1);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(apply.disabled).toBe(true);
		expect(select.disabled).toBe(true);
		apply.click();
		expect(api.resolveRecipientPolicyReview).toHaveBeenCalledTimes(1);

		await act(async () => {
			refresh.resolve();
			await refresh.promise;
		});

		expect(apply.disabled).toBe(false);
		expect(select.disabled).toBe(false);
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
			button.click();
			button.click();
			await Promise.resolve();
		});

		expect(onRepair).toHaveBeenCalledTimes(1);
		expect(button.disabled).toBe(true);

		await act(async () => {
			repair.resolve();
			await repair.promise;
		});

		expect(button.disabled).toBe(false);
	});
});
