import * as p from "@clack/prompts";
import type { ExportPayload } from "@codemem/core";
import { importMemories, readImportPayload, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	emitJsonError,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";

const cmd = new Command("import-memories")
	.configureHelp(helpStyle)
	.description("Import memories from an exported JSON file")
	.argument("<inputFile>", "input JSON file (use '-' for stdin)")
	.option("--remap-project <path>", "remap all projects to this path on import")
	.option("--dry-run", "preview import without writing");

addDbOption(cmd);
addJsonOption(cmd);

cmd.action(
	(
		inputFile: string,
		opts: DbOpts &
			JsonOpts & {
				remapProject?: string;
				dryRun?: boolean;
			},
	) => {
		let payload: ExportPayload;
		try {
			payload = readImportPayload(inputFile);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Invalid import file";
			if (opts.json) {
				emitJsonError("invalid_input", message);
			} else {
				p.log.error(message);
				process.exitCode = 1;
			}
			return;
		}

		if (!opts.json) {
			p.intro("codemem import-memories");
			p.log.info(
				[
					`Export version: ${payload.version}`,
					`Exported at:    ${payload.exported_at}`,
					`Sessions:       ${payload.sessions.length.toLocaleString()}`,
					`Memories:       ${payload.memory_items.length.toLocaleString()}`,
					`Summaries:      ${payload.session_summaries.length.toLocaleString()}`,
					`Prompts:        ${payload.user_prompts.length.toLocaleString()}`,
				].join("\n"),
			);
		}

		let result: ReturnType<typeof importMemories>;
		try {
			result = importMemories(payload, {
				dbPath: resolveDbPath(resolveDbOpt(opts)),
				remapProject: opts.remapProject,
				dryRun: opts.dryRun,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Import failed";
			if (opts.json) {
				emitJsonError("import_failed", message);
			} else {
				p.log.error(message);
				process.exitCode = 1;
			}
			return;
		}

		if (opts.json) {
			console.log(
				JSON.stringify({
					sessions: result.sessions,
					memory_items: result.memory_items,
					skipped: result.dryRun,
				}),
			);
			return;
		}

		if (result.dryRun) {
			p.outro("dry run complete");
			return;
		}
		p.log.success(
			[
				`Imported sessions:  ${result.sessions.toLocaleString()}`,
				`Imported prompts:   ${result.user_prompts.toLocaleString()}`,
				`Imported memories:  ${result.memory_items.toLocaleString()}`,
				`Imported summaries: ${result.session_summaries.toLocaleString()}`,
			].join("\n"),
		);
		p.outro("done");
	},
);

export const importMemoriesCommand = cmd;
