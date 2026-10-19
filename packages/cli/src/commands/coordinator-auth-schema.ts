import * as p from "@clack/prompts";
import {
	ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
	AUTH_LINK_AUTHORITY_CUTOVER_SQL,
	upgradeCoordinatorAccountSchemaFile,
	upgradeCoordinatorAuthSchemaFile,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addJsonOption, emitJsonError, resolveDbOpt } from "../shared-options.js";

interface Options {
	dbPath?: string;
	db?: string;
	json?: boolean;
	exportSql?: boolean;
}
function failure(
	options: Options,
	message: string,
	exitCode: number,
	errorCode = "auth_schema_upgrade_failed",
): void {
	if (options.json) {
		emitJsonError(exitCode === 2 ? "usage_error" : errorCode, message, exitCode);
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

const accountPrerequisites =
	"Pause auth writers, drain pending attempts and back up the selected coordinator database first. This command does not pause writers or create a backup.";
function hasDatabaseSelection(options: Options): boolean {
	return options.dbPath !== undefined || options.db !== undefined;
}
function exportAccountSchema(options: Options): void {
	const statements = ACCOUNT_CONNECTION_MIGRATION_STATEMENTS;
	const text = `-- ${accountPrerequisites}\n-- Execute in ONE atomic D1 batch; do not split into autocommitted requests. Nothing has been applied.\n${statements.map((s) => `${s.trim().replace(/;$/u, "")};`).join("\n")}\n`;
	process.stdout.write(options.json ? `${JSON.stringify({ statements, applied: false })}\n` : text);
}
async function upgradeAccount(options: Options): Promise<void> {
	const path = resolveDbOpt(options);
	const selected = hasDatabaseSelection(options);
	if ((options.exportSql && selected) || (!options.exportSql && !path)) {
		failure(
			options,
			options.exportSql
				? "Use --export-sql without --db-path; export opens no database."
				: `Select an existing coordinator database with --db-path. ${accountPrerequisites}`,
			2,
			"account_schema_upgrade_failed",
		);
		return;
	}
	try {
		if (options.exportSql) {
			exportAccountSchema(options);
			return;
		}
		if (!path) return;
		if (!options.json) process.stderr.write(`${accountPrerequisites}\n`);
		await upgradeCoordinatorAccountSchemaFile(path);
		process.stdout.write(
			options.json
				? `${JSON.stringify({ upgraded: true })}\n`
				: "Coordinator account schema upgraded.\n",
		);
	} catch (error) {
		const detail =
			error instanceof Error ? error.message : "Coordinator account schema upgrade failed.";
		failure(
			options,
			`Account schema upgrade stopped. Inspect the selected database before retrying. ${detail}`,
			1,
			"account_schema_upgrade_failed",
		);
	}
}
export function buildCoordinatorAccountSchemaCommand(): Command {
	const command = new Command("upgrade-account-schema")
		.configureHelp(helpStyle)
		.description(
			"Explicitly install optional coordinator account management on an existing V2 database",
		)
		.option(
			"-e, --export-sql",
			"export statement boundaries for one atomic D1 batch without opening a database",
		)
		.addHelpText(
			"after",
			`\n${accountPrerequisites}\nD1 export does not apply SQL or verify remote execution limits.\n`,
		);
	addDbOption(command);
	addJsonOption(command);
	command.action(upgradeAccount);
	return command;
}
