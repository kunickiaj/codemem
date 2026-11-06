import { statSync } from "node:fs";
import * as p from "@clack/prompts";
import {
	CoordinatorAccountLinkError,
	type CoordinatorAccountLinkStatusRead,
	linkCoordinatorAccount,
	linkCoordinatorAccountHeadless,
	normalizeCoordinatorAccountLinkOrigin,
	readAccountLinkDevice,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorAccountLinkStatus,
	readCoordinatorSyncConfig,
	resolveDbPath,
} from "@codemem/core";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	emitJsonError,
	resolveDbOpt,
} from "../shared-options.js";
import {
	confirmHeadlessApproval,
	showHeadlessCode,
	showHeadlessState,
} from "./coordinator-link-account-headless.js";

interface Options {
	db?: string;
	dbPath?: string;
	config?: string;
	json?: boolean;
	coordinator?: string;
	loopbackHost: string;
	headless?: boolean;
}
function reportLinkFailure(error: unknown, coordinatorOrigin: string | null): void {
	const message =
		error instanceof CoordinatorAccountLinkError
			? error.message
			: "Account linking could not finish. Check your existing device setup and coordinator configuration, then try again.";
	p.log.error(message, { output: process.stderr });
	if (!(error instanceof CoordinatorAccountLinkError)) return;
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
function requireHeadlessTerminal(): boolean {
	if (process.stdin.isTTY && process.stderr.isTTY) return true;
	p.log.error(
		"Headless linking asks for confirmation in this terminal. Run it interactively, for example with `docker exec -it <container> codemem coordinator link-account <group> --headless`.",
		{ output: process.stderr },
	);
	process.exitCode = 2;
	return false;
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
	if (options.headless) return requireHeadlessTerminal();
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
function readLinkConfiguration(options: Options) {
	const config = options.config
		? readCodememConfigFileAtPath(options.config)
		: readCodememConfigFile();
	const coordinatorUrl = normalizeCoordinatorAccountLinkOrigin(
		options.coordinator ?? readCoordinatorSyncConfig(config).syncCoordinatorUrl,
	);
	if (!coordinatorUrl || (options.loopbackHost !== "127.0.0.1" && options.loopbackHost !== "::1"))
		return null;
	const loopbackHost: "127.0.0.1" | "::1" = options.loopbackHost;
	return { config, coordinatorUrl, loopbackHost };
}
function readLinkProfile(
	options: Options,
	selected: NonNullable<ReturnType<typeof readLinkConfiguration>>,
) {
	try {
		const dbPath = resolveDbPath(resolveDbOpt(options));
		const before = statSync(dbPath, { bigint: true });
		const device = readAccountLinkDevice(dbPath);
		const after = statSync(dbPath, { bigint: true });
		const override = process.env.CODEMEM_DEVICE_ID?.trim() || undefined;
		if (
			!before.isFile() ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			(override !== undefined && override !== device.deviceId)
		)
			throw new CoordinatorAccountLinkError("device_unavailable");
		let actor = selected.config.actor_id;
		if (Object.hasOwn(process.env, "CODEMEM_ACTOR_ID")) actor = process.env.CODEMEM_ACTOR_ID;
		const identityId =
			(typeof actor === "string" ? actor.trim() : "") || `local:${device.deviceId}`;
		return {
			dbPath,
			keysDir: process.env.CODEMEM_KEYS_DIR?.trim() || undefined,
			coordinatorUrl: selected.coordinatorUrl,
			expectedIdentityId: identityId,
			deviceId: device.deviceId,
			fingerprint: device.fingerprint,
			fileIdentity: { dev: after.dev.toString(), ino: after.ino.toString() },
		};
	} catch {
		throw new CoordinatorAccountLinkError("device_unavailable");
	}
}
function profileMatches(options: Options, snapshot: string): boolean {
	const selected = readLinkConfiguration(options);
	return selected !== null && JSON.stringify(readLinkProfile(options, selected)) === snapshot;
}
function eligibleStatus(remote: CoordinatorAccountLinkStatusRead, identityId: string) {
	if (remote.kind !== "status") {
		if (remote.kind === "unavailable" && remote.code === "coordinator_auth_schema_upgrade_required")
			throw new CoordinatorAccountLinkError("schema_upgrade_required");
		throw new CoordinatorAccountLinkError("invalid_response");
	}
	const status = remote.status;
	if (status.state === "conflict" || status.state === "revoked")
		throw new CoordinatorAccountLinkError("link_conflict");
	if (status.state === "review_required") throw new CoordinatorAccountLinkError("review_required");
	if (status.identityId !== identityId) throw new CoordinatorAccountLinkError("identity_mismatch");
	return status;
}
/** Starts the desktop or headless flow once the Identity is eligible. */
async function startLink(
	options: Options,
	context: {
		group: string;
		selected: NonNullable<ReturnType<typeof readLinkConfiguration>>;
		profile: ReturnType<typeof readLinkProfile>;
		status: ReturnType<typeof eligibleStatus>;
		signal: AbortSignal;
	},
): Promise<void> {
	const { profile, status } = context;
	const snapshot = JSON.stringify(profile);
	const request = {
		...profile,
		groupId: context.group,
		coordinatorUrl: context.selected.coordinatorUrl,
		expectedAuthority: status.authority,
		expectedCoordinatorId: status.coordinatorId,
		assertCurrentContext: () => profileMatches(options, snapshot),
		signal: context.signal,
	};
	if (options.headless) {
		await linkCoordinatorAccountHeadless({
			...request,
			onCode: showHeadlessCode,
			onState: showHeadlessState,
			approve: (approval, prompt) =>
				confirmHeadlessApproval(profile.expectedIdentityId, approval, prompt),
		});
		p.log.success("Linked.", { output: process.stderr });
		return;
	}
	const result = await linkCoordinatorAccount({
		...request,
		loopbackHost: context.selected.loopbackHost,
		onBrowserStart: showPrivateBrowserLink,
	});
	p.log.success(
		`Coordinator account linked to coordinator Identity ${result.identityId}. Your local Identity has not changed.`,
		{ output: process.stderr },
	);
}
async function linkAccount(group: string, options: Options): Promise<void> {
	if (!requireInteractive(options)) return;
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	let coordinatorOrigin: string | null = null;
	try {
		const selected = readLinkConfiguration(options);
		if (!selected) {
			p.log.error(
				"Set --coordinator to your coordinator HTTPS origin and use --loopback-host 127.0.0.1 or ::1.",
				{ output: process.stderr },
			);
			process.exitCode = 2;
			return;
		}
		const { coordinatorUrl } = selected;
		coordinatorOrigin = coordinatorUrl;
		const profile = readLinkProfile(options, selected);
		const remote = await readCoordinatorAccountLinkStatus({
			...profile,
			coordinatorUrl,
			identityId: profile.expectedIdentityId,
			groupId: group,
			signal: controller.signal,
		});
		const status = eligibleStatus(remote, profile.expectedIdentityId);
		if (status.state === "linked") {
			p.log.success("This Identity is already linked. No account-link request was started.", {
				output: process.stderr,
			});
			return;
		}
		await startLink(options, { group, selected, profile, status, signal: controller.signal });
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
		.option("-l, --loopback-host <host>", "literal loopback host", "127.0.0.1")
		.addOption(
			new Option(
				"-H, --headless",
				"link from a device without a browser: enter a code on another computer",
			).conflicts("loopbackHost"),
		);
	addDbOption(command);
	addConfigOption(command);
	addJsonOption(command);
	command.action(linkAccount);
	return command;
}
