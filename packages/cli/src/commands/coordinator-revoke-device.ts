import * as p from "@clack/prompts";
import {
	type CoordinatorDeviceRevocationPreview,
	coordinatorRevokeDeviceAction,
	normalizeCoordinatorAccountLinkOrigin,
	RemoteCoordinatorRequestError,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addConfigOption, addJsonOption, emitJsonError } from "../shared-options.js";

interface Options {
	config?: string;
	json?: boolean;
}
function validId(value: string): boolean {
	return (
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
	// Read saved operator values only; environment overrides cannot supply credentials.
	const remoteUrl = normalizeCoordinatorAccountLinkOrigin(config.sync_coordinator_url);
	const adminSecret = config.sync_coordinator_admin_secret;
	const timeoutS = config.sync_coordinator_timeout_s ?? 3;
	if (
		!remoteUrl ||
		typeof adminSecret !== "string" ||
		!adminSecret.trim() ||
		/[\r\n\0]/u.test(adminSecret) ||
		typeof timeoutS !== "number" ||
		!Number.isFinite(timeoutS) ||
		timeoutS < 1 ||
		timeoutS > 3600
	)
		throw new Error("revocation_configuration_unavailable");
	return { remoteUrl, adminSecret, timeoutS };
}
function sameConfiguration(options: Options, request: ReturnType<typeof setup>): boolean {
	try {
		const current = setup(options);
		return (
			current.remoteUrl === request.remoteUrl &&
			current.adminSecret === request.adminSecret &&
			current.timeoutS === request.timeoutS
		);
	} catch {
		return false;
	}
}
function failure(options: Options, code: string, message: string, exitCode = 1): void {
	if (options.json) {
		emitJsonError(code, message, exitCode);
		return;
	}
	p.log.error(message, { output: process.stderr });
	process.exitCode = exitCode;
}
const IMPACT =
	"Across the whole coordinator database: revoke this device ID with ANY key and this canonical key under ANY device ID, in ALL groups. The selected group supplies evidence only. Another device continues only when BOTH its device ID and key differ. No immediate offline enforcement, manual/direct-peer trust revocation, or erasure of remote copies. Account links, sessions, grants, memberships and stored memories are not rewritten.";

function receiptLabel(value: string): string {
	// Historical receipt text stays unchanged in Core; escape it only for terminal display.
	return JSON.stringify(value).replace(
		/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu,
		(character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`,
	);
}

async function confirmRevocation(
	options: Options,
	request: ReturnType<typeof setup> & { groupId: string; deviceId: string },
	preview: CoordinatorDeviceRevocationPreview,
	onDispatch: () => void,
) {
	const approved = await p.confirm({
		message: "Revoke BOTH subjects across the whole coordinator database?",
		initialValue: false,
		output: process.stderr,
	});
	if (p.isCancel(approved) || approved !== true) {
		p.log.info("No revocation requested.", { output: process.stderr });
		return;
	}
	if (!sameConfiguration(options, request))
		return failure(
			options,
			"revocation_configuration_changed",
			"Operator configuration changed or is unavailable. No revocation requested; preview again.",
		);
	const result = await coordinatorRevokeDeviceAction({
		...request,
		expectedDigest: preview.expected_digest,
		expectedContext: { coordinatorId: preview.coordinator_id, keyId: preview.key_id },
		onDispatch,
	});
	if (result.state !== "revoked") throw new Error("revocation_response_invalid");
	p.log.success(`Coordinator ${result.coordinator_id}: both whole-database subjects revoked.`, {
		output: process.stderr,
	});
	for (const row of result.revocations)
		p.log.info(
			`${row.subject_kind}: ${row.subject_value}; retained reference: ${receiptLabel(row.revocation_id)}; created: ${receiptLabel(row.created_at)}`,
			{ output: process.stderr },
		);
}
async function revokeDevice(groupId: string, deviceId: string, options: Options): Promise<void> {
	let writeDispatched = false;
	try {
		if (!validId(groupId) || !validId(deviceId))
			return failure(
				options,
				"revocation_invalid_input",
				"Use exact group and device IDs without whitespace or control characters (maximum 256 characters).",
				2,
			);
		const request = { ...setup(options), groupId, deviceId };
		const preview = await coordinatorRevokeDeviceAction(request);
		if (preview.state !== "ready") throw new Error("revocation_response_invalid");
		if (options.json) {
			process.stdout.write(
				`${JSON.stringify({ preview, network_request: true, unchanged: true, message: IMPACT })}\n`,
			);
			return;
		}
		p.log.info(
			`Coordinator: ${preview.coordinator_id}\nEvidence group: ${preview.group_id}\nGlobal device ID: ${preview.device_id}\nCanonical key ID: ${preview.key_id}\nScope: ${preview.scope}`,
			{ output: process.stderr },
		);
		p.log.warn(IMPACT, { output: process.stderr });
		if (!process.stdin.isTTY || !process.stderr.isTTY) {
			p.log.info(
				"Network preview only; no revocation requested. Use a terminal without --json to confirm.",
				{ output: process.stderr },
			);
			return;
		}
		await confirmRevocation(options, request, preview, () => {
			writeDispatched = true;
		});
	} catch (error) {
		if (
			error instanceof RemoteCoordinatorRequestError &&
			error.status === 409 &&
			(error.code === "revocation_preview_stale" || error.code === "revocation_target_unavailable")
		)
			return failure(
				options,
				error.code,
				"Revocation rejected: the target is unavailable or preview evidence changed. Preview again; do not retry automatically.",
			);
		if (writeDispatched)
			return failure(
				options,
				"revocation_outcome_unknown",
				"Revocation outcome is unknown. It may have committed; do not assume rollback or retry automatically. Ask the coordinator operator to inspect both retained subjects.",
			);
		failure(
			options,
			"revocation_unavailable",
			"Revocation preview unavailable or invalid. Check the saved HTTPS origin (HTTP only on literal loopback), operator credential and operator-enabled server context. The CLI does not activate the server. No revocation requested.",
		);
	}
}
export function buildCoordinatorRevokeDeviceCommand(): Command {
	const command = new Command("revoke-device")
		.configureHelp(helpStyle)
		.description("Preview and confirm whole-database device ID and key revocation")
		.argument("<group>", "group supplying current enrollment evidence only")
		.argument("<device>", "device ID to revoke across all groups");
	addConfigOption(command);
	addJsonOption(command);
	command.action(revokeDevice);
	return command;
}
