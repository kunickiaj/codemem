import { Command } from "commander";
import {
	inspectRejectedRawEventSpoolEntry,
	listRejectedRawEventSpoolEntries,
	RawEventSpoolInspectionError,
	type RejectedRawEventMetadata,
} from "../../../opencode-plugin/.opencode/lib/raw-event-spool.js";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";
import { retryNativeHookReceipt } from "./capture-native-retry.js";
import { retryRejectedEvent } from "./capture-retry.js";
import {
	createCaptureCheckCommand,
	createCaptureRetryCommand,
	createCaptureStatusCommand,
} from "./db.js";
import {
	inspectNativeHookRejectedReceipt,
	listNativeHookRejectedReceipts,
	type NativeHookProvider,
} from "./native-hook-retained-spool.js";

const rejectedEventFormat = {
	name: "opencode-raw-event-v1",
	list: () => listRejectedRawEventSpoolEntries({ validation: "metadata" }),
	inspect: (receipt: string) => inspectRejectedRawEventSpoolEntry({ receipt }),
} as const;

type InspectionOpts = JsonOpts & { format?: string; provider?: string };
const formatUsageMessage =
	"Use --format native-hook-v1 with --provider claude, codex, or pi. OpenCode format does not accept --provider.";
function selectInspectionFormat(opts: InspectionOpts) {
	const format = opts.format ?? rejectedEventFormat.name;
	if (format === rejectedEventFormat.name && opts.provider === undefined)
		return rejectedEventFormat;
	if (format !== "native-hook-v1" || !["claude", "codex", "pi"].includes(opts.provider ?? "")) {
		throw new RawEventSpoolInspectionError("usage_error", formatUsageMessage);
	}
	const provider = opts.provider as NativeHookProvider;
	return {
		name: "native-hook-v1",
		provider,
		list: () => listNativeHookRejectedReceipts({ provider }),
		inspect: (receipt: string) => inspectNativeHookRejectedReceipt({ provider, receipt }),
	};
}

