import { describe, expect, it } from "vitest";
import {
	projectShareLifecycle,
	SHARE_OPERATION_STALE_AFTER_MS,
	type ShareOperationLifecycleStepInput,
} from "./share-operation-lifecycle.js";

const now = "2026-07-20T12:20:00.000Z";

function step(
	overrides: Partial<ShareOperationLifecycleStepInput> = {},
): ShareOperationLifecycleStepInput {
	return {
		attemptCount: 0,
		lastAttemptAt: null,
		safeErrorCode: null,
		startedAt: null,
		status: "pending",
		stepKey: "authorization_refresh",
		updatedAt: now,
		...overrides,
	};
}

function project(
	state: string,
	steps: ShareOperationLifecycleStepInput[] = [],
	inviteLink?: string,
) {
	return projectShareLifecycle({
		deviceLastSeenAt: null,
		deviceName: "Brian's MacBook",
		inviteLink,
		now,
		personName: "Brian",
		state,
		steps,
	});
}

describe("projectShareLifecycle", () => {
	it.each([
		["accepted", "provisioning", "Setting up project access"],
		["provisioning", "provisioning", "Setting up project access"],
		["initial_sync", "initial_sync", "Starting first sync"],
		["active", "active", "Up to date"],
		["revoking", "revoking", "Removing future access"],
	])("projects %s as %s", (state, lifecycle, label) => {
		expect(project(state)).toMatchObject({ lifecycle, label, primaryAction: null });
	});

	it.each([
		["revoked", "revoked", "Access removed", { kind: "share_again", label: "Share again" }],
		[
			"cancelled",
			"cancelled",
			"Invitation cancelled",
			{ kind: "create_new_invite", label: "Create new invite" },
		],
	] as const)("projects %s with its required recovery action", (state, lifecycle, label, action) => {
		expect(project(state)).toMatchObject({ lifecycle, label, primaryAction: action });
	});

	it("offers Copy invite only when the safe link is available", () => {
		expect(project("waiting_for_acceptance", [], "codemem://invite/encoded").primaryAction).toEqual(
			{
				inviteLink: "codemem://invite/encoded",
				kind: "copy_invite",
				label: "Copy invite",
			},
		);
		expect(project("waiting_for_acceptance").primaryAction).toBeNull();
	});

	it.each([
		step({ status: "failed", safeErrorCode: "authorization_refresh_failed" }),
		step({ status: "running", attemptCount: 3 }),
		step({
			status: "running",
			attemptCount: 1,
			lastAttemptAt: new Date(
				new Date(now).getTime() - SHARE_OPERATION_STALE_AFTER_MS - 1,
			).toISOString(),
		}),
	])("moves failed, exhausted, and stale non-device work to needs attention", (item) => {
		const result = project("provisioning", [item]);
		expect(result.lifecycle).toBe("needs_attention");
		expect(result.primaryAction).toEqual({ kind: "retry_setup", label: "Retry setup" });
	});

	it("does not age never-attempted setup from invite creation", () => {
		const result = project("accepted", [
			step({
				status: "pending",
				attemptCount: 0,
				startedAt: null,
				lastAttemptAt: null,
				updatedAt: new Date(
					new Date(now).getTime() - SHARE_OPERATION_STALE_AFTER_MS - 60_000,
				).toISOString(),
			}),
		]);

		expect(result).toMatchObject({ lifecycle: "provisioning", primaryAction: null });
	});

	it("keeps an offline recipient passive regardless of age and attempts", () => {
		const result = project("waiting_for_device", [
			step({
				attemptCount: 9,
				lastAttemptAt: "2026-07-01T00:00:00.000Z",
				safeErrorCode: "waiting_for_device",
				status: "failed",
				stepKey: "initial_sync",
			}),
		]);
		expect(result).toMatchObject({ lifecycle: "waiting_for_device", primaryAction: null });
	});

	it("does not describe a successfully reconnected recipient as offline while setup resumes", () => {
		const result = projectShareLifecycle({
			deviceLastSeenAt: "2026-07-20T12:19:30.000Z",
			deviceLastReachedAt: "2026-07-20T12:19:00.000Z",
			deviceName: "Brian's MacBook",
			now,
			personName: "Brian",
			state: "waiting_for_device",
			steps: [
				step({
					lastAttemptAt: "2026-07-20T12:18:00.000Z",
					safeErrorCode: "waiting_for_device",
					status: "failed",
					stepKey: "initial_sync",
					updatedAt: "2026-07-20T12:18:00.000Z",
				}),
			],
		});

		expect(result).toMatchObject({
			lifecycle: "waiting_for_device",
			label: "Finishing project setup",
			explanation:
				"A recent sync reached Brian's MacBook. Project setup will continue automatically.",
			primaryAction: null,
		});
		expect(result.explanation).not.toContain("Waiting to reach");
	});

	it.each([
		["before the wait", "2026-07-20T12:17:00.000Z"],
		["at the wait boundary", "2026-07-20T12:18:00.000Z"],
		["outside the reachability window", "2026-07-20T12:14:00.000Z"],
		["with an invalid timestamp", "not-a-time"],
	])("keeps offline copy when the device was last reached %s", (_label, deviceLastReachedAt) => {
		const result = projectShareLifecycle({
			deviceLastSeenAt: "2026-07-20T12:19:30.000Z",
			deviceLastReachedAt,
			deviceName: "Brian's MacBook",
			now,
			personName: "Brian",
			state: "waiting_for_device",
			steps: [
				step({
					safeErrorCode: "waiting_for_device",
					status: "failed",
					stepKey: "initial_sync",
					updatedAt: "2026-07-20T12:18:00.000Z",
				}),
			],
		});

		expect(result.label).toBe("Waiting for device");
		expect(result.explanation).toContain("Waiting to reach");
	});

	it("does not infer recent reachability from display-only last-seen metadata", () => {
		const result = projectShareLifecycle({
			deviceLastSeenAt: "2026-07-20T12:19:00.000Z",
			deviceLastReachedAt: null,
			deviceName: "Brian's MacBook",
			now,
			personName: "Brian",
			state: "waiting_for_device",
			steps: [
				step({
					safeErrorCode: "waiting_for_device",
					status: "failed",
					stepKey: "initial_sync",
					updatedAt: "2026-07-20T12:18:00.000Z",
				}),
			],
		});

		expect(result.label).toBe("Waiting for device");
		expect(result.explanation).toContain("Waiting to reach");
	});

	it("distinguishes capability evidence waits from an offline recipient", () => {
		const result = project("waiting_for_device", [
			step({
				safeErrorCode: "waiting_for_device",
				status: "failed",
				stepKey: "capability_preflight",
			}),
		]);

		expect(result).toMatchObject({
			lifecycle: "waiting_for_device",
			label: "Checking device compatibility",
			explanation: "Waiting for a participating device to report the required sharing capability.",
			primaryAction: null,
		});
		expect(result.explanation).not.toContain("reach");
	});

	it("keeps a running capability retry classified as a compatibility wait", () => {
		const result = project("waiting_for_device", [
			step({
				safeErrorCode: null,
				status: "running",
				stepKey: "capability_preflight",
			}),
		]);

		expect(result).toMatchObject({
			lifecycle: "waiting_for_device",
			label: "Checking device compatibility",
			explanation: "Waiting for a participating device to report the required sharing capability.",
			primaryAction: null,
		});
		expect(result.explanation).not.toContain("reach");
	});

	it("maps safe failure codes without leaking technical traces", () => {
		const result = project("needs_attention", [
			step({ status: "failed", safeErrorCode: "reassign_capability_required" }),
		]);
		expect(result.explanation).toContain("device must be updated");
		expect(result.explanation).not.toContain("reassign_capability_required");
	});

	it("keeps a terminal reviewed-intent failure actionable without exposing its code", () => {
		const result = project("needs_attention", [
			step({ status: "failed", safeErrorCode: "operation_intent_mismatch" }),
		]);
		expect(result).toMatchObject({
			lifecycle: "needs_attention",
			explanation: "The accepted Project list no longer matches the reviewed invitation.",
			primaryAction: { kind: "retry_setup", label: "Retry setup" },
		});
		expect(result.explanation).not.toContain("operation_intent_mismatch");
	});

	it("warns that revocation cannot recall copied memories", () => {
		expect(project("revoked").explanation).toBe("Previously copied memories may remain.");
	});
});
