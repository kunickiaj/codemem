import { coordinatorAuthStageBaselineSql, coordinatorD1BaselineMigrations } from "@codemem/core";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import { addJsonOption } from "../shared-options.js";

const STAGES = ["v2", "prior_extension", "current"] as const;
type Stage = (typeof STAGES)[number];

interface Options {
	stage: Stage;
	json?: boolean;
}

function exportBaseline(options: Options): void {
	const statement = coordinatorAuthStageBaselineSql(options.stage);
	const migrations = coordinatorD1BaselineMigrations(options.stage);
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ statement, migrations, applied: false })}\n`);
		return;
	}
	process.stdout.write(
		`-- Records ${migrations.length} migrations, ${migrations[0]} through ${migrations.at(-1)}, in the existing d1_migrations ledger\n-- only if auth-stage ${options.stage} readiness and the remaining table and column names match.\n-- The inventory does not check types, constraints, indexes, triggers or row validity. Compare the schema before applying.\n-- Otherwise it records nothing or fails to compile. "no such table: d1_migrations" means the ledger must be created first.\n-- Nothing has been applied.\n${statement};\n`,
	);
}

export function buildCoordinatorD1BaselineCommand(): Command {
	const command = new Command("baseline-d1")
		.configureHelp(helpStyle)
		.description("Export the guarded D1 ledger baseline for auth migrations already present")
		.addOption(
			new Option("--stage <stage>", "auth schema stage the D1 database is already at")
				.choices(STAGES)
				.makeOptionMandatory(),
		)
		.addHelpText(
			"after",
			"\nFor a D1 database whose schema came from outside the numbered migrations, such as schema.sql or an\nexported auth install. Back up and compare the schema before creating the ledger (wrangler d1 migrations list).\nThen run the statement with wrangler d1 execute and apply the rest with wrangler d1 migrations apply.\nThe statement checks auth-stage readiness and remaining table and column names. The inventory does not\ncheck types, constraints, indexes, triggers or row validity. This command opens no database.\n",
		);
	addJsonOption(command);
	command.action((options: Options) => exportBaseline(options));
	return command;
}
