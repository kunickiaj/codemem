import * as p from "@clack/prompts";
import {
	type CoordinatorGrantIdentityGroupActionOptions,
	coordinatorGrantIdentityGroupAction,
	isCoordinatorControllerAttestationReference,
	normalizeCoordinatorAccountLinkOrigin,
	RemoteCoordinatorRequestError,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addConfigOption, addDbOption, addJsonOption, emitJsonError } from "../shared-options.js";

interface Options {
	config?: string;
	json?: boolean;
}

function failure(options: Options, message: string, exitCode = 1): void {
	if (options.json) {
		emitJsonError("identity_group_grant_unavailable", message, exitCode);
		return;
	}
	p.log.error(message, { output: process.stderr });
	process.exitCode = exitCode;
}

function grantErrorMessage(error: unknown): string {
	if (error instanceof RemoteCoordinatorRequestError) {
		if (error.status === 401 || error.status === 403)
			return "Coordinator refused the configured admin credential. Ask the operator to check it; do not pass credentials on the command line.";
		if (error.code === "invalid_grant_input")
			return "Coordinator rejected the reference. Use the stored controller attestation reference returned by device-owner review.";
		if (error.code === "grant_authority_unavailable")
			return "The stored review cannot authorize this grant. Ask the operator to check current enrollment, review revocation, and group status; do not edit the database.";
		if (error.status === 429 || error.code === "rate_limited")
			return "Coordinator rate limit reached. Wait before previewing and confirming again.";
		if (error.status === 404)
			return "This coordinator does not support the grant endpoint. Ask the operator to check its deployment.";
	}
	return "Transport grant could not be confirmed. Its outcome may be unknown; check coordinator setup and the stored review before retrying. No local profile was changed.";
}

function configuredTarget(options: Options) {
	const config = options.config
		? readCodememConfigFileAtPath(options.config)
		: readCodememConfigFile();
	const sync = readCoordinatorSyncConfig(config);
	return {
		remoteUrl: normalizeCoordinatorAccountLinkOrigin(sync.syncCoordinatorUrl),
		adminSecret: sync.syncCoordinatorAdminSecret,
		timeoutS: Math.max(1, sync.syncCoordinatorTimeoutS),
	};
}

async function confirmGrant(
	request: CoordinatorGrantIdentityGroupActionOptions,
	options: Options,
): Promise<void> {
	const approved = await p.confirm({
		message: "Issue the reviewed Identity's transport enrollment grant?",
		initialValue: false,
		output: process.stderr,
	});
	if (p.isCancel(approved) || approved !== true) {
		p.log.info("Nothing changed.", { output: process.stderr });
		return;
	}
	const current = configuredTarget(options);
	if (current.remoteUrl !== request.remoteUrl || current.adminSecret !== request.adminSecret)
		return failure(options, "Coordinator configuration changed. Nothing changed; preview again.");
	const result = await coordinatorGrantIdentityGroupAction(request);
	p.log.success(
		`Transport enrollment grant ${result.kind}: coordinator ${result.grant.coordinator_id}; Identity ${result.grant.identity_id}; group ${result.grant.group_id}. No Team/Project access or local profile changes.`,
		{ output: process.stderr },
	);
}

async function grantIdentityGroup(attestationId: string, options: Options): Promise<void> {
	try {
		if (!isCoordinatorControllerAttestationReference(attestationId))
			return failure(
				options,
				"Use a stored controller-v1: reference followed by exactly 64 lowercase hexadecimal characters.",
				2,
			);
		const target = configuredTarget(options);
		if (!target.remoteUrl)
			return failure(
				options,
				"Configure a coordinator HTTPS origin without credentials, path, query, or fragment (HTTP only on literal loopback). Nothing changed.",
				2,
			);
		if (!target.adminSecret)
			return failure(
				options,
				"Ask the coordinator operator to configure the existing admin credential. Nothing changed.",
			);
		const preview = {
			state: "preview",
			coordinator_url: target.remoteUrl,
			attestation_id: attestationId,
			unchanged: true,
			eligibility_checked: false,
			message:
				"Explicit transport enrollment grant only, not Team/Project access. The server derives Identity and group from the stored review. No Google flow or local profile changes. Run in a terminal without --json to confirm.",
		};
		if (options.json) {
			process.stdout.write(`${JSON.stringify(preview)}\n`);
			return;
		}
		p.log.info(
			`Coordinator: ${target.remoteUrl}\nController attestation: ${attestationId}\n${preview.message}\nThis is a local request preview, not a check of server eligibility.`,
			{ output: process.stderr },
		);
		if (!process.stdin.isTTY || !process.stderr.isTTY) return;
		await confirmGrant({ ...target, remoteUrl: target.remoteUrl, attestationId }, options);
	} catch (error) {
		failure(options, grantErrorMessage(error));
	}
}

export function buildCoordinatorGrantIdentityGroupCommand(): Command {
	const command = new Command("grant-identity-group")
		.configureHelp(helpStyle)
		.description("Preview and confirm an explicit transport enrollment grant")
		.argument("<attestation-id>", "stored controller attestation reference");
	addConfigOption(command);
	// Compatibility with other coordinator commands; this action never opens a local DB.
	addDbOption(command);
	addJsonOption(command);
	command.action(grantIdentityGroup);
	return command;
}
