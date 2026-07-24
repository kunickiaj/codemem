export const SHARE_OPERATION_STALE_AFTER_MS = 10 * 60 * 1000;
export const SHARE_OPERATION_MAX_ATTEMPTS = 3;

export type ShareOperationLifecycle =
	| "waiting_for_acceptance"
	| "provisioning"
	| "initial_sync"
	| "waiting_for_device"
	| "active"
	| "needs_attention"
	| "revoking"
	| "revoked"
	| "cancelled";

export type ShareOperationPrimaryAction =
	| { kind: "copy_invite"; label: "Copy invite"; inviteLink: string }
	| { kind: "retry_setup"; label: "Retry setup" }
	| { kind: "share_again"; label: "Share again" }
	| { kind: "create_new_invite"; label: "Create new invite" };

export interface ShareOperationLifecycleStepInput {
	stepKey: string;
	status: "pending" | "running" | "completed" | "failed";
	attemptCount: number;
	startedAt: string | null;
	lastAttemptAt: string | null;
	updatedAt: string;
	safeErrorCode: string | null;
}

export interface ShareOperationLifecycleInput {
	state: string;
	personName: string;
	deviceName: string | null;
	deviceLastSeenAt: string | null;
	inviteLink?: string | null;
	steps: ShareOperationLifecycleStepInput[];
	now: string;
}

export interface ShareOperationLifecycleProjection {
	lifecycle: ShareOperationLifecycle;
	label: string;
	explanation: string;
	primaryAction: ShareOperationPrimaryAction | null;
	failureCode: string | null;
}

const DEVICE_WAIT_CODES = new Set(["waiting_for_device", "device_offline", "recipient_offline"]);

const FAILURE_COPY: Record<string, string> = {
	authorization_refresh_failed: "Project access could not be refreshed on this device.",
	initial_sync_scope_incomplete: "The first project sync did not finish.",
	inviter_project_access_ambiguous:
		"Existing project access needs review before setup can continue.",
	managed_boundary_conflict: "The project access boundary does not match the reviewed share.",
	managed_grant_conflict: "Project access could not be granted as reviewed.",
	operation_intent_mismatch: "The accepted Project list no longer matches the reviewed invitation.",
	operation_scope_mismatch: "The accepted invitation no longer matches this owner's sharing setup.",
	operation_read_failed: "Invitation status could not be refreshed from the coordinator.",
	project_mapping_conflict: "The project is already assigned to different access settings.",
	reassign_capability_required:
		"A participating device must be updated before project history can be shared.",
	recipient_device_identity_conflict:
		"The accepted device identity no longer matches this invitation.",
	provisioning_failed: "Project access setup did not finish.",
};

function validTime(value: string | null): number | null {
	if (!value) return null;
	const time = new Date(value).getTime();
	return Number.isNaN(time) ? null : time;
}

function isDeviceWait(step: ShareOperationLifecycleStepInput): boolean {
	return step.stepKey === "initial_sync" && DEVICE_WAIT_CODES.has(step.safeErrorCode ?? "");
}

function stepAgeMs(step: ShareOperationLifecycleStepInput, nowMs: number): number {
	const since = validTime(step.lastAttemptAt) ?? validTime(step.startedAt);
	return since == null ? 0 : Math.max(0, nowMs - since);
}

function failureExplanation(code: string | null): string {
	return FAILURE_COPY[code ?? ""] ?? "Project access setup did not finish safely.";
}

function passive(
	lifecycle: ShareOperationLifecycle,
	label: string,
	explanation: string,
): ShareOperationLifecycleProjection {
	return { lifecycle, label, explanation, primaryAction: null, failureCode: null };
}

export function projectShareLifecycle(
	input: ShareOperationLifecycleInput,
): ShareOperationLifecycleProjection {
	const personName = input.personName.trim() || "your teammate";
	const deviceName = input.deviceName?.trim() || `${personName}'s device`;
	if (input.state === "revoking") {
		return passive("revoking", "Removing future access", "Previously copied memories may remain.");
	}
	if (input.state === "revoked") {
		return {
			lifecycle: "revoked",
			label: "Access removed",
			explanation: "Previously copied memories may remain.",
			primaryAction: { kind: "share_again", label: "Share again" },
			failureCode: null,
		};
	}
	if (input.state === "cancelled") {
		return {
			lifecycle: "cancelled",
			label: "Invitation cancelled",
			explanation: "No project access was added.",
			primaryAction: { kind: "create_new_invite", label: "Create new invite" },
			failureCode: null,
		};
	}
	if (input.state === "waiting_for_acceptance") {
		const inviteLink = input.inviteLink?.trim();
		return {
			lifecycle: "waiting_for_acceptance",
			label: "Waiting for acceptance",
			explanation: `Waiting for ${personName} to accept the invitation.`,
			primaryAction: inviteLink ? { kind: "copy_invite", label: "Copy invite", inviteLink } : null,
			failureCode: null,
		};
	}

	const incomplete = input.steps.filter((step) => step.status !== "completed");
	const deviceWait = incomplete.find(isDeviceWait);
	if (input.state === "waiting_for_device" || deviceWait) {
		const lastSeen = input.deviceLastSeenAt?.trim();
		return passive(
			"waiting_for_device",
			"Waiting for device",
			lastSeen
				? `${deviceName} is offline. Sync will continue when it reconnects; last seen ${lastSeen}.`
				: `${deviceName} is offline. Sync will continue when it reconnects.`,
		);
	}

	const nowMs = validTime(input.now) ?? 0;
	const failed = incomplete.find((step) => step.status === "failed" && !isDeviceWait(step));
	const exhausted = incomplete.find(
		(step) =>
			!isDeviceWait(step) &&
			(step.attemptCount >= SHARE_OPERATION_MAX_ATTEMPTS ||
				(["pending", "running"].includes(step.status) &&
					stepAgeMs(step, nowMs) > SHARE_OPERATION_STALE_AFTER_MS)),
	);
	if (input.state === "needs_attention" || failed || exhausted) {
		const code = failed?.safeErrorCode ?? exhausted?.safeErrorCode ?? null;
		return {
			lifecycle: "needs_attention",
			label: "Setup needs attention",
			explanation: failureExplanation(code),
			primaryAction: { kind: "retry_setup", label: "Retry setup" },
			failureCode: code,
		};
	}
	if (input.state === "initial_sync") {
		return passive(
			"initial_sync",
			"Starting first sync",
			`Sending the reviewed projects to ${deviceName}.`,
		);
	}
	if (input.state === "active") {
		return passive("active", "Up to date", "Existing memories and future activity are shared.");
	}
	return passive(
		"provisioning",
		"Setting up project access",
		`Preparing the reviewed projects for ${personName}.`,
	);
}
