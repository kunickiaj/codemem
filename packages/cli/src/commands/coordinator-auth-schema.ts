import * as p from "@clack/prompts";
import {
	ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
	ACCOUNT_UNLINK_MIGRATION_STATEMENTS,
	AUTH_LINK_AUTHORITY_CUTOVER_SQL,
	LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS,
	upgradeCoordinatorAccountSchemaFile,
	upgradeCoordinatorAuthSchemaFile,
	upgradeCoordinatorOwnerResolutionSchemaFile,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addJsonOption, emitJsonError, resolveDbOpt } from "../shared-options.js";

interface Options {
	dbPath?: string;
	db?: string;
	json?: boolean;
	exportSql?: boolean;
	deviceUnlink?: boolean;
	ownerResolution?: boolean;
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
	let statements: readonly string[] = options.deviceUnlink
		? ACCOUNT_UNLINK_MIGRATION_STATEMENTS
		: ACCOUNT_CONNECTION_MIGRATION_STATEMENTS;
	let prerequisites = accountPrerequisites;
	if (options.ownerResolution) {
		statements = LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS;
		prerequisites +=
			" Requires the current account-management schema first; installs inert receipt storage only, not ownership or access.";
	}
	const text = `-- ${prerequisites}\n-- Execute in ONE atomic D1 batch; do not split into autocommitted requests. Nothing has been applied.\n${statements.map((s) => `${s.trim().replace(/;$/u, "")};`).join("\n")}\n`;
	process.stdout.write(options.json ? `${JSON.stringify({ statements, applied: false })}\n` : text);
}
function invalidAccountSelection(options: Options, path: string | undefined): boolean {
	if (options.exportSql) return hasDatabaseSelection(options);
	if (!path) return true;
	return Boolean(options.ownerResolution && !hasDatabaseSelection(options));
}
async function upgradeAccount(options: Options): Promise<void> {
	if (options.ownerResolution && options.deviceUnlink) {
		failure(
			options,
			"Use --owner-resolution without --device-unlink.",
			2,
			"account_schema_upgrade_failed",
		);
		return;
	}
	if (options.deviceUnlink && !options.exportSql) {
		failure(
			options,
			"Use --device-unlink only with --export-sql; local upgrades detect the installed schema.",
			2,
			"account_schema_upgrade_failed",
		);
		return;
	}
	const path = resolveDbOpt(options);
	if (invalidAccountSelection(options, path)) {
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
		if (options.ownerResolution) await upgradeCoordinatorOwnerResolutionSchemaFile(path);
		else await upgradeCoordinatorAccountSchemaFile(path);
		process.stdout.write(
			options.json ? `${JSON.stringify({ upgraded: true })}\n` : accountUpgradeSuccess(options),
		);
	} catch (error) {
		const detail = accountUpgradeFailure(options, error);
		failure(
			options,
			`Account schema upgrade stopped. Inspect the selected database before retrying. ${detail}`,
			1,
			"account_schema_upgrade_failed",
		);
	}
}
function accountUpgradeSuccess(options: Options): string {
	if (options.ownerResolution)
		return "Coordinator owner-resolution receipt storage ready; ownership and access unchanged.\n";
	return "Coordinator account schema upgraded.\n";
}
function accountUpgradeFailure(options: Options, error: unknown): string {
	if (options.ownerResolution)
		return "Owner-resolution storage requires the current account schema: first use upgrade-account-schema without --owner-resolution. Partial, unsupported or colliding receipt schemas cannot be repaired by this command. Check file access and writer locks.";
	return error instanceof Error ? error.message : "Coordinator account schema upgrade failed.";
}
export function buildCoordinatorAccountSchemaCommand(): Command {
	const command = new Command("upgrade-account-schema")
		.configureHelp(helpStyle)
		.description(
			"Explicitly install optional coordinator account management on an existing V2 database",
		)
		.option(
			"-o, --owner-resolution",
			"install inert owner-resolution receipt storage (requires current account schema)",
		)
		.option(
			"--device-unlink",
			"export only the delta for the prior account-management schema (requires --export-sql)",
		)
		.option(
			"-e, --export-sql",
			"export statement boundaries for one atomic D1 batch without opening a database",
		)
		.addHelpText(
			"after",
			`\n${accountPrerequisites}\n--owner-resolution installs storage only; it does not resolve an owner or change access. It requires the current account schema and an explicit --db-path, or --export-sql without a database. It cannot be combined with --device-unlink.\nD1 export does not apply SQL or verify remote execution limits.\n`,
		);
	addDbOption(command);
	addJsonOption(command);
	command.action(upgradeAccount);
	return command;
}
