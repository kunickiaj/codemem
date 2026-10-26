import * as p from "@clack/prompts";
import {
	type CoordinatorAuthControllerReviewActionOptions,
	type CoordinatorControllerReviewPreview,
	type CoordinatorOwnerReviewLocalEvidence,
	type CoordinatorOwnerReviewLocalOptions,
	coordinatorAuthControllerReviewAction,
	normalizeCoordinatorAccountLinkOrigin,
	parseControllerHistoryEvidence,
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
	"legacy_history_invalid",
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
	if (error instanceof CoordinatorHistoryUnavailableError)
		return "Update the coordinator before reviewing this device owner: retained history evidence was missing or invalid in its response. Nothing changed.";
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
	timeoutS: number;
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
		timeoutS: Math.max(1, sync.syncCoordinatorTimeoutS),
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
function validInviteCount(reply: Record<string, unknown>, invites: unknown[]): boolean {
	return (
		invites.length <= 10 &&
		Number.isSafeInteger(reply.reviewed_invite_count) &&
		(reply.reviewed_invite_count as number) >= invites.length
	);
}
function validInviteRef(
	invite: CoordinatorControllerReviewPreview["reviewed_invites"][number],
): boolean {
	return (
		!!invite &&
		validId(invite.invite_id) &&
		(invite.kind === "team_member" || invite.kind === "add_device")
	);
}
function previewEnrollment(enrollment: CoordinatorControllerReviewPreview["enrollment"]) {
	if (!enrollment) return null;
	return {
		device_id: enrollment.device_id,
		fingerprint: enrollment.fingerprint,
		display_name: null,
		identity_label: enrollment.identity_label,
	};
}
class CoordinatorHistoryUnavailableError extends Error {}
function parsePreviewHistory(value: unknown, coordinatorId: string) {
	try {
		return parseControllerHistoryEvidence(value, coordinatorId);
	} catch {
		throw new CoordinatorHistoryUnavailableError();
	}
}
function parsePreview(
	payload: unknown,
	request: CoordinatorAuthControllerReviewActionOptions,
): CoordinatorControllerReviewPreview {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		throw new Error("invalid_preview");
	const reply = payload as Record<string, unknown>;
	if (!Array.isArray(reply.legacy_history)) throw new CoordinatorHistoryUnavailableError();
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
		!validInviteCount(reply, invites) ||
		!invites.every(validInviteRef)
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
		legacy_history: parsePreviewHistory(reply.legacy_history, reply.coordinator_id),
		reasons: reply.reasons as CoordinatorControllerReviewPreview["reasons"],
		evidence_digest: reply.state === "ready" ? (reply.evidence_digest as string) : undefined,
		enrollment: previewEnrollment(enrollment),
		reviewed_invites: invites.map((invite) => ({ invite_id: invite.invite_id, kind: invite.kind })),
		reviewed_invite_count: reply.reviewed_invite_count as number,
	};
}
function sameLocalOwner(
	before: CoordinatorOwnerReviewLocalEvidence,
	after: CoordinatorOwnerReviewLocalEvidence,
): boolean {
	return (
		after.state === "ready" &&
		before.ownershipRecords.actorPresent === after.ownershipRecords.actorPresent &&
		before.ownershipRecords.deviceAssignmentPresent ===
			after.ownershipRecords.deviceAssignmentPresent &&
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
	if (!process.stdin.isTTY || !process.stderr.isTTY)
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
		typeof result.attestation_id !== "string" ||
		result.attestation_id.length !== 78 ||
		!/^controller-v1:[a-f0-9]{64}$/.test(result.attestation_id) ||
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
	p.log.info(
		`Controller attestation reference: ${result.attestation_id}\nKeep this noncredential reference for a separate, explicit operator-issued transport group grant. This review does not issue that grant or grant Team/Project access.`,
		{ output: process.stderr },
	);
	if (showTargetedLinkFollowUp(options)) return;
	showLinkFollowUp(group);
}
function showLinkFollowUp(group: string): void {
	if (group.includes("\\")) {
		p.log.info(
			`Next, run codemem coordinator link-account with group ID ${JSON.stringify(group)}. Quote the ID for your shell.`,
			{ output: process.stderr },
		);
		return;
	}
	const quotedGroup = `'${group.replaceAll("'", "'\\''")}'`;
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
type HistorySubject = Pick<
	CoordinatorAuthControllerReviewActionOptions,
	"deviceId" | "fingerprint" | "identityId"
>;

function terminalIdentifier(value: string): string {
	return JSON.stringify(value).replace(
		/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu,
		(character) => `\\u{${character.codePointAt(0)?.toString(16)}}`,
	);
}

function historyAssociation(
	deviceId: string,
	fingerprint: string,
	subject: HistorySubject,
): string {
	if (deviceId === subject.deviceId) {
		if (fingerprint === subject.fingerprint) return "Current device; current fingerprint";
		return "Current device; different recorded key";
	}
	if (fingerprint === subject.fingerprint) return "Other device; current fingerprint";
	return "Other recorded device/key; canonical-key equivalence is not identified in this summary";
}

function* controllerHistoryRows(
	preview: CoordinatorControllerReviewPreview,
	subject: HistorySubject,
): Generator<{ text: string; records: number; decisions: number }> {
	for (const record of preview.legacy_history) {
		yield {
			text: `Historical group ${terminalIdentifier(record.group_id)}; Team ${terminalIdentifier(record.manifest.team_id)}; completed ${terminalIdentifier(record.completed_at)}\nCandidate: ${terminalIdentifier(record.candidate_ref)}; manifest version: ${record.manifest_version}; recorded: ${terminalIdentifier(record.created_at)}\nOriginal retained manifest JSON: ${terminalIdentifier(record.manifest_json)}`,
			records: 1,
			decisions: 0,
		};
		for (const decision of record.manifest.device_decisions) {
			let identity =
				decision.identity_id === null ? "none" : terminalIdentifier(decision.identity_id);
			if (decision.identity_evidence === "label") identity += " (guessed by another device)";
			yield {
				text: `  ${decision.decision}; Identity: ${identity}; enabled: ${decision.enabled ? "yes" : "no"}\n  Device: ${terminalIdentifier(decision.device_id)}; fingerprint: ${terminalIdentifier(decision.key_fingerprint)}\n  ${historyAssociation(decision.device_id, decision.key_fingerprint, subject)}`,
				records: 0,
				decisions: 1,
			};
		}
	}
}

/** A truncated summary must never authorize the terminal confirmation. */
export function formatControllerReviewHistory(
	preview: CoordinatorControllerReviewPreview,
	subject: HistorySubject,
): { text: string; complete: boolean } {
	const lines = [
		`Proposed current owner Identity: ${terminalIdentifier(subject.identityId)}`,
		"Retained legacy sharing assignments (not ownership changes):",
		"Records may contain other devices. Different fingerprints may represent known key aliases; no row below is assumed to belong to this device unless labeled as an exact device/fingerprint match.",
	];
	let records = 0;
	let decisions = 0;
	let characters = lines.join("\n").length;
	let complete = true;
	for (const row of controllerHistoryRows(preview, subject)) {
		if (
			records + row.records > 20 ||
			decisions + row.decisions > 40 ||
			characters + row.text.length + 1 > 24_000
		) {
			complete = false;
			break;
		}
		lines.push(row.text);
		records += row.records;
		decisions += row.decisions;
		characters += row.text.length + 1;
	}
	if (preview.legacy_history.length === 0) lines.push("No relevant retained legacy assignments.");
	if (!complete) {
		const totalDecisions = preview.legacy_history.reduce(
			(total, record) => total + record.manifest.device_decisions.length,
			0,
		);
		lines.push(
			`TRUNCATED: showing ${records} of ${preview.legacy_history.length} records and ${decisions} of ${totalDecisions} device decisions. Terminal confirmation is disabled.`,
		);
	}
	lines.push(
		"Previous assignments are retained. This review records current ownership; it does not migrate sharing, move memories, merge Identities, or grant Team/Project access.",
		"Approval grants the existing controller authority, including account management when the coordinator permits it. Google account linking remains a separate step.",
	);
	return { text: lines.join("\n"), complete };
}

function showCoordinatorReview(
	preview: CoordinatorControllerReviewPreview,
	request: HistorySubject,
	options: Options,
): boolean {
	p.log.info(
		`Coordinator: ${preview.coordinator_id}; reviewed invitations: ${preview.reviewed_invite_count}`,
		{ output: process.stderr },
	);
	const history = formatControllerReviewHistory(preview, request);
	p.log.message(history.text, { output: process.stderr });
	if (history.complete) return true;
	failure(
		options,
		"Nothing changed. Run the same command with --json to inspect all retained evidence. Ask the coordinator operator to use the administrator review API for evidence exceeding this terminal's display limit.",
		2,
	);
	return false;
}

function reportReviewFailure(options: Options, error: unknown): void {
	if (options.json && error instanceof CoordinatorHistoryUnavailableError) {
		process.stdout.write(
			`${JSON.stringify({ error: "owner_review_unavailable", message: reviewErrorMessage(error), unchanged: true })}\n`,
		);
		process.exitCode = 1;
		return;
	}
	failure(options, reviewErrorMessage(error));
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
			timeoutS: setup.timeoutS,
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
		if (!showCoordinatorReview(preview, request, options)) return;
		await confirmReview(group, options, evidence, request, preview);
	} catch (error) {
		reportReviewFailure(options, error);
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
