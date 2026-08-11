import { detectInstallKind, getUpdateStatus, isStableReleaseVersion, VERSION } from "@codemem/core";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import { addJsonOption, emitJsonError, type JsonOpts } from "../shared-options.js";

interface UpdateCheckOptions extends JsonOpts {
	refresh?: boolean;
}

function cacheQualifier(stale: boolean): string {
	return stale ? " (cached result)" : "";
}

function renderStatusWarning(error: string | null): string {
	return error ? ` Warning: ${error}` : "";
}

function renderHumanStatus(status: Awaited<ReturnType<typeof getUpdateStatus>>): string {
	const warning = renderStatusWarning(status.error);
	if (status.update_available) {
		return `Update available${cacheQualifier(status.stale)}: ${status.current_version} → ${status.latest_version}. ${status.recommended_action}${warning}`;
	}
	if (!isStableReleaseVersion(status.current_version)) {
		return `Unable to compare current version ${status.current_version} with ${status.latest_version}. ${status.recommended_action}${warning}`;
	}
	return `${status.current_version} is up to date${cacheQualifier(status.stale)}.${warning}`;
}

const checkCommand = addJsonOption(
	new Command("check").description("Check for a newer stable codemem release"),
)
	.addOption(new Option("-r, --refresh", "bypass the six-hour release cache"))
	.configureHelp(helpStyle)
	.action(async (options: UpdateCheckOptions) => {
		try {
			const installKind = detectInstallKind({
				entryPath: process.argv[1] ?? "",
				env: process.env,
			});
			const status = await getUpdateStatus({
				currentVersion: VERSION,
				installKind,
				refresh: options.refresh,
			});
			if (status.latest_version === null) {
				const message = status.error ?? "release status is unavailable";
				if (options.json) emitJsonError("update_check_unavailable", message);
				else {
					console.error(`Unable to check for updates: ${message}`);
					process.exitCode = 1;
				}
				return;
			}
			if (options.json) {
				console.log(JSON.stringify(status));
				return;
			}
			console.log(renderHumanStatus(status));
		} catch (error) {
			const message = error instanceof Error ? error.message : "release status is unavailable";
			if (options.json) emitJsonError("update_check_unavailable", message);
			else {
				console.error(`Unable to check for updates: ${message}`);
				process.exitCode = 1;
			}
		}
	});

export const updateCommand = new Command("update")
	.description("Inspect and manage codemem updates")
	.configureHelp(helpStyle)
	.addCommand(checkCommand);
