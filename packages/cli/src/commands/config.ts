import { existsSync } from "node:fs";
import {
	getWorkspaceCodememConfigPath,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	writeCodememConfigFile,
} from "@codemem/core";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import { addJsonOption, type JsonOpts } from "../shared-options.js";

type WorkspaceConfigOptions = JsonOpts & {
	workspaceId?: string;
	syncEnabled?: boolean;
	syncHost?: string;
	syncPort?: string;
	syncIntervalS?: string;
	coordinatorUrl?: string;
	coordinatorGroup?: string;
};

type WorkspaceConfigResult = {
	workspace_id: string;
	config_path: string;
	updated_keys: string[];
	config: Record<string, unknown>;
};

function parseIntegerOption(value: string | undefined, flagName: string): number | undefined {
	if (value == null) return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new Error(`Invalid ${flagName}: ${value}`);
	}
	return Number.parseInt(trimmed, 10);
}

function buildWorkspaceConfigPatch(opts: WorkspaceConfigOptions): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	if (opts.syncEnabled === true) patch.sync_enabled = true;
	if (opts.syncEnabled === false) patch.sync_enabled = false;
	if (opts.syncHost?.trim()) patch.sync_host = opts.syncHost.trim();
	const syncPort = parseIntegerOption(opts.syncPort, "--sync-port");
	if (syncPort != null) patch.sync_port = syncPort;
	const syncInterval = parseIntegerOption(opts.syncIntervalS, "--sync-interval-s");
	if (syncInterval != null) patch.sync_interval_s = syncInterval;
	if (opts.coordinatorUrl?.trim()) patch.sync_coordinator_url = opts.coordinatorUrl.trim();
	if (opts.coordinatorGroup?.trim()) patch.sync_coordinator_group = opts.coordinatorGroup.trim();
	return patch;
}

function mergeWorkspaceConfig(
	existingConfig: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	return { ...existingConfig, ...patch };
}

function runWorkspaceConfigCommand(
	opts: WorkspaceConfigOptions & { enableSync?: boolean; disableSync?: boolean },
): WorkspaceConfigResult {
	if (opts.enableSync && opts.disableSync) {
		throw new Error("Use only one of --enable-sync or --disable-sync");
	}
	const workspaceId = opts.workspaceId;
	if (!workspaceId) {
		throw new Error("workspace-id is required");
	}
	const configPath = getWorkspaceCodememConfigPath(workspaceId);
	const existingConfig = existsSync(configPath)
		? readCodememConfigFileAtPath(configPath)
		: readCodememConfigFile();
	const patch = buildWorkspaceConfigPatch({
		workspaceId,
		syncEnabled: opts.enableSync ? true : opts.disableSync ? false : undefined,
		syncHost: opts.syncHost,
		syncPort: opts.syncPort,
		syncIntervalS: opts.syncIntervalS,
		coordinatorUrl: opts.coordinatorUrl,
		coordinatorGroup: opts.coordinatorGroup,
		json: opts.json,
	});
	if (Object.keys(patch).length === 0) {
		throw new Error("Provide at least one config field to update");
	}
	const nextConfig = mergeWorkspaceConfig(existingConfig, patch);
	const savedPath = writeCodememConfigFile(nextConfig, configPath);
	return {
		workspace_id: workspaceId,
		config_path: savedPath,
		updated_keys: Object.keys(patch).sort(),
		config: nextConfig,
	};
}

export const configCommand = new Command("config")
	.configureHelp(helpStyle)
	.description("Manage codemem configuration");

const workspaceCmd = new Command("workspace")
	.configureHelp(helpStyle)
	.description("Create or update workspace-scoped codemem config")
	.argument("[workspace-id]", "workspace identifier")
	.option("--enable-sync", "set sync_enabled=true")
	.option("--disable-sync", "set sync_enabled=false")
	.option("--sync-host <host>", "set sync_host")
	.option("--sync-port <port>", "set sync_port")
	.option("--sync-interval-s <seconds>", "set sync_interval_s")
	.option("--coordinator-url <url>", "set sync_coordinator_url")
	.option("--coordinator-group <group>", "set sync_coordinator_group");

// Hidden backwards-compat alias for --workspace-id <id>
workspaceCmd.addOption(
	new Option("--workspace-id <id>", "workspace identifier (use positional instead)").hideHelp(),
);

addJsonOption(workspaceCmd);

workspaceCmd.action(
	(
		workspaceIdArg: string | undefined,
		opts: WorkspaceConfigOptions & { enableSync?: boolean; disableSync?: boolean },
	) => {
		try {
			// Positional takes precedence over hidden flag alias
			const workspaceId = workspaceIdArg || opts.workspaceId;
			if (!workspaceId) {
				console.error("Error: missing required argument 'workspace-id'");
				process.exitCode = 2;
				return;
			}

			const result = runWorkspaceConfigCommand({ ...opts, workspaceId });

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			console.log(`Updated workspace config: ${result.config_path}`);
			console.log(`Updated keys: ${result.updated_keys.join(", ")}`);
		} catch (err) {
			if (opts.json) {
				console.log(
					JSON.stringify({
						error: "config_error",
						message: err instanceof Error ? err.message : String(err),
					}),
				);
			} else {
				console.error(err instanceof Error ? err.message : String(err));
			}
			process.exitCode = 1;
		}
	},
);

configCommand.addCommand(workspaceCmd);

export { buildWorkspaceConfigPatch, mergeWorkspaceConfig, runWorkspaceConfigCommand };
