import { statSync } from "node:fs";
import * as p from "@clack/prompts";
import {
	type DeviceRejoinOutcome,
	normalizeCoordinatorAccountLinkOrigin,
	readAccountLinkDevice,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorSyncConfig,
	resolveDbPath,
	runDeviceRejoin,
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
}

function readProfile(options: Options) {
	const config = options.config
		? readCodememConfigFileAtPath(options.config)
		: readCodememConfigFile();
	const coordinatorUrl = normalizeCoordinatorAccountLinkOrigin(
		readCoordinatorSyncConfig(config).syncCoordinatorUrl,
	);
	if (!coordinatorUrl) return null;
	const dbPath = resolveDbPath(resolveDbOpt(options));
	const before = statSync(dbPath, { bigint: true });
	const device = readAccountLinkDevice(dbPath);
	const after = statSync(dbPath, { bigint: true });
	const override = process.env.CODEMEM_DEVICE_ID?.trim();
	if (
		!before.isFile() ||
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		(override && override !== device.deviceId)
	)
		return null;
	return {
		coordinatorUrl,
		dbPath,
		keysDir: process.env.CODEMEM_KEYS_DIR?.trim() || undefined,
		deviceId: device.deviceId,
		fingerprint: device.fingerprint,
		file: { dev: after.dev.toString(), ino: after.ino.toString() },
	};
}

function currentProfileMatches(options: Options, expected: string) {
	try {
		return JSON.stringify(readProfile(options)) === expected;
	} catch {
		return false;
	}
}

const REFUSAL_TEXT: Record<Extract<DeviceRejoinOutcome, { kind: "refused" }>["reason"], string> = {
	unavailable:
		"The coordinator could not start or finish rejoin for this device. Check that it supports device rejoin and that this device has an account link.",
	removal_changed: "The device’s removal or access changed. Start rejoin again.",
	account_not_linked: "This Google account has no live link for rejoin.",
	wrong_account: "Sign in with the Google account linked to this device’s Identity.",
	no_destination: "This device cannot rejoin any of its former groups.",
	removal_conflict:
		"This device has removal records for different keys. Ask the coordinator operator to review them.",
	blocked: "This device is blocked and cannot rejoin.",
	daily_limit: "This Identity reached its rejoin limit for the last 24 hours.",
	retry: "The coordinator could not confirm the request. Start again from this terminal.",
};
const FAILURE_TEXT: Record<Extract<DeviceRejoinOutcome, { kind: "failed" }>["error"], string> = {
	device_unavailable:
		"Codemem could not read the existing device key. Check the local database and key settings.",
	start_unconfirmed:
		"The coordinator did not confirm the start. Check its connection and rejoin support.",
	browser_stopped: "The browser sign-in did not finish. Start again from this terminal.",
	review_unavailable: "Codemem could not verify the browser review. No finalize request was sent.",
};

function resultText(result: DeviceRejoinOutcome) {
	if (result.kind === "refused") return REFUSAL_TEXT[result.reason];
	if (result.kind === "failed") return FAILURE_TEXT[result.error];
	return "Codemem could not confirm whether this device rejoined. Check sync status before starting again.";
}

async function rejoin(options: Options): Promise<void> {
	if (options.json) {
		emitJsonError(
			"interactive_flow_only",
			"Device rejoin requires a private browser link. Run without --json.",
			2,
		);
		return;
	}
	if (!process.stderr.isTTY) {
		p.log.error("Run device rejoin in a terminal and keep the browser link private.", {
			output: process.stderr,
		});
		process.exitCode = 2;
		return;
	}
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const profile = readProfile(options);
		if (!profile) throw new Error("Device profile unavailable");
		const snapshot = JSON.stringify(profile);
		const result = await runDeviceRejoin({
			...profile,
			signal: controller.signal,
			assertCurrentContext: () => currentProfileMatches(options, snapshot),
			openBrowser: (url) => {
				p.log.warn("Keep this link private. Open it in a browser on this device.", {
					output: process.stderr,
				});
				p.log.message(url, { output: process.stderr });
			},
		});
		if (result.kind === "finalized") {
			p.log.success(
				"This device rejoined. Codemem will refresh its sync status on the next coordinator check.",
				{ output: process.stderr },
			);
			return;
		}
		p.log.error(resultText(result), { output: process.stderr });
		process.exitCode = 1;
	} catch {
		p.log.error(
			"Device rejoin is unavailable. Check the existing device key and coordinator settings.",
			{ output: process.stderr },
		);
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}

export function buildSyncRejoinCommand(): Command {
	const command = new Command("rejoin")
		.configureHelp(helpStyle)
		.description("Sign in to rejoin this removed device");
	addConfigOption(command);
	addDbOption(command);
	addJsonOption(command);
	return command.action(rejoin);
}
