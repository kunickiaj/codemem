import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import {
	applyDistillRule,
	buildDistillReport,
	type DistillCandidate,
	type DistillContextDocument,
	type DistillReport,
	draftDistillRule,
	type MemoryFilters,
	MemoryStore,
	ObserverClient,
	projectMatchesFilter,
	renderUnifiedDiff,
	resolveDbPath,
	resolveProject,
	resolveProjectRoot,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	emitJsonError,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";

type DistillCommandOptions = DbOpts &
	JsonOpts & {
		allProjects?: boolean;
		apply?: boolean;
		draft?: boolean;
		explain?: boolean;
		includeDocumented?: boolean;
		kind: string[];
		limit: string;
		minRecurrence: string;
		project?: string;
	};

class DistillUsageError extends Error {}

function collectKind(value: string, previous: string[]): string[] {
	return [...previous, ...value.split(",")].map((kind) => kind.trim()).filter(Boolean);
}

function parsePositiveInteger(value: string, name: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
		throw new DistillUsageError(`${name} must be a positive integer`);
	}
	return parsed;
}

function readContextFile(
	path: string,
	displayPath: string,
	scope: DistillContextDocument["scope"],
): DistillContextDocument | null {
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	return text.trim() ? { path: displayPath, text, scope } : null;
}

function loadDefaultContextDocuments(
	includeProjectContext: boolean,
	cwd = process.cwd(),
): DistillContextDocument[] {
	// The repo-root AGENTS.md describes the current repo (scope "project") and is
	// gated to current-project runs; the user-global context (scope "user")
	// always applies and never suppresses other projects' candidates. Resolve the
	// repo root so running from a subdirectory still finds the project context.
	const projectRoot = resolveProjectRoot(cwd) ?? cwd;
	const documents = [
		includeProjectContext
			? readContextFile(join(projectRoot, "AGENTS.md"), "AGENTS.md", "project")
			: null,
		readContextFile(
			join(homedir(), ".config", "opencode", "AGENTS.md"),
			"~/.config/opencode/AGENTS.md",
			"user",
		),
	];
	return documents.filter((document): document is DistillContextDocument => document != null);
}

function shouldIncludeProjectContext(opts: DistillCommandOptions): boolean {
	if (opts.allProjects) return false;
	const currentProject = resolveProject(process.cwd());
	if (!currentProject) return false;
	const targetProject = opts.project
		? resolveProject(process.cwd(), opts.project)
		: process.env.CODEMEM_PROJECT?.trim() || currentProject;
	if (!targetProject) return false;
	// Only reuse the cwd AGENTS.md when the run actually targets this repo.
	return projectMatchesFilter(targetProject, currentProject);
}

function buildFilters(opts: DistillCommandOptions): MemoryFilters | undefined {
	if (opts.allProjects && opts.project) {
		throw new DistillUsageError("--project cannot be combined with --all-projects");
	}
	if (opts.allProjects) return undefined;

	const defaultProject = process.env.CODEMEM_PROJECT?.trim() || null;
	const project = opts.project
		? resolveProject(process.cwd(), opts.project)
		: (defaultProject ?? resolveProject(process.cwd()));
	return project ? { project } : undefined;
}

async function runDistill(store: MemoryStore, opts: DistillCommandOptions): Promise<DistillReport> {
	const limit = parsePositiveInteger(opts.limit, "limit");
	const minRecurrence = parsePositiveInteger(opts.minRecurrence, "min recurrence");
	return buildDistillReport(store, {
		candidate: {
			includeDocumented: opts.includeDocumented ?? false,
			maxEvidenceItems: opts.explain ? 10 : 5,
		},
		contextDocuments: loadDefaultContextDocuments(shouldIncludeProjectContext(opts)),
		corpus: {
			filters: buildFilters(opts) ?? null,
			kinds: opts.kind.length > 0 ? opts.kind : undefined,
		},
		limit,
		minRecurrence,
	});
}

