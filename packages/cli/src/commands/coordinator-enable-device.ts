import * as p from "@clack/prompts";
import { coordinatorEnableDeviceAction } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addJsonOption, emitJsonError, resolveDbOpt } from "../shared-options.js";

interface Options {
	db?: string;
	dbPath?: string;
	json?: boolean;
}

function fail(options: Options, code: string, message: string) {
	if (options.json) return emitJsonError(code, message);
	p.log.error(message);
	process.exitCode = 1;
}

async function enableDevice(group: string, device: string, options: Options) {
	const groupId = group.trim();
	const deviceId = device.trim();
	try {
		const ok = await coordinatorEnableDeviceAction({
			groupId,
			deviceId,
			dbPath: resolveDbOpt(options),
			// This command operates on the selected local database, even with a remote configured.
			remoteUrl: "",
			adminSecret: "",
		});
		// The store also returns false for a blocked device that is still enrolled.
		if (!ok)
			return fail(
				options,
				"device_not_enabled",
				"The device was not enabled. It has no enrollment in this group, or it is permanently blocked.",
			);
		if (options.json) {
			console.log(JSON.stringify({ ok: true, group_id: groupId, device_id: deviceId }, null, 2));
			return;
		}
		p.log.success("Device enabled.");
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "device_removed")
			return fail(
				options,
				code,
				"This device was removed. It must rejoin before it can be enabled.",
			);
		if (code === "device_revoked")
			return fail(options, code, "This device is permanently blocked.");
		return fail(
			options,
			"enable_failed",
			"Could not enable the device. Check the coordinator database and device IDs.",
		);
	}
}

export function buildCoordinatorEnableDeviceCommand() {
	const command = new Command("enable")
		.configureHelp(helpStyle)
		.description("Enable an existing device enrollment in a local coordinator group")
		.argument("<group>", "group id")
		.argument("<device-id>", "device id");
	addDbOption(command);
	addJsonOption(command);
	return command.action(enableDevice);
}
