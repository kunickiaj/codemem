import * as p from "@clack/prompts";
import {
	type CoordinatorEnrollment,
	coordinatorListDevicesAction,
	coordinatorListRemovedDevicesAction,
	normalizeCoordinatorAccountLinkOrigin,
	RemoteCoordinatorRequestError,
	readCodememConfigFileAtPath,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addJsonOption, emitJsonError, resolveDbOpt } from "../shared-options.js";

interface Options {
	includeDisabled?: boolean;
	removed?: boolean;
	config?: string;
	db?: string;
	dbPath?: string;
	json?: boolean;
}

function remoteTarget(path: string) {
	const config = readCodememConfigFileAtPath(path);
	const url = normalizeCoordinatorAccountLinkOrigin(config.sync_coordinator_url);
	const adminSecret = config.sync_coordinator_admin_secret;
	if (
		!url ||
		typeof adminSecret !== "string" ||
		!adminSecret.trim() ||
		/[\r\n\0]/u.test(adminSecret)
	)
		throw new Error("removal_list_configuration_unavailable");
	return { url, adminSecret };
}

function listFailure(options: Options, message: string) {
	if (options.json) return emitJsonError("list_devices_failed", message);
	p.log.error(message);
	process.exitCode = 1;
}

function safeLabel(value: string) {
	return value.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, " ");
}

function removalListError(error: unknown): string {
	if (error instanceof RemoteCoordinatorRequestError && error.status === 404)
		return "Update the coordinator to list removed devices.";
	if (error instanceof Error && error.message === "removal_list_configuration_unavailable")
		return "Select a coordinator config with a URL and admin secret.";
	if (
		(error instanceof RemoteCoordinatorRequestError &&
			error.code === "device_removal_unavailable") ||
		(error instanceof Error && error.message === "device_removal_unavailable")
	)
		return "The coordinator's device removal storage is unavailable.";
	return "Could not list removed devices. Check the coordinator database or configuration.";
}

async function listRemovedDevices(groupId: string | undefined, options: Options) {
	const group = groupId?.trim();
	if (group === "") return listFailure(options, "Enter a group ID or omit the group filter.");
	const dbPath = resolveDbOpt(options);
	if (dbPath && options.config) return listFailure(options, "Choose either --db-path or --config.");
	try {
		const rows = await coordinatorListRemovedDevicesAction({
			groupId: group,
			dbPath,
			remote: options.config ? remoteTarget(options.config) : undefined,
		});
		if (options.json) {
			console.log(JSON.stringify(rows, null, 2));
			return;
		}
		p.intro("codemem coordinator device list --removed");
		for (const row of rows) {
			p.log.message(`- ${safeLabel(row.device_id)} (${safeLabel(row.group_id)})`);
		}
		p.outro(rows.length ? `${rows.length} removed enrollment(s)` : "No removed devices");
	} catch (error) {
		listFailure(options, removalListError(error));
	}
}

async function listEnrolledDevices(groupId: string | undefined, options: Options) {
	if (!groupId) return listFailure(options, "Group id required unless --removed is set.");
	if (options.config) return listFailure(options, "--config requires --removed.");
	try {
		const rows = await coordinatorListDevicesAction({
			groupId,
			includeDisabled: options.includeDisabled === true,
			dbPath: resolveDbOpt(options) ?? null,
		});
		if (options.json) {
			console.log(JSON.stringify(rows, null, 2));
			return;
		}
		printEnrolledDevices(groupId, rows);
	} catch (error) {
		listFailure(options, error instanceof Error ? error.message : String(error));
	}
}

function printEnrolledDevices(groupId: string, rows: CoordinatorEnrollment[]) {
	p.intro("codemem coordinator device list");
	if (rows.length === 0) {
		p.outro(`No enrolled devices for ${groupId.trim()}`);
		return;
	}
	for (const row of rows) {
		const label =
			String(row.display_name ?? row.device_id ?? "").trim() || String(row.device_id ?? "");
		const enabled = Number(row.enabled ?? 1) === 1 ? "enabled" : "disabled";
		p.log.message(`- ${label} (${String(row.device_id ?? "")}) ${enabled}`);
	}
	p.outro(`${rows.length} device(s)`);
}

export function buildCoordinatorDeviceListCommand() {
	const command = new Command("list")
		.configureHelp(helpStyle)
		.description("List enrolled or removed coordinator devices")
		.argument("[group]", "group id (required unless --removed is set)")
		.option("--include-disabled", "include disabled devices")
		.option("--removed", "list active removals that have not been permanently blocked")
		.option("--config <path>", "read remote coordinator settings for --removed");
	addDbOption(command);
	addJsonOption(command);
	return command.action((groupId: string | undefined, options: Options) =>
		options.removed ? listRemovedDevices(groupId, options) : listEnrolledDevices(groupId, options),
	);
}
