import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { exportMemories, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, type DbOpts, resolveDbOpt } from "../shared-options.js";

function expandUserPath(value: string): string {
	return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

const cmd = new Command("export-memories")
	.configureHelp(helpStyle)
	.description("Export memories to a JSON file for sharing or backup")
	.argument("<output>", "output file path (use '-' for stdout)")
	.option("--project <project>", "filter by project (defaults to git repo root)")
	.option("--all-projects", "export all projects")
	.option("--include-inactive", "include deactivated memories")
	.option("--since <iso>", "only export memories created after this ISO timestamp");

addDbOption(cmd);

cmd.action(
	(
		output: string,
		opts: DbOpts & {
			project?: string;
			allProjects?: boolean;
			includeInactive?: boolean;
			since?: string;
		},
	) => {
		const payload = exportMemories({
			dbPath: resolveDbPath(resolveDbOpt(opts)),
			project: opts.project,
			allProjects: opts.allProjects,
			includeInactive: opts.includeInactive,
			since: opts.since,
		});
		const text = `${JSON.stringify(payload, null, 2)}\n`;
		if (output === "-") {
			process.stdout.write(text);
			return;
		}
		const outputPath = expandUserPath(output);
		writeFileSync(outputPath, text, "utf8");
		p.intro("codemem export-memories");
		p.log.success(
			[
				`Output:    ${outputPath}`,
				`Sessions:  ${payload.sessions.length.toLocaleString()}`,
				`Memories:  ${payload.memory_items.length.toLocaleString()}`,
				`Summaries: ${payload.session_summaries.length.toLocaleString()}`,
				`Prompts:   ${payload.user_prompts.length.toLocaleString()}`,
			].join("\n"),
		);
		p.outro("done");
	},
);

export const exportMemoriesCommand = cmd;
