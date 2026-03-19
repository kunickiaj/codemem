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

export const showMemoryCommand = createShowMemoryCommand();
export const forgetMemoryCommand = createForgetMemoryCommand();
export const rememberMemoryCommand = createRememberMemoryCommand();

export const memoryCommand = new Command("memory")
	.configureHelp(helpStyle)
	.description("Memory item management");

memoryCommand.addCommand(createShowMemoryCommand());
memoryCommand.addCommand(createForgetMemoryCommand());
memoryCommand.addCommand(createRememberMemoryCommand());
