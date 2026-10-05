import * as p from "@clack/prompts";
import {
	CoordinatorAccountLinkError,
	linkCoordinatorAccount,
	normalizeCoordinatorAccountLinkOrigin,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
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
	loopbackHost: string;
}
function reportLinkFailure(error: unknown, coordinatorOrigin: string | null): void {
	const message =
		error instanceof CoordinatorAccountLinkError
			? error.message
			: "Account linking could not finish. Check your existing device setup and coordinator configuration, then try again.";
	p.log.error(message, { output: process.stderr });
	if (!(error instanceof CoordinatorAccountLinkError)) return;
	if (error.code === "review_required") {
		p.log.message(
			"Run codemem coordinator review-device-owner for this group on this device with your configured coordinator-admin credential. Reuse this command's --coordinator, --config, --db-path/-d and environment settings (including the coordinator URL), then link again. If the review stops, ask your coordinator operator.",
			{ output: process.stderr },
		);
	}
	if (error.code !== "link_conflict") return;
	let guidance = "Replacing or removing coordinator account links is not supported. ";
	if (coordinatorOrigin) {
		const signInUrl = new URL("/auth/sign-in", coordinatorOrigin).href;
		guidance += `If this Google account already belongs to the intended coordinator Identity, sign in at ${signInUrl}. Otherwise, ask your coordinator operator.`;
	} else {
		guidance += "Ask your coordinator operator.";
	}
	p.log.message(guidance, { output: process.stderr });
}
function showPrivateBrowserLink(privateUrl: string): void {
	p.log.warn(
		"Keep this browser link private. Open it to review account linking, then return to the coordinator tab to finish.",
		{ output: process.stderr },
	);
	p.log.message(privateUrl, { output: process.stderr });
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
	let coordinatorOrigin: string | null = null;
	try {
		const config = options.config
			? readCodememConfigFileAtPath(options.config)
			: readCodememConfigFile();
		const coordinatorUrl =
			options.coordinator ?? readCoordinatorSyncConfig(config).syncCoordinatorUrl;
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
		coordinatorOrigin = normalizeCoordinatorAccountLinkOrigin(coordinatorUrl);
		const result = await linkCoordinatorAccount({
			dbPath: resolveDbPath(resolveDbOpt(options)),
			keysDir: process.env.CODEMEM_KEYS_DIR?.trim() || undefined,
			groupId: group,
			coordinatorUrl,
			loopbackHost: options.loopbackHost,
			signal: controller.signal,
			onBrowserStart: showPrivateBrowserLink,
		});
		p.log.success(
			`Coordinator account linked to coordinator Identity ${result.identityId}. Your local Identity has not changed.`,
			{ output: process.stderr },
		);
	} catch (error) {
		reportLinkFailure(error, coordinatorOrigin);
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
