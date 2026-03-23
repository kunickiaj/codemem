/**
 * Memory management CLI commands — show, forget, remember.
 *
 * Ports codemem/commands/memory_cmds.py (show_cmd, forget_cmd, remember_cmd).
 * Compact and inject are deferred — compact requires the summarizer pipeline,
 * and inject is just pack_text output which the existing pack command covers.
 */

import * as p from "@clack/prompts";
import { MemoryStore, resolveDbPath, resolveProject } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

function collectWorkingSetFile(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** Parse a strict positive integer, rejecting prefixes like "12abc". */
function parseStrictPositiveId(value: string): number | null {
	if (!/^\d+$/.test(value.trim())) return null;
	const n = Number(value.trim());
	return Number.isFinite(n) && n >= 1 && Number.isInteger(n) ? n : null;
}

function showMemoryAction(idStr: string, opts: { db?: string; dbPath?: string }): void {
	const memoryId = parseStrictPositiveId(idStr);
	if (memoryId === null) {
		p.log.error(`Invalid memory ID: ${idStr}`);
		process.exitCode = 1;
		return;
	}
	const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
	try {
		const item = store.get(memoryId);
		if (!item) {
			p.log.error(`Memory ${memoryId} not found`);
			process.exitCode = 1;
			return;
		}
		console.log(JSON.stringify(item, null, 2));
	} finally {
		store.close();
	}
}

function forgetMemoryAction(idStr: string, opts: { db?: string; dbPath?: string }): void {
	const memoryId = parseStrictPositiveId(idStr);
	if (memoryId === null) {
		p.log.error(`Invalid memory ID: ${idStr}`);
		process.exitCode = 1;
		return;
	}
	const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
	try {
		store.forget(memoryId);
		p.log.success(`Memory ${memoryId} marked inactive`);
	} finally {
		store.close();
	}
}

interface RememberMemoryOptions {
	kind: string;
	title: string;
	body: string;
	tags?: string[];
	project?: string;
	db?: string;
	dbPath?: string;
}

function rememberMemoryAction(opts: RememberMemoryOptions): void {
	const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
	let sessionId: number | null = null;
	try {
		const project = resolveProject(process.cwd(), opts.project ?? null);
		sessionId = store.startSession({
			cwd: process.cwd(),
			project,
			user: process.env.USER ?? "unknown",
			toolVersion: "manual",
			metadata: { manual: true },
		});
		const memId = store.remember(sessionId, opts.kind, opts.title, opts.body, 0.5, opts.tags);
		store.endSession(sessionId, { manual: true });
		p.log.success(`Stored memory ${memId}`);
	} catch (err) {
		if (sessionId !== null) {
			try {
				store.endSession(sessionId, { manual: true, error: true });
			} catch {
				// ignore — already in error path
			}
		}
		throw err;
	} finally {
		store.close();
	}
}

function createShowMemoryCommand(): Command {
	return new Command("show")
		.configureHelp(helpStyle)
		.description("Print a memory item as JSON")
		.argument("<id>", "memory ID")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.action(showMemoryAction);
}

function createForgetMemoryCommand(): Command {
	return new Command("forget")
		.configureHelp(helpStyle)
		.description("Deactivate a memory item")
		.argument("<id>", "memory ID")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.action(forgetMemoryAction);
}

function createRememberMemoryCommand(): Command {
	return new Command("remember")
		.configureHelp(helpStyle)
		.description("Manually add a memory item")
		.requiredOption("-k, --kind <kind>", "memory kind (discovery, decision, feature, bugfix, etc.)")
		.requiredOption("-t, --title <title>", "memory title")
		.requiredOption("-b, --body <body>", "memory body text")
		.option("--tags <tags...>", "tags (space-separated)")
		.option("--project <project>", "project name (defaults to git repo root)")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.action(rememberMemoryAction);
}

function createInjectMemoryCommand(): Command {
	return new Command("inject")
		.configureHelp(helpStyle)
		.description("Build raw memory context text for manual prompt injection")
		.argument("<context>", "context string to search for")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("-n, --limit <n>", "max items", "10")
		.option("--budget <tokens>", "token budget")
		.option("--token-budget <tokens>", "token budget")
		.option(
			"--working-set-file <path>",
			"recently modified file path used as ranking hint",
			collectWorkingSetFile,
			[],
		)
		.option("--project <project>", "project identifier (defaults to git repo root)")
		.option("--all-projects", "search across all projects")
		.allowUnknownOption(true)
		.allowExcessArguments(true)
		.action(
			(
				context: string,
				opts: {
					db?: string;
					dbPath?: string;
					limit?: string;
					budget?: string;
					tokenBudget?: string;
					workingSetFile?: string[];
					project?: string;
					allProjects?: boolean;
				},
			) => {
				const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
				try {
					const limit = Number.parseInt(opts.limit ?? "10", 10) || 10;
					const budgetRaw = opts.tokenBudget ?? opts.budget;
					const budget = budgetRaw ? Number.parseInt(budgetRaw, 10) : undefined;
					const filters: { project?: string; working_set_paths?: string[] } = {};
					if (!opts.allProjects) {
						const defaultProject = process.env.CODEMEM_PROJECT?.trim() || null;
						const project = defaultProject || resolveProject(process.cwd(), opts.project ?? null);
						if (project) filters.project = project;
					}
					if ((opts.workingSetFile?.length ?? 0) > 0) {
						filters.working_set_paths = opts.workingSetFile;
					}
					const pack = store.buildMemoryPack(context, limit, budget, filters);
					console.log(pack.pack_text ?? "");
				} finally {
					store.close();
				}
			},
		);
}

function createCompactMemoryCommand(): Command {
	return new Command("compact")
		.configureHelp(helpStyle)
		.description("Deferred command guidance for memory compaction")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--session-id <id>", "session ID")
		.option("--limit <n>", "max sessions to compact", "10")
		.allowUnknownOption(true)
		.allowExcessArguments(true)
		.action(() => {
			p.log.warn("`codemem memory compact` is not implemented in the TypeScript CLI yet.");
			p.log.info(
				"Current workaround: rely on automatic ingestion; for manual context use `codemem memory inject <context>`.",
			);
			process.exitCode = 2;
		});
}

export const showMemoryCommand = createShowMemoryCommand();
export const forgetMemoryCommand = createForgetMemoryCommand();
export const rememberMemoryCommand = createRememberMemoryCommand();

export const memoryCommand = new Command("memory")
	.configureHelp(helpStyle)
	.description("Memory item management");

memoryCommand.addCommand(createShowMemoryCommand());
memoryCommand.addCommand(createForgetMemoryCommand());
memoryCommand.addCommand(createRememberMemoryCommand());
memoryCommand.addCommand(createInjectMemoryCommand());
memoryCommand.addCommand(createCompactMemoryCommand());
