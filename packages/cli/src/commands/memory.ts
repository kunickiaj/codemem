/**
 * Memory management CLI commands — show, forget, remember, inject.
 *
 * Ports codemem/commands/memory_cmds.py (show_cmd, forget_cmd, remember_cmd).
 * Inject is deprecated in favor of `codemem pack`.
 */

import * as p from "@clack/prompts";
import { MemoryStore, resolveDbPath, resolveProject } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	emitDeprecationWarning,
	emitJsonError,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";

function collectWorkingSetFile(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** Parse a strict positive integer, rejecting prefixes like "12abc". */
function parseStrictPositiveId(value: string): number | null {
	if (!/^\d+$/.test(value.trim())) return null;
	const n = Number(value.trim());
	return Number.isFinite(n) && n >= 1 && Number.isInteger(n) ? n : null;
}

function showMemoryAction(idStr: string, opts: DbOpts & JsonOpts): void {
	const memoryId = parseStrictPositiveId(idStr);
	if (memoryId === null) {
		if (opts.json) {
			emitJsonError("invalid_id", `Invalid memory ID: ${idStr}`);
		} else {
			p.log.error(`Invalid memory ID: ${idStr}`);
			process.exitCode = 1;
		}
		return;
	}
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		const item = store.get(memoryId);
		if (!item) {
			if (opts.json) {
				emitJsonError("not_found", `Memory ${memoryId} not found`);
			} else {
				p.log.error(`Memory ${memoryId} not found`);
				process.exitCode = 1;
			}
			return;
		}
		if (opts.json) {
			console.log(JSON.stringify(item, null, 2));
		} else {
			// Human-readable format
			console.log(`#${item.id} [${item.kind}] ${item.title}`);
			if (item.subtitle) console.log(`  ${item.subtitle}`);
			console.log(`  created: ${item.created_at}  confidence: ${item.confidence}`);
			if (item.tags_text) console.log(`  tags: ${item.tags_text}`);
			if (item.body_text) {
				const preview =
					item.body_text.length > 300 ? `${item.body_text.slice(0, 300)}…` : item.body_text;
				console.log(`\n${preview}`);
			}
		}
	} finally {
		store.close();
	}
}

function forgetMemoryAction(idStr: string, opts: DbOpts & JsonOpts): void {
	const memoryId = parseStrictPositiveId(idStr);
	if (memoryId === null) {
		if (opts.json) {
			emitJsonError("invalid_id", `Invalid memory ID: ${idStr}`);
		} else {
			p.log.error(`Invalid memory ID: ${idStr}`);
			process.exitCode = 1;
		}
		return;
	}
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		store.forget(memoryId);
		if (opts.json) {
			console.log(JSON.stringify({ id: memoryId, status: "forgotten" }));
		} else {
			p.log.success(`Memory ${memoryId} marked inactive`);
		}
	} finally {
		store.close();
	}
}

interface RememberMemoryOptions extends DbOpts, JsonOpts {
	kind: string;
	title: string;
	body: string;
	tags?: string[];
	project?: string;
}

async function rememberMemoryAction(opts: RememberMemoryOptions): Promise<void> {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
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
		await store.flushPendingVectorWrites();
		store.endSession(sessionId, { manual: true });
		if (opts.json) {
			console.log(JSON.stringify({ id: memId }));
		} else {
			p.log.success(`Stored memory ${memId}`);
		}
	} catch (err) {
		if (sessionId !== null) {
			try {
				store.endSession(sessionId, { manual: true, error: true });
			} catch {
				// ignore — already in error path
			}
		}
		const message = err instanceof Error ? err.message : String(err);
		if (opts.json) {
			emitJsonError("remember_failed", message);
		} else {
			p.log.error(`Failed to store memory: ${message}`);
			process.exitCode = 1;
		}
	} finally {
		store.close();
	}
}

function createShowMemoryCommand(): Command {
	const cmd = new Command("show")
		.configureHelp(helpStyle)
		.description("Show a memory item")
		.argument("<id>", "memory ID");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(showMemoryAction);
	return cmd;
}

function createForgetMemoryCommand(): Command {
	const cmd = new Command("forget")
		.configureHelp(helpStyle)
		.description("Deactivate a memory item")
		.argument("<id>", "memory ID");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(forgetMemoryAction);
	return cmd;
}

function createRememberMemoryCommand(): Command {
	const cmd = new Command("remember")
		.configureHelp(helpStyle)
		.description("Manually add a memory item")
		.requiredOption("-k, --kind <kind>", "memory kind (discovery, decision, feature, bugfix, etc.)")
		.requiredOption("-t, --title <title>", "memory title")
		.requiredOption("-b, --body <body>", "memory body text")
		.option("--tags <tags...>", "tags (space-separated)")
		.option("--project <project>", "project name (defaults to git repo root)");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(rememberMemoryAction);
	return cmd;
}

function createInjectMemoryCommand(): Command {
	const cmd = new Command("inject")
		.configureHelp(helpStyle)
		.description("Build raw memory context text for manual prompt injection")
		.argument("<context>", "context string to search for")
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
		.allowExcessArguments(true);
	addDbOption(cmd);
	cmd.action(
		async (
			context: string,
			opts: DbOpts & {
				limit?: string;
				budget?: string;
				tokenBudget?: string;
				workingSetFile?: string[];
				project?: string;
				allProjects?: boolean;
			},
		) => {
			emitDeprecationWarning("codemem memory inject", "codemem pack");
			const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
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
				const pack = await store.buildMemoryPackAsync(context, limit, budget, filters);
				console.log(pack.pack_text ?? "");
			} finally {
				store.close();
			}
		},
	);
	return cmd;
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
