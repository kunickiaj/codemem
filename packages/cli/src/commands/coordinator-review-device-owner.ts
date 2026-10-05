import * as p from "@clack/prompts";
import {
	type CoordinatorAuthControllerReviewActionOptions,
	type CoordinatorControllerReviewPreview,
	type CoordinatorOwnerReviewLocalEvidence,
	type CoordinatorOwnerReviewLocalOptions,
	coordinatorAuthControllerReviewAction,
	normalizeCoordinatorAccountLinkOrigin,
	RemoteCoordinatorRequestError,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorOwnerReviewLocalEvidence,
	readCoordinatorSyncConfig,
	resolveDbPath,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	emitJsonError,
	resolveDbOpt,
} from "../shared-options.js";

interface Options {
	db?: string;
	dbPath?: string;
	config?: string;
	json?: boolean;
	coordinator?: string;
}
const REVIEW_REASONS = [
	"group_unavailable",
	"enrollment_unavailable",
	"key_mismatch",
	"enrollment_identity_mismatch",
	"invite_identity_mismatch",
	"invite_evidence_invalid",
];
function validId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}
function isHash(value: unknown): value is string {
	return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
function reviewErrorMessage(error: unknown): string {
	if (error instanceof RemoteCoordinatorRequestError) {
		if (error.code === "review_stale")
			return "Evidence changed since the preview. Nothing changed; run the review again.";
		if (error.code === "already_reviewed_or_needs_review")
			return "This device already has a reviewed owner, or needs a separate review. Nothing changed.";
		if (error.code === "needs_review")
			return "Coordinator ownership evidence needs review. Nothing changed; ask the coordinator operator.";
	}
	return "Device owner review could not finish. Check the existing device, admin credential, and coordinator setup; preview again before retrying.";
}
function failure(options: Options, message: string, exitCode = 1): void {
	if (options.json) {
		emitJsonError("owner_review_unavailable", message, exitCode);
		return;
	}
	p.log.error(message, { output: process.stderr });
	process.exitCode = exitCode;
}
function localOptions(options: Options): {
	local: CoordinatorOwnerReviewLocalOptions;
	remoteUrl: string | null;
	adminSecret: string;
} {
	const config = options.config
		? readCodememConfigFileAtPath(options.config)
		: readCodememConfigFile();
	const sync = readCoordinatorSyncConfig(config);
	let actorId: string | undefined;
	let identitySource: "env" | "config" = "config";
	if (Object.hasOwn(process.env, "CODEMEM_ACTOR_ID")) {
		actorId = process.env.CODEMEM_ACTOR_ID?.trim();
		identitySource = "env";
	} else if (typeof config.actor_id === "string") actorId = config.actor_id.trim();
	return {
		local: {
			dbPath: resolveDbPath(resolveDbOpt(options)),
			actorId,
			identitySource,
			deviceIdOverride: process.env.CODEMEM_DEVICE_ID?.trim(),
		},
		remoteUrl: normalizeCoordinatorAccountLinkOrigin(
			options.coordinator ?? sync.syncCoordinatorUrl,
		),
		adminSecret: sync.syncCoordinatorAdminSecret,
	};
}
function displayLocal(evidence: CoordinatorOwnerReviewLocalEvidence): Omit<
	CoordinatorOwnerReviewLocalEvidence,
	"device"
> & {
	device: Omit<NonNullable<CoordinatorOwnerReviewLocalEvidence["device"]>, "publicKey"> | null;
} {
	const device = evidence.device;
	return {
		...evidence,
		device: device
			? { deviceId: device.deviceId, fingerprint: device.fingerprint, label: device.label }
			: null,
	};
}
function showLocal(evidence: CoordinatorOwnerReviewLocalEvidence): void {
	const count = (value: number | null) => (value === null ? "unknown" : String(value));
	const device = evidence.device;
	const identity = evidence.identity;
	p.log.message(
		[
			`Device: ${device?.label ?? device?.deviceId ?? "unavailable"}`,
			`Device ID: ${device?.deviceId ?? "unknown"}; fingerprint: ${device?.fingerprint ?? "unknown"}`,
			`Identity: ${identity?.label ?? identity?.identityId ?? "unavailable"} (${identity?.source ?? "unknown"})`,
			`Identity ID: ${identity?.identityId ?? "unknown"}`,
			`Memory authors: current ${count(evidence.memoryCounts.current)}, other ${count(evidence.memoryCounts.others)}, unknown ${count(evidence.memoryCounts.unknown)} — unchanged`,
			`Active Teams: ${count(evidence.teamCount)}; direct Projects: ${count(evidence.projectCount)} — unchanged`,
			"This review does not move memories or change access. Google account linking is a separate step.",
		].join("\n"),
		{ output: process.stderr },
	);
}
function parsePreview(
	reply: Record<string, unknown>,
	request: CoordinatorAuthControllerReviewActionOptions,
): CoordinatorControllerReviewPreview {
	const enrollment = reply.enrollment as CoordinatorControllerReviewPreview["enrollment"];
	const invites = reply.reviewed_invites as CoordinatorControllerReviewPreview["reviewed_invites"];
	if (
		(reply.state !== "ready" && reply.state !== "needs_review") ||
		!validId(reply.coordinator_id) ||
		!Array.isArray(reply.reasons) ||
		!reply.reasons.every(
			(reason) => typeof reason === "string" && REVIEW_REASONS.includes(reason),
		) ||
		!Array.isArray(invites) ||
		!invites.every(
			(invite) =>
				invite &&
				validId(invite.invite_id) &&
				(invite.kind === "team_member" || invite.kind === "add_device"),
		)
	)
		throw new Error("invalid_preview");
	if (
		enrollment !== null &&
		(!enrollment ||
			enrollment.device_id !== request.deviceId ||
			!isHash(enrollment.fingerprint) ||
			!["none", "matches"].includes(enrollment.identity_label))
	)
		throw new Error("invalid_preview");
	if (
		reply.state === "ready" &&
		(!enrollment ||
			enrollment.device_id !== request.deviceId ||
			enrollment.fingerprint !== request.fingerprint ||
			!["none", "matches"].includes(enrollment.identity_label) ||
			!isHash(reply.evidence_digest) ||
			reply.reasons.length)
	)
		throw new Error("invalid_preview");
	return {
		state: reply.state,
		coordinator_id: reply.coordinator_id,
		reasons: reply.reasons as CoordinatorControllerReviewPreview["reasons"],
		evidence_digest: reply.state === "ready" ? (reply.evidence_digest as string) : undefined,
		enrollment: enrollment
			? {
					device_id: enrollment.device_id,
					fingerprint: enrollment.fingerprint,
					display_name: null,
					identity_label: enrollment.identity_label,
				}
			: null,
		reviewed_invites: invites.map((invite) => ({ invite_id: invite.invite_id, kind: invite.kind })),
	};
}
function sameLocalOwner(
	before: CoordinatorOwnerReviewLocalEvidence,
	after: CoordinatorOwnerReviewLocalEvidence,
): boolean {
	return (
		after.state === "ready" &&
		before.device?.deviceId === after.device?.deviceId &&
		before.device?.publicKey === after.device?.publicKey &&
		before.device?.fingerprint === after.device?.fingerprint &&
		before.identity?.identityId === after.identity?.identityId &&
		before.identity?.source === after.identity?.source
	);
}
async function confirmReview(
	group: string,
	options: Options,
	evidence: CoordinatorOwnerReviewLocalEvidence,
	request: CoordinatorAuthControllerReviewActionOptions,
	preview: CoordinatorControllerReviewPreview,
): Promise<void> {
	if (!process.stderr.isTTY)
		return failure(
			options,
			"Preview only. Run in a terminal without --json to confirm this review.",
			2,
		);
	const approved = await p.confirm({
		message: "Review this device owner?",
		initialValue: false,
		output: process.stderr,
	});
	if (p.isCancel(approved) || !approved) {
		p.log.info("Nothing changed.", { output: process.stderr });
		return;
	}
	const current = localOptions(options);
	if (
		current.remoteUrl !== request.remoteUrl ||
		!sameLocalOwner(evidence, readCoordinatorOwnerReviewLocalEvidence(current.local))
	) {
		return failure(
			options,
			"Your device or Identity changed. Nothing changed on the coordinator; preview again.",
		);
	}
	const result = await coordinatorAuthControllerReviewAction({
		...request,
		confirmEvidenceDigest: preview.evidence_digest,
	});
	if (
		(result.state !== "created" && result.state !== "existing") ||
		result.coordinator_id !== preview.coordinator_id ||
		result.group_id !== group ||
		result.device_id !== request.deviceId ||
		result.identity_id !== request.identityId ||
		result.fingerprint !== request.fingerprint ||
		typeof result.created_at !== "string"
	)
		throw new Error("invalid_commit_response");
	p.log.success("Device owner reviewed. Memories and access are unchanged.", {
		output: process.stderr,
	});
	if (showTargetedLinkFollowUp(options)) return;
	const quotedGroup = `'${group.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
	p.log.info(
		`Next, link your Google account separately: codemem coordinator link-account ${quotedGroup}`,
		{ output: process.stderr },
	);
}
function showTargetedLinkFollowUp(options: Options): boolean {
	if (!options.coordinator && !options.config && !resolveDbOpt(options)) return false;
	p.log.info(
		"Next, link your Google account separately with codemem coordinator link-account for this group. Reuse the same --coordinator, --config, and --db-path options from this review.",
		{ output: process.stderr },
	);
	return true;
}
function showLocalStop(evidence: CoordinatorOwnerReviewLocalEvidence, options: Options): void {
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify({ ...displayLocal(evidence), unchanged: true, error: "needs_review", message: "Local device ownership needs review. Nothing changed." })}\n`,
		);
		return;
	}
	p.log.warn(`Review stopped: ${evidence.reasons.join(", ")}. Nothing changed.`, {
		output: process.stderr,
	});
}
function emitReviewPreview(
	evidence: CoordinatorOwnerReviewLocalEvidence,
	preview: CoordinatorControllerReviewPreview,
): void {
	let stopped = {};
	if (preview.state !== "ready") {
		stopped = {
			error: "needs_review",
			message: "Coordinator device ownership needs review. Nothing changed.",
		};
		process.exitCode = 1;
	}
	process.stdout.write(
		`${JSON.stringify({ local: displayLocal(evidence), review: preview, unchanged: true, ...stopped })}\n`,
	);
}
async function reviewDeviceOwner(group: string, options: Options): Promise<void> {
	try {
		if (!validId(group)) return failure(options, "Use a valid coordinator group ID.", 2);
		const setup = localOptions(options);
		const evidence = readCoordinatorOwnerReviewLocalEvidence(setup.local);
		if (!options.json) showLocal(evidence);
		if (evidence.state !== "ready" || !evidence.device || !evidence.identity) {
			showLocalStop(evidence, options);
			process.exitCode = 1;
			return;
		}
		if (!setup.adminSecret)
			return failure(
				options,
				"Ask the coordinator operator to configure the existing admin credential. Nothing changed.",
			);
		if (!setup.remoteUrl)
			return failure(
				options,
				"Set --coordinator to a coordinator HTTPS origin (HTTP is allowed only on literal loopback).",
				2,
			);
		const request = {
			remoteUrl: setup.remoteUrl,
			adminSecret: setup.adminSecret,
			groupId: group,
			deviceId: evidence.device.deviceId,
			identityId: evidence.identity.identityId,
			fingerprint: evidence.device.fingerprint,
		};
		const preview = parsePreview(await coordinatorAuthControllerReviewAction(request), request);
		if (options.json) {
			emitReviewPreview(evidence, preview);
			return;
		}
		if (preview.state !== "ready")
			return failure(
				options,
				`Coordinator review stopped: ${preview.reasons.join(", ")}. Nothing changed.`,
			);
		p.log.info(
			`Coordinator: ${preview.coordinator_id}; reviewed invitations: ${preview.reviewed_invites.length}`,
			{ output: process.stderr },
		);
		await confirmReview(group, options, evidence, request, preview);
	} catch (error) {
		failure(options, reviewErrorMessage(error));
	}
}
export function buildCoordinatorReviewDeviceOwnerCommand(): Command {
	const command = new Command("review-device-owner")
		.configureHelp(helpStyle)
		.description("Preview and confirm the owner of your existing device")
		.argument("<group>", "group id")
		.option("-u, --coordinator <url>", "coordinator HTTPS origin (defaults to saved config)");
	addDbOption(command);
	addConfigOption(command);
	addJsonOption(command);
	command.action(reviewDeviceOwner);
	return command;
}