export function renderDistillReport(report: DistillReport, explain = false): string {
	if (report.candidates.length === 0) {
		return "No distill candidates found.";
	}

	const lines = [`Distill candidates (${report.candidates.length})`, ""];
	for (const [index, candidate] of report.candidates.entries()) {
		lines.push(
			`${index + 1}. [${candidate.scope}] score=${candidate.score.toFixed(3)} recurrence=${candidate.recurrence} target=${candidate.suggested_target}`,
		);
		lines.push(`   projects: ${candidate.projects.join(", ") || "(none)"}`);
		lines.push(`   concepts: ${candidate.concepts.join(", ") || "(none)"}`);
		lines.push(`   members: ${candidate.member_ids.join(", ")}`);
		if (explain) {
			for (const evidence of candidate.evidence) lines.push(`   - ${evidence}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function resolveCandidateTarget(candidate: DistillCandidate): { path: string; display: string } {
	if (candidate.scope === "user") {
		return {
			path: join(homedir(), ".config", "opencode", "AGENTS.md"),
			display: "~/.config/opencode/AGENTS.md",
		};
	}
	const root = resolveProjectRoot(process.cwd()) ?? process.cwd();
	return { path: join(root, "AGENTS.md"), display: "AGENTS.md" };
}

async function draftTopCandidate(
	report: DistillReport,
	opts: DistillCommandOptions,
): Promise<void> {
	const candidate = report.candidates[0];
	if (!candidate) {
		if (opts.json) {
			console.log(JSON.stringify({ draft: null, reason: "no_candidates" }, null, 2));
		} else {
			p.intro("codemem distill");
			p.log.warn("No distill candidates to draft.");
			p.outro("done");
		}
		return;
	}

	const target = resolveCandidateTarget(candidate);
	const current = existsSync(target.path) ? readFileSync(target.path, "utf8") : "";

	let rule: string | null;
	let raw: string | null;
	try {
		const client = new ObserverClient();
		const drafted = await draftDistillRule(candidate, async (system, user) => {
			const response = await client.observe(system, user);
			return response.raw;
		});
		rule = drafted.rule;
		raw = drafted.raw;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const guidance = `drafting needs a configured observer model: ${message}`;
		if (opts.json) {
			emitJsonError("draft_failed", guidance, 1);
		} else {
			p.log.error(guidance);
			process.exitCode = 1;
		}
		return;
	}

	if (!rule) {
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						draft: null,
						reason: "model_declined",
						representative_id: candidate.representative_id,
						raw,
					},
					null,
					2,
				),
			);
		} else {
			p.intro("codemem distill draft");
			p.log.warn("The model declined to draft a rule for the top candidate (too vague).");
			p.outro("done");
		}
		return;
	}

	const applied = applyDistillRule(current, rule);
	const diff = renderUnifiedDiff(target.display, current, applied.text);

	if (opts.json) {
		const wrote = Boolean(opts.apply && applied.changed);
		if (wrote) {
			mkdirSync(dirname(target.path), { recursive: true });
			writeFileSync(target.path, applied.text);
		}
		console.log(
			JSON.stringify(
				{
					draft: {
						target: target.display,
						scope: candidate.scope,
						representative_id: candidate.representative_id,
						recurrence: candidate.recurrence,
						score: candidate.score,
						rule,
						diff,
						already_present: !applied.changed,
						applied: wrote,
					},
				},
				null,
				2,
			),
		);
		return;
	}

	p.intro("codemem distill draft");
	p.log.info(
		`Top candidate [${candidate.scope}] recurrence=${candidate.recurrence} → ${target.display}`,
	);
	p.log.step(`Proposed rule:\n  ${rule}`);
	if (!applied.changed) {
		p.log.warn("This rule is already present in the target file.");
		p.outro("nothing to apply");
		return;
	}
	console.log(diff);

	if (!opts.apply) {
		p.outro(`dry run — re-run with --apply to write ${target.display}`);
		return;
	}

	const confirmed = await p.confirm({ message: `Apply this change to ${target.display}?` });
	if (p.isCancel(confirmed) || !confirmed) {
		p.outro("aborted — nothing written");
		return;
	}
	mkdirSync(dirname(target.path), { recursive: true });
	writeFileSync(target.path, applied.text);
	p.outro(`wrote ${target.display}`);
}

async function distillAction(opts: DistillCommandOptions): Promise<void> {
	let store: MemoryStore | null = null;
	try {
		store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
		const result = await runDistill(store, opts);
		if (opts.draft || opts.apply) {
			await draftTopCandidate(result, opts);
			return;
		}
		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}
		p.intro("codemem distill");
		console.log(renderDistillReport(result, opts.explain ?? false));
		p.outro("review candidates before editing context files");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const usageError = error instanceof DistillUsageError;
		if (opts.json) {
			emitJsonError(usageError ? "usage_error" : "distill_failed", message, usageError ? 2 : 1);
			return;
		}
		p.log.error(message);
		process.exitCode = usageError ? 2 : 1;
	} finally {
		store?.close();
	}
}

const cmd = new Command("distill")
	.configureHelp(helpStyle)
	.description("Mine recurring memories into reviewable context candidates")
	.option("-p, --project <project>", "project identifier (defaults to git repo root)")
	.option("-A, --all-projects", "mine memories across all projects")
	.option("-k, --kind <kind>", "memory kind to mine (repeat or comma-separate)", collectKind, [])
	.option("-m, --min-recurrence <n>", "minimum member count per candidate", "2")
	.option("-l, --limit <n>", "max candidates", "10")
	.option("-e, --explain", "include evidence snippets in human output")
	.option("--include-documented", "include candidates already represented in context files")
	.option("-D, --draft", "draft an AGENTS.md rule for the top candidate and show the diff")
	.option(
		"--apply",
		"write the drafted rule to the target file (implies --draft; prompts to confirm)",
	);

addDbOption(cmd);
addJsonOption(cmd);
cmd.action(distillAction);

export const distillCommand = cmd;
