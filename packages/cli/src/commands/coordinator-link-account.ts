import * as p from "@clack/prompts";
import {
	CoordinatorAccountLinkError,
	linkCoordinatorAccount,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
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
	loopbackHost: string;
}
function requireInteractive(options: Options): boolean {
	if (options.json) {
		emitJsonError(
			"interactive_flow_only",
			"Account linking is interactive. Run without --json and keep the browser link private.",
			2,
		);
		return false;
	}
	if (!process.stderr.isTTY) {
		p.log.error(
			"Account linking requires a terminal. Run this command interactively and keep the browser link private.",
			{ output: process.stderr },
		);
		process.exitCode = 2;
		return false;
	}
	return true;
}
async function linkAccount(group: string, options: Options): Promise<void> {
	if (!requireInteractive(options)) return;
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const config = options.config
			? readCodememConfigFileAtPath(options.config)
			: readCodememConfigFile();
		const coordinatorUrl = options.coordinator ?? config.sync_coordinator_url;
		if (
			typeof coordinatorUrl !== "string" ||
			!coordinatorUrl ||
			(options.loopbackHost !== "127.0.0.1" && options.loopbackHost !== "::1")
		) {
			p.log.error(
				"Set --coordinator to your coordinator HTTPS origin and use --loopback-host 127.0.0.1 or ::1.",
				{ output: process.stderr },
			);
			process.exitCode = 2;
			return;
		}
		await linkCoordinatorAccount({
			dbPath: resolveDbPath(resolveDbOpt(options)),
			keysDir: process.env.CODEMEM_KEYS_DIR?.trim() || undefined,
			groupId: group,
			coordinatorUrl,
			loopbackHost: options.loopbackHost,
			signal: controller.signal,
			onBrowserStart: (privateUrl) => {
				p.log.warn(
					"Keep this browser link private. Open it to review account linking, then return to the coordinator tab to finish.",
					{ output: process.stderr },
				);
				p.log.message(privateUrl, { output: process.stderr });
			},
		});
		p.log.success("Coordinator account linked. Your local Identity has not changed.", {
			output: process.stderr,
		});
	} catch (error) {
		const message =
			error instanceof CoordinatorAccountLinkError
				? error.message
				: "Account linking could not finish. Check your existing device setup and coordinator configuration, then try again.";
		p.log.error(message, { output: process.stderr });
		process.exitCode = 1;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}
export function buildCoordinatorLinkAccountCommand(): Command {
	const command = new Command("link-account")
		.configureHelp(helpStyle)
		.description("Link a coordinator account to your existing Identity")
		.argument("<group>", "group id")
		.option("-u, --coordinator <url>", "coordinator HTTPS origin (defaults to saved config)")
		.option("-l, --loopback-host <host>", "literal loopback host", "127.0.0.1");
	addDbOption(command);
	addConfigOption(command);
	addJsonOption(command);
	command.action(linkAccount);
	return command;
}
