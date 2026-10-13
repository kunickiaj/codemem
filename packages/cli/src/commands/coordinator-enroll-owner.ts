import { dirname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import {
	enrollOwnerProfile,
	expandUserPath,
	OwnerProfileEnrollmentError,
	readCodememConfigFileAtPath,
	readCoordinatorSyncConfig,
	resolveCodememConfigPath,
	resolveDbPath,
	resolveKeyPaths,
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

type Options = {
	db?: string;
	dbPath?: string;
	config?: string;
	json?: boolean;
	coordinator?: string;
	keysDir?: string;
	stateDir?: string;
	prepare?: boolean;
	resume?: boolean;
	capability?: string;
	reviewDigest?: string;
};
const CAPTURE_WARNING =
	"Stop OpenCode capture, the Viewer and the sync daemon before preparing or resuming. Keep them stopped until Verified coordinator Identity is shown. Any capture/history change during the browser ceremony can stop local adoption after the server commits, leaving DB and config separate and requiring operator review.";
function showPrivateBrowserLink(privateUrl: string): void {
	p.log.warn(
		"Keep this browser link private. Open it to review the Google account and device, then return here to finish. No Team or Project access is added.",
		{ output: process.stderr },
	);
	p.log.message(privateUrl, { output: process.stderr });
}
function reportUsageError(options: Options, message: string): false {
	if (options.json) emitJsonError("usage_error", message, 2);
	else {
		p.log.error(message, { output: process.stderr });
		process.exitCode = 2;
	}
	return false;
}
function usage(options: Options): boolean {
	if (
		options.prepare === options.resume ||
		(options.prepare && (options.capability || options.reviewDigest)) ||
		(options.resume && !options.reviewDigest) ||
		(options.resume && (options.json || !process.stderr.isTTY))
	) {
		const message =
			"Use --prepare first, then review its device, current Identity, capture counts and digest. Resume interactively with --resume --review-digest; add --capability only to start the browser ceremony.";
		return reportUsageError(options, message);
	}
	if (options.capability !== undefined && !/^[A-Za-z0-9._-]{1,512}$/.test(options.capability)) {
		return reportUsageError(
			options,
			"Supply --capability exactly as issued, without whitespace or unsupported characters, and at most 512 characters. The prepared attempt has not been consumed.",
		);
	}
	if (options.reviewDigest !== undefined && !/^[0-9a-f]{64}$/.test(options.reviewDigest)) {
		return reportUsageError(
			options,
			"Supply --review-digest as the exact 64-character lowercase hexadecimal digest from --prepare. Enrollment has not started.",
		);
	}
	return environmentUsage(options);
}
function environmentUsage(options: Options): boolean {
	const overrides = [
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_GROUP",
		"CODEMEM_SYNC_COORDINATOR_GROUPS",
		"CODEMEM_WORKSPACE_ID",
		"CODEMEM_ACTOR_ID",
		"CODEMEM_DEVICE_ID",
		"CODEMEM_ACTOR_DISPLAY_NAME",
	].filter((name) => process.env[name] !== undefined);
	if (overrides.length) {
		return reportUsageError(
			options,
			`Unset ${overrides.join(" and ")} before owner enrollment. Use --coordinator and the group argument, or the selected config; environment overrides cannot be adopted safely.`,
		);
	}
	if (process.env.CODEMEM_SYNC_KEY_STORE?.trim().toLowerCase() === "keychain") {
		return reportUsageError(
			options,
			"CODEMEM_SYNC_KEY_STORE=keychain is not supported for owner enrollment. Keep signing keys unchanged; select a supported existing file-key profile.",
		);
	}
	return true;
}
function coordinatorOriginUsage(options: Options, value: string): boolean {
	try {
		const url = new URL(value);
		if (
			value.trim() === value &&
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			(value === url.origin || value === `${url.origin}/`)
		)
			return true;
	} catch {
		// Invalid values and embedded credentials never appear in user-facing errors.
	}
	return reportUsageError(
		options,
		"Set --coordinator or sync_coordinator_url to an HTTPS origin without credentials, paths, query strings, fragments, or surrounding whitespace.",
	);
}
function groupUsage(options: Options, groupId: string): boolean {
	if (
		groupId.length > 0 &&
		groupId.length <= 256 &&
		groupId.trim() === groupId &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(groupId)
	)
		return true;
	return reportUsageError(
		options,
		"Use a nonempty group ID of at most 256 characters, without surrounding whitespace or control characters.",
	);
}
function pathEnvironmentUsage(
	options: Options,
	selected: { config?: string; db?: string; keys?: string },
): boolean {
	for (const [name, path, flag] of [
		["CODEMEM_CONFIG", selected.config, "--config"],
		["CODEMEM_DB", selected.db, "--db-path"],
		["CODEMEM_KEYS_DIR", selected.keys, "--keys-dir"],
	] as const) {
		const selectedPath = normalizeEnrollmentPath(name, path);
		const environmentPath =
			name === "CODEMEM_KEYS_DIR" ? process.env[name]?.trim() || undefined : process.env[name];
		const override = normalizeEnrollmentPath(name, environmentPath);
		if (
			selectedPath !== undefined &&
			override !== undefined &&
			resolve(selectedPath) !== resolve(override)
		) {
			return reportUsageError(
				options,
				`Unset ${name} or make it match ${flag} before owner enrollment. Conflicting profile paths cannot be adopted safely.`,
			);
		}
	}
	return true;
}
function normalizeEnrollmentPath(
	name: "CODEMEM_CONFIG" | "CODEMEM_DB" | "CODEMEM_KEYS_DIR",
	path: string | undefined,
): string | undefined {
	if (path === undefined) return undefined;
	// Explicit key paths remain literal; their environment override is normalized before this call.
	if (name === "CODEMEM_KEYS_DIR") return path;
	const value = name === "CODEMEM_CONFIG" ? path.trim() : path;
	return value ? expandUserPath(value) : undefined;
}
function resolveEnrollmentProfile(options: Options) {
	const configPath = resolveCodememConfigPath(options.config, "write").resolved.path;
	const config = readCodememConfigFileAtPath(configPath);
	const coordinatorUrl =
		options.coordinator ?? readCoordinatorSyncConfig(config).syncCoordinatorUrl;
	if (!coordinatorUrl) {
		reportUsageError(
			options,
			"Set --coordinator to your coordinator HTTPS URL, or set sync_coordinator_url in the selected config.",
		);
		return null;
	}
	if (!coordinatorOriginUsage(options, coordinatorUrl)) return null;
	const dbPath = resolveDbPath(resolveDbOpt(options));
	const keysDir =
		options.keysDir ??
		(process.env.CODEMEM_KEYS_DIR?.trim() || undefined) ??
		dirname(resolveKeyPaths()[0]);
	if (!pathEnvironmentUsage(options, { config: configPath, db: dbPath, keys: keysDir }))
		return null;
	return { configPath, coordinatorUrl, dbPath, keysDir };
}
async function enroll(groupId: string, options: Options): Promise<void> {
	if (!usage(options)) return;
	if (!groupUsage(options, groupId)) return;
	if (
		!pathEnvironmentUsage(options, {
			config: options.config,
			db: resolveDbOpt(options),
			keys: options.keysDir,
		})
	)
		return;
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		if (!options.json) p.log.warn(CAPTURE_WARNING, { output: process.stderr });
		const profile = resolveEnrollmentProfile(options);
		if (!profile) return;
		const result = await enrollOwnerProfile({
			...profile,
			groupId,
			stateDir: options.stateDir ?? join(dirname(profile.dbPath), "owner-enrollment"),
			mode: options.prepare ? "prepare" : "resume",
			capability: options.capability,
			reviewedDigest: options.reviewDigest,
			signal: controller.signal,
			onBrowserStart: showPrivateBrowserLink,
		});
		showResult(result, options);
	} catch (error) {
		const safe =
			error instanceof OwnerProfileEnrollmentError
				? new OwnerProfileEnrollmentError(error.code)
				: new OwnerProfileEnrollmentError("review_required");
		const message = safe.message;
		if (options.json) emitJsonError(safe.code, message);
		else {
			p.log.error(message, { output: process.stderr });
			process.exitCode = 1;
		}
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}
function showResult(
	result: Awaited<ReturnType<typeof enrollOwnerProfile>>,
	options: Options,
): void {
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ ...result, warning: CAPTURE_WARNING })}\n`);
		return;
	}
	if (result.kind === "prepared") {
		p.log.message(
			`Current Identity: ${result.review.actorId}\nDevice: ${result.review.deviceId}\nPublic key: ${result.review.publicKey}\nCapture: ${result.review.captureId ?? "none"} (${result.review.captureAssociation})\nOwn local memories: ${result.review.localMemoryCount}\nForeign rows retained without new access: ${result.review.retainedForeignMemoryCount}\nReview digest: ${result.reviewDigest}`,
			{ output: process.stderr },
		);
		p.log.message(
			`Give the private request file to your coordinator operator: ${result.requestFile}`,
			{ output: process.stderr },
		);
		p.log.warn(
			"Only the current Identity/device assignment will change. Signing keys, memory authorship and history stay unchanged; no membership is inferred.",
			{ output: process.stderr },
		);
		return;
	}
	p.log.success(
		`Verified coordinator Identity: ${result.identityId}\nOwner binding: ${result.bindingId}`,
		{ output: process.stderr },
	);
}
export function buildCoordinatorEnrollOwnerCommand(): Command {
	const command = new Command("enroll-owner")
		.configureHelp(helpStyle)
		.description("Review and enroll this existing profile's device owner")
		.argument("<group>", "group id")
		.option("-u, --coordinator <url>", "coordinator HTTPS origin (defaults to config)")
		.option("--keys-dir <path>", "existing signing-key directory")
		.option("-s, --state-dir <path>", "private retained-request directory")
		.option("--prepare", "save a reviewed request for operator admission")
		.option("--resume", "resume the saved request or config-only adoption")
		.option("--capability <token>", "admin-issued capability for this exact start")
		.option("-v, --review-digest <digest>", "explicitly approve the prepared profile review");
	addDbOption(command);
	addConfigOption(command);
	addJsonOption(command);
	command.action(enroll);
	return command;
}
