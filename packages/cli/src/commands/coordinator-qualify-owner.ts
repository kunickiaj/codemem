import * as p from "@clack/prompts";
import {
	coordinatorQualifyOwnerAction,
	normalizeCoordinatorAccountLinkOrigin,
	RemoteCoordinatorRequestError,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addConfigOption, addJsonOption, emitJsonError } from "../shared-options.js";

interface Options {
	config?: string;
	json?: boolean;
}
const isAttestation = (value: unknown): value is string =>
	typeof value === "string" && /^controller-v1:[a-f0-9]{64}$/u.test(value);
const isHash = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function isRef(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}
function setup(options: Options) {
	const config = options.config
		? readCodememConfigFileAtPath(options.config)
		: readCodememConfigFile();
	const sync = readCoordinatorSyncConfig(config);
	const remoteUrl = normalizeCoordinatorAccountLinkOrigin(sync.syncCoordinatorUrl);
	if (!remoteUrl || !sync.syncCoordinatorAdminSecret) throw new Error("configuration_unavailable");
	return {
		remoteUrl,
		adminSecret: sync.syncCoordinatorAdminSecret,
		timeoutS: Math.max(1, sync.syncCoordinatorTimeoutS),
	};
}
function parsePreview(reply: Record<string, unknown>, attestationId: string) {
	if (
		reply.state !== "ready" ||
		reply.attestation_id !== attestationId ||
		!isHash(reply.evidence_digest) ||
		!isHash(reply.fingerprint) ||
		![
			"coordinator_id",
			"review_receipt_id",
			"link_id",
			"claim_id",
			"identity_id",
			"group_id",
			"device_id",
		].every((key) => isRef(reply[key]))
	)
		throw new Error("invalid_preview");
	// Copy only nonsecret, validated references; never print an untrusted response.
	return {
		state: "ready",
		attestation_id: attestationId,
		evidence_digest: reply.evidence_digest,
		coordinator_id: reply.coordinator_id as string,
		review_receipt_id: reply.review_receipt_id as string,
		link_id: reply.link_id as string,
		claim_id: reply.claim_id as string,
		identity_id: reply.identity_id as string,
		group_id: reply.group_id as string,
		device_id: reply.device_id as string,
		fingerprint: reply.fingerprint,
	};
}
type Preview = ReturnType<typeof parsePreview>;
function failure(options: Options, error: string, message: string, exitCode = 1) {
	if (options.json) return emitJsonError(error, message, exitCode);
	p.log.error(message, { output: process.stderr });
	process.exitCode = exitCode;
}
async function confirmQualification(
	options: Options,
	request: ReturnType<typeof setup> & { attestationId: string },
	preview: Preview,
) {
	const approved = await p.confirm({
		message: "Allow this linked account to enroll new devices under this Identity?",
		initialValue: false,
		output: process.stderr,
	});
	if (p.isCancel(approved) || !approved) {
		p.log.info("Nothing changed.", { output: process.stderr });
		return;
	}
	const current = setup(options);
	if (current.remoteUrl !== request.remoteUrl || current.adminSecret !== request.adminSecret)
		return failure(
			options,
			"qualification_configuration_changed",
			"Operator configuration changed. Preview again before confirming.",
		);
	const result = await coordinatorQualifyOwnerAction({
		...request,
		confirmEvidenceDigest: preview.evidence_digest,
	});
	if (
		(result.state !== "created" && result.state !== "existing") ||
		!isRef(result.qualification_id) ||
		result.attestation_id !== request.attestationId ||
		result.coordinator_id !== preview.coordinator_id ||
		result.evidence_digest !== preview.evidence_digest
	)
		throw new Error("invalid_commit_response");
	p.log.success(
		"Linked account qualified for device enrollment. Team and Project access are unchanged.",
		{ output: process.stderr },
	);
}
async function qualifyOwner(attestationId: string, options: Options): Promise<void> {
	let confirming = false;
	try {
		if (!isAttestation(attestationId))
			return failure(
				options,
				"qualification_invalid_input",
				"Use the exact controller-v1 reference from a real device-owner review.",
				2,
			);
		const request = { ...setup(options), attestationId };
		const preview = parsePreview(await coordinatorQualifyOwnerAction(request), attestationId);
		if (options.json) {
			process.stdout.write(
				`${JSON.stringify({ preview, network_request: true, unchanged: true })}\n`,
			);
			return;
		}
		p.log.info(
			`Network preview from ${preview.coordinator_id}\nIdentity: ${preview.identity_id}\nLinked account reference: ${preview.link_id}\nDevice: ${preview.device_id}; fingerprint: ${preview.fingerprint}\nReview: ${preview.attestation_id}\nReceipt: ${preview.review_receipt_id}\nClaim: ${preview.claim_id}; group: ${preview.group_id}`,
			{ output: process.stderr },
		);
		p.log.warn(
			"Independently verify the real operator review. Qualification permits new devices under this Identity; an independently trusted transport-group grant is still separate. This does not create a Team, issue a grant, or rewrite a device claim.",
			{ output: process.stderr },
		);
		if (!process.stdin.isTTY || !process.stderr.isTTY) {
			p.log.info(
				"Preview only; no qualification issued. Use a terminal without --json to confirm.",
				{ output: process.stderr },
			);
			return;
		}
		confirming = true;
		await confirmQualification(options, request, preview);
	} catch (error) {
		if (
			error instanceof RemoteCoordinatorRequestError &&
			["preview_changed", "qualification_conflict", "unavailable"].includes(error.code)
		)
			return failure(
				options,
				"qualification_rejected",
				"Qualification denied: evidence changed, was revoked, conflicts, or is unavailable. Preview again; no automatic retry.",
			);
		let message =
			"Qualification server unavailable or preview invalid. The API is inactive until runtime review and explicit schema readiness checks permit mounting it. Check the saved coordinator and operator credential.";
		if (confirming)
			message =
				"Qualification outcome is unknown. It may have committed; do not assume rollback or retry automatically. Ask the coordinator operator to inspect the outcome.";
		failure(
			options,
			confirming ? "qualification_outcome_unknown" : "qualification_unavailable",
			message,
		);
	}
}
export function buildCoordinatorQualifyOwnerCommand(): Command {
	const command = new Command("qualify-owner")
		.configureHelp(helpStyle)
		.description("Preview linked-account device enrollment permission (server may be inactive)")
		.argument("<attestation-id>", "controller-v1 reference from a real operator review");
	addConfigOption(command);
	addJsonOption(command);
	command.action(qualifyOwner);
	return command;
}
