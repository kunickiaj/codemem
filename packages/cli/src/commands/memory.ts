/**
 * Memory management CLI commands — show, forget, remember, inject.
 *
 * Ports codemem/commands/memory_cmds.py (show_cmd, forget_cmd, remember_cmd).
 * Inject is deprecated in favor of `codemem pack`.
 */

import * as p from "@clack/prompts";
import { getMemoryRoleReport, MemoryStore, resolveDbPath, resolveProject } from "@codemem/core";
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
import { buildPackRequestOptions, collectWorkingSetFile } from "./pack-shared.js";

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
				const { limit, budget, filters } = buildPackRequestOptions(opts, {
					envProject: process.env.CODEMEM_PROJECT,
				});
				const pack = await store.buildMemoryPackAsync(context, limit, budget, filters);
				console.log(pack.pack_text ?? "");
			} finally {
				store.close();
			}
		},
	);
	return cmd;
}

function createMemoryRoleReportCommand(): Command {
	const cmd = new Command("role-report")
		.configureHelp(helpStyle)
		.description("Analyze inferred memory roles in a DB snapshot")
		.option("--project <project>", "project identifier (defaults to git repo root)")
		.option("--all-projects", "analyze across all projects")
		.option(
			"--probe <query>",
			"run a retrieval probe query against the snapshot",
			(value, prev: string[]) => [...prev, value],
			[],
		)
		.option("--inactive", "include inactive memories");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(
		(
			opts: DbOpts &
				JsonOpts & {
					project?: string;
					allProjects?: boolean;
					probe?: string[];
					inactive?: boolean;
				},
		) => {
			const project =
				opts.allProjects === true
					? null
					: opts.project?.trim() ||
						process.env.CODEMEM_PROJECT?.trim() ||
						resolveProject(process.cwd(), null);
			const result = getMemoryRoleReport(resolveDbOpt(opts), {
				project,
				allProjects: opts.allProjects === true,
				includeInactive: opts.inactive === true,
				probes: opts.probe,
			});

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			p.intro("codemem memory role-report");
			p.log.info(
				[
					`Memories: ${result.totals.memories}`,
					`Active: ${result.totals.active}`,
					`Sessions: ${result.totals.sessions}`,
				].join("\n"),
			);
			p.log.info("Counts by role:");
			for (const [role, count] of Object.entries(result.counts_by_role)) {
				p.log.message(`  ${role.padEnd(10)} ${String(count)}`);
			}
			p.log.info("Summary lineages:");
			p.log.message(`  session_summary         ${result.summary_lineages.session_summary}`);
			p.log.message(`  legacy_metadata_summary ${result.summary_lineages.legacy_metadata_summary}`);
			p.log.info("Project quality:");
			for (const [bucket, count] of Object.entries(result.project_quality)) {
				p.log.message(`  ${bucket.padEnd(12)} ${String(count)}`);
			}
			if (result.probe_results.length > 0) {
				p.log.info("Probe results:");
				for (const probe of result.probe_results) {
					p.log.message(`  query: ${probe.query}`);
					p.log.message(`    mode: ${probe.mode}`);
					for (const item of probe.items.slice(0, 5)) {
						p.log.message(`    [${item.id}] (${item.kind}/${item.role}) ${item.title}`);
					}
				}
			}
			p.outro("done");
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
memoryCommand.addCommand(createMemoryRoleReportCommand());
