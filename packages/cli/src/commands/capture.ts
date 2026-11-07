import { Command } from "commander";
import {
	inspectRejectedRawEventSpoolEntry,
	listRejectedRawEventSpoolEntries,
	RawEventSpoolInspectionError,
	type RejectedRawEventMetadata,
} from "../../../opencode-plugin/.opencode/lib/raw-event-spool.js";
import { helpStyle } from "../help-style.js";
import { addJsonOption, type JsonOpts } from "../shared-options.js";

// Keep the on-disk format explicit so native capture can add its own reader later.
const rejectedEventFormat = {
	name: "opencode-raw-event-v1",
	list: () => listRejectedRawEventSpoolEntries({ validation: "metadata" }),
	inspect: (receipt: string) => inspectRejectedRawEventSpoolEntry({ receipt }),
} as const;

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
	process.exitCode = code === "invalid_receipt" ? 2 : 1;
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

export async function runListRejected(opts: JsonOpts): Promise<void> {
	try {
		const entries = await rejectedEventFormat.list();
		if (opts.json) {
			process.stdout.write(`${safeJson({ format: rejectedEventFormat.name, entries })}\n`);
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
	opts: JsonOpts & { raw?: boolean },
): Promise<void> {
	try {
		const entry = await rejectedEventFormat.inspect(receipt);
		// Never pass the helper's serialized content into default output.
		const { receipt: name, bytes, status, reason, validation } = entry;
		const result = {
			format: rejectedEventFormat.name,
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

export const captureCommand = new Command("capture")
	.configureHelp(helpStyle)
	.description("Inspect retained capture events");

const listRejectedCommand = new Command("list-rejected")
	.configureHelp(helpStyle)
	.description("List retained OpenCode rejections without reading payloads");
addJsonOption(listRejectedCommand);
listRejectedCommand.action(runListRejected);

const showRejectedCommand = new Command("show-rejected")
	.configureHelp(helpStyle)
	.description("Inspect one retained OpenCode rejection without modifying it")
	.argument("<receipt>", "receipt from list-rejected")
	.option("-r, --raw", "include private text as a JSON string (always output JSON)")
	.addHelpText(
		"after",
		"\n--raw also emits errors as JSON. If the file changes, retry inspection.\nFiles remain untouched.",
	);
addJsonOption(showRejectedCommand);
showRejectedCommand.action(runShowRejected);

captureCommand.addCommand(listRejectedCommand).addCommand(showRejectedCommand);