function safeJson(value: unknown): string {
	return JSON.stringify(value).replace(
		/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function reportInspectionError(error: unknown, opts: JsonOpts): void {
	let code = "inspection_failed";
	let message = "Could not inspect retained events. Files were left untouched.";
	if (error instanceof RawEventSpoolInspectionError) {
		code = error.code;
		message = error.message;
	}
	process.exitCode = code === "invalid_receipt" || code === "usage_error" ? 2 : 1;
	if (opts.json) {
		process.stdout.write(`${safeJson({ error: code, message })}\n`);
		return;
	}
	process.stderr.write(`${message}\n`);
}

function printRejectedMetadata(entry: RejectedRawEventMetadata & { validation: string }): void {
	process.stdout.write(
		`${entry.receipt}\t${entry.bytes} bytes\t${entry.status} ${entry.reason}\t${entry.validation}\n`,
	);
}

function rawUnavailableMessage(validation: string): string {
	if (validation === "read_limit_exceeded") {
		return "Raw event text exceeds the 16 MiB inspection limit. The file was left untouched.";
	}
	if (validation === "changed_during_read") {
		return "The file changed while reading. Retry inspection. The file was left untouched.";
	}
	return "Raw event text failed validation. The file was left untouched.";
}

export async function runListRejected(opts: InspectionOpts): Promise<void> {
	try {
		const selected = selectInspectionFormat(opts);
		const entries = await selected.list();
		if (opts.json) {
			const provider = "provider" in selected ? { provider: selected.provider } : {};
			process.stdout.write(`${safeJson({ format: selected.name, ...provider, entries })}\n`);
			return;
		}
		if (!entries.length) {
			process.stdout.write("No retained rejected events.\n");
			return;
		}
		for (const entry of entries) {
			printRejectedMetadata(entry);
		}
	} catch (error) {
		reportInspectionError(error, opts);
	}
}

export async function runShowRejected(
	receipt: string,
	opts: InspectionOpts & { raw?: boolean },
): Promise<void> {
	try {
		const selected = selectInspectionFormat(opts);
		const entry = await selected.inspect(receipt);
		// Never pass the helper's serialized content into default output.
		const { receipt: name, bytes, status, reason, validation } = entry;
		const result = {
			format: selected.name,
			...("provider" in selected ? { provider: selected.provider } : {}),
			receipt: name,
			bytes,
			status,
			reason,
			validation,
		};
		if (opts.raw && entry.validation === "valid") {
			process.stdout.write(`${safeJson({ ...result, raw: entry.serialized })}\n`);
			return;
		}
		if (opts.raw) {
			const message = rawUnavailableMessage(entry.validation);
			process.stdout.write(`${safeJson({ ...result, error: "raw_unavailable", message })}\n`);
			process.exitCode = 1;
			return;
		}
		if (opts.json) {
			process.stdout.write(`${safeJson(result)}\n`);
			return;
		}
		printRejectedMetadata(result);
	} catch (error) {
		reportInspectionError(error, { json: opts.json || opts.raw });
	}
}

function addInspectionOptions(command: Command): void {
	command
		.option("--format <format>", "opencode-raw-event-v1 or native-hook-v1", "opencode-raw-event-v1")
		.option("--provider <provider>", "native format only: claude, codex, or pi");
}

function reportRecoveryError(error: unknown, opts: JsonOpts): void {
	const usageError = error instanceof RawEventSpoolInspectionError && error.code === "usage_error";
	const result = {
		ok: false,
		error: usageError ? "usage_error" : "retry_failed",
		message: usageError
			? formatUsageMessage
			: "Retry could not finish. Inspect the retained receipt before retrying.",
		exitCode: usageError ? 2 : 1,
	};
	process.exitCode = result.exitCode;
	if (opts.json) {
		process.stdout.write(`${safeJson(result)}\n`);
		return;
	}
	process.stderr.write(`${result.message}\n`);
}

export async function runRetryRejected(
	receipt: string,
	opts: DbOpts & InspectionOpts & { yes?: boolean; keepReceipt?: boolean },
): Promise<void> {
	try {
		const selected = selectInspectionFormat(opts);
		const retryOpts = {
			dbPath: resolveDbOpt(opts),
			yes: opts.yes,
			keepReceipt: opts.keepReceipt,
		};
		const result =
			"provider" in selected
				? await retryNativeHookReceipt(receipt, { ...retryOpts, provider: selected.provider })
				: await retryRejectedEvent(receipt, retryOpts);
		if (!result.ok) process.exitCode = result.exitCode;
		if (opts.json) {
			process.stdout.write(`${safeJson(result)}\n`);
			return;
		}
		if (!result.ok) {
			process.stderr.write(`${result.message}\n`);
			return;
		}
		if (result.recovery.cleanup === "kept") {
			process.stdout.write(
				"The current viewer acknowledged the event. The retained receipt was kept at your request. Acknowledgement does not verify stored content.\n",
			);
			return;
		}
		process.stdout.write(
			"The current viewer acknowledged the event. The retained receipt was removed.\n",
		);
	} catch (error) {
		reportRecoveryError(error, opts);
	}
}

export function createCaptureDiagnosticsCommand(): Command {
	const captureCommand = new Command("capture")
		.configureHelp(helpStyle)
		.description("Inspect and explicitly retry retained capture events");

	const listRejectedCommand = new Command("list-rejected")
		.configureHelp(helpStyle)
		.description("List retained rejections without reading payloads");
	addInspectionOptions(listRejectedCommand);
	addJsonOption(listRejectedCommand);
	listRejectedCommand.action(runListRejected);

	const showRejectedCommand = new Command("show-rejected")
		.configureHelp(helpStyle)
		.description("Inspect one retained rejection without modifying it")
		.argument("<receipt>", "receipt from list-rejected")
		.option("-r, --raw", "include private text as a JSON string (always output JSON)")
		.addHelpText(
			"after",
			"\n--raw also emits errors as JSON. If the file changes, retry inspection.\nFiles remain untouched.",
		);
	addJsonOption(showRejectedCommand);
	addInspectionOptions(showRejectedCommand);
	showRejectedCommand.action(runShowRejected);

	const retryRejectedCommand = new Command("recover-rejected")
		.configureHelp(helpStyle)
		.description("Retry one retained rejection against the explicit current target")
		.argument("<receipt>", "receipt from list-rejected")
		.option("-y, --yes", "confirm delivery to the current database and runtime identity")
		.option("--keep-receipt", "keep the same receipt after the viewer acknowledges the event")
		.addHelpText(
			"after",
			"\nRequires --db-path and -y. Original target provenance is unknown.\nUses current viewer profile and identity. Never falls back to CLI or SQLite.",
		);
	addDbOption(retryRejectedCommand);
	addJsonOption(retryRejectedCommand);
	addInspectionOptions(retryRejectedCommand);
	retryRejectedCommand.action(runRetryRejected);

	return captureCommand
		.addCommand(listRejectedCommand)
		.addCommand(showRejectedCommand)
		.addCommand(retryRejectedCommand)
		.addCommand(createCaptureStatusCommand())
		.addCommand(createCaptureRetryCommand())
		.addCommand(createCaptureCheckCommand());
}
