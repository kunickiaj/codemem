import * as p from "@clack/prompts";
import {
	connectReadOnly,
	getCodememConfigPath,
	readCodememConfigFileForMutation,
	readLocalProjectMigrationReport,
	resolveDbPath,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	type ConfigOpts,
	type DbOpts,
	emitJsonError,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";

function reportText(report: ReturnType<typeof readLocalProjectMigrationReport>): string {
	switch (report.state) {
		case "off":
			return "Project migration reporting is off.";
		case "not_applicable":
			return "This device uses basic peer sync. No Project migration is needed.";
		case "waiting_for_coordinator":
			return "Coordinator settings are missing. Existing sharing stays in effect.";
		case "local_report": {
			const counts = report.projects;
			const observed = counts
				? `Project candidates: ${counts.candidate_projects}. Projects in multiple setups: ${counts.multiple_sources}. Locally authored rows in those setups: ${counts.own_source_rows}.`
				: "The local Project inventory is unavailable.";
			return `${observed}\nLocal filter evidence: ${report.local_filters}. Other devices have not been checked.\n${report.maintenance_window}`;
		}
	}
}

function migrationStatus(opts: DbOpts & ConfigOpts & JsonOpts) {
	try {
		// The normal config reader treats damaged files as empty, which could
		// misidentify a coordinator-managed store as a basic peer install.
		const config = readCodememConfigFileForMutation(opts.config ?? getCodememConfigPath());
		if (
			config.status !== "valid" &&
			(config.status !== "missing" || opts.config || process.env.CODEMEM_CONFIG)
		) {
			throw new Error("migration_config_unavailable");
		}
		const db = connectReadOnly(resolveDbPath(resolveDbOpt(opts)));
		try {
			const report = readLocalProjectMigrationReport(
				db,
				config.status === "valid" ? config.data : {},
			);
			if (opts.json) process.stdout.write(`${JSON.stringify(report)}\n`);
			else p.log.info(reportText(report));
		} finally {
			db.close();
		}
	} catch {
		const message =
			"Could not read the migration report. Check the database and configuration paths.";
		if (opts.json) emitJsonError("migration_report_unavailable", message);
		else {
			p.log.error(message);
			process.exitCode = 1;
		}
	}
}

export function buildSyncMigrationCommand(): Command {
	const status = new Command("status")
		.configureHelp(helpStyle)
		.description("Report local Project sharing data without changing access");
	addDbOption(status);
	addConfigOption(status);
	addJsonOption(status);
	status.action(migrationStatus);
	return new Command("migration")
		.configureHelp(helpStyle)
		.description("Inspect the Project sharing migration")
		.addCommand(status);
}
