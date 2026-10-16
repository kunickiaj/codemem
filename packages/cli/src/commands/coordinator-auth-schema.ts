import * as p from "@clack/prompts";
import { AUTH_LINK_AUTHORITY_CUTOVER_SQL, upgradeCoordinatorAuthSchemaFile } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addJsonOption, emitJsonError, resolveDbOpt } from "../shared-options.js";

interface Options {
	dbPath?: string;
	db?: string;
	json?: boolean;
	exportSql?: boolean;
}
function failure(options: Options, message: string, exitCode: number): void {
	if (options.json) {
		emitJsonError(exitCode === 2 ? "usage_error" : "auth_schema_upgrade_failed", message, exitCode);
		return;
	}
	p.log.error(`Coordinator auth upgrade stopped: ${message}`);
	process.exitCode = exitCode;
}
function upgrade(options: Options): void {
	const path = resolveDbOpt(options);
	if (options.exportSql && path) {
		failure(options, "Use --export-sql without --db-path; export opens no database.", 2);
		return;
	}
	if (!options.exportSql && !path) {
		failure(
			options,
			"Select an existing coordinator database with --db-path. Pause auth writers, drain attempts and back up the database first.",
			2,
		);
		return;
	}
	try {
		if (options.exportSql) {
			const sql = `${AUTH_LINK_AUTHORITY_CUTOVER_SQL}\n`;
			process.stdout.write(options.json ? `${JSON.stringify({ sql, applied: false })}\n` : sql);
			return;
		}
		if (!path) return;
		upgradeCoordinatorAuthSchemaFile(path);
		process.stdout.write(
			options.json
				? `${JSON.stringify({ upgraded: true })}\n`
				: "Coordinator authentication schema upgraded.\n",
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message : "Coordinator auth upgrade failed.";
		failure(
			options,
			`Upgrade aborted without committing changes. Check that attempts are drained and the legacy schema and provenance match the reviewed source. ${detail}`,
			1,
		);
	}
}

export function buildCoordinatorAuthSchemaCommand(): Command {
	const command = new Command("upgrade-auth-schema")
		.configureHelp(helpStyle)
		.description("Upgrade local coordinator auth or export reviewed D1 SQL")
		.option("-e, --export-sql", "print D1 cutover SQL without opening a database");
	addDbOption(command);
	addJsonOption(command);
	command.action(upgrade);
	return command;
}
