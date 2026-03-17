import * as p from "@clack/prompts";
import type { ExportPayload } from "@codemem/core";
import { importMemories, readImportPayload, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const importMemoriesCommand = new Command("import-memories")
	.configureHelp(helpStyle)
	.description("Import memories from an exported JSON file")
	.argument("<inputFile>", "input JSON file (use '-' for stdin)")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--remap-project <path>", "remap all projects to this path on import")
	.option("--dry-run", "preview import without writing")
	.action((inputFile: string, opts: { db?: string; remapProject?: string; dryRun?: boolean }) => {
		let payload: ExportPayload;
		try {
			payload = readImportPayload(inputFile);
		} catch (error) {
			p.log.error(error instanceof Error ? error.message : "Invalid import file");
			process.exitCode = 1;
			return;
		}

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

		const result = importMemories(payload, {
			dbPath: resolveDbPath(opts.db),
			remapProject: opts.remapProject,
			dryRun: opts.dryRun,
		});

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
	});
