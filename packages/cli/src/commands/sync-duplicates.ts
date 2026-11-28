import * as p from "@clack/prompts";
import type { AmbiguousCopyRepair } from "@codemem/core";
import {
	listAmbiguousMemoryCopies,
	MemoryStore,
	repairAmbiguousMemory,
	resolveDbPath,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addJsonOption, emitJsonError, resolveDbOpt } from "../shared-options.js";

interface SyncDuplicatesOptions {
	db?: string;
	dbPath?: string;
	json?: boolean;
}

/** Prints the memories this device stores more than one copy of in one scope. */
function runSyncDuplicates(opts: SyncDuplicatesOptions): void {
	let store: MemoryStore | null = null;
	try {
		store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
		const duplicates = listAmbiguousMemoryCopies(store.db);
		if (opts.json) {
			console.log(JSON.stringify({ duplicates, count: duplicates.length }));
			return;
		}
		if (duplicates.length === 0) {
			p.log.success("No memory has more than one copy in a scope.");
			return;
		}
		const lines = duplicates.map(
			(group) =>
				`  ${group.scope_id ?? "(no scope)"}: memories ${group.memory_ids.map((id) => `#${id}`).join(", ") || "(none left)"}`,
		);
		p.log.warn(
			`${duplicates.length} memories were stored more than once in a scope. Sync sends and applies none of their copies until all but one are removed and \`codemem sync duplicates repair <memory-id>\` confirms the one left:\n${lines.join("\n")}`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Listing duplicate copies failed";
		if (opts.json) {
			emitJsonError("duplicates_failed", message);
			return;
		}
		p.log.error(message);
		process.exitCode = 1;
	} finally {
		store?.close();
	}
}

const REPAIR_MESSAGES: Record<Exclude<AmbiguousCopyRepair["status"], "repaired">, string> = {
	not_found: "No memory has that ID.",
	not_ambiguous: "That memory is not withheld as a duplicate.",
	copies_remain: "More than one copy is still stored in its scope. Remove the extra copies first.",
};

/** Confirms that a memory is the only copy left in its scope, so sync serves it again. */
function runSyncDuplicatesRepair(memoryId: string, opts: SyncDuplicatesOptions): void {
	let store: MemoryStore | null = null;
	try {
		store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
		const outcome = repairAmbiguousMemory(store.db, Number.parseInt(memoryId, 10), {
			localDeviceId: store.deviceId,
			scanner: store.scanner,
		});
		if (opts.json) {
			console.log(JSON.stringify(outcome));
			if (outcome.status !== "repaired") process.exitCode = 1;
			return;
		}
		if (outcome.status === "repaired") {
			p.log.success(
				`Memory #${memoryId} is the only copy left. Sync sends and applies it again, and the changes held for it were applied.`,
			);
			return;
		}
		p.log.error(REPAIR_MESSAGES[outcome.status]);
		process.exitCode = 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Repairing duplicate copies failed";
		if (opts.json) {
			emitJsonError("duplicates_repair_failed", message);
			return;
		}
		p.log.error(message);
		process.exitCode = 1;
	} finally {
		store?.close();
	}
}

export function buildSyncDuplicatesCommand(): Command {
	// Options after `repair` belong to `repair`, so its --db and --json are its own.
	const cmd = new Command("duplicates")
		.enablePositionalOptions()
		.configureHelp(helpStyle)
		.description("List memories stored more than once in a scope, which sync withholds");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action((opts: SyncDuplicatesOptions) => runSyncDuplicates(opts));
	const repair = new Command("repair")
		.configureHelp(helpStyle)
		.description("Confirm a memory is the only copy left in its scope, so sync serves it again")
		.argument("<memory-id>", "ID of the copy that remains");
	addDbOption(repair);
	addJsonOption(repair);
	repair.action((memoryId: string, opts: SyncDuplicatesOptions) =>
		runSyncDuplicatesRepair(memoryId, opts),
	);
	cmd.addCommand(repair);
	return cmd;
}
