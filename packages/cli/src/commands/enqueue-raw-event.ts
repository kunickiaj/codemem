import {
	ingestRawEvents,
	MemoryStore,
	RawEventIngestValidationError,
	resolveDbPath,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, type DbOpts, resolveDbOpt } from "../shared-options.js";

async function readStdinJson(): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	const raw = Buffer.concat(chunks).toString("utf-8").trim();
	if (!raw) throw new Error("stdin JSON required");
	const parsed = JSON.parse(raw) as unknown;
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("payload must be an object");
	}
	return parsed as Record<string, unknown>;
}

function emitStructuredError(errorCode: string, message: string): void {
	console.log(JSON.stringify({ error: errorCode, message }));
	process.exitCode = 1;
}

interface EnqueueRawEventDependencies {
	readPayload?: () => Promise<Record<string, unknown>>;
}

export async function runEnqueueRawEvent(
	opts: DbOpts,
	dependencies: EnqueueRawEventDependencies = {},
): Promise<void> {
	try {
		const payload = await (dependencies.readPayload ?? readStdinJson)();
		const dbPath = resolveDbPath(resolveDbOpt(opts));
		const store = new MemoryStore(dbPath);
		try {
			ingestRawEvents(store, payload);
		} finally {
			store.close();
		}
	} catch (err) {
		emitStructuredError(
			err instanceof RawEventIngestValidationError ? "validation_error" : "enqueue_error",
			err instanceof Error ? err.message : String(err),
		);
	}
}

const enqueueCmd = new Command("enqueue-raw-event")
	.configureHelp(helpStyle)
	.description("Enqueue one raw event from stdin into the durable queue");

addDbOption(enqueueCmd);

export const enqueueRawEventCommand = enqueueCmd.action((opts: DbOpts) => runEnqueueRawEvent(opts));
