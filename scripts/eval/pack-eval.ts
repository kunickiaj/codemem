#!/usr/bin/env tsx
/**
 * Role-based retrieval pack-eval (standalone tooling, NOT a codemem command).
 *
 * Under the refocused dual-artifact model there is no `prefer_derived_facts`
 * boost to A/B-toggle. This runs a probe battery through the pack trace path
 * once on a real DB and reports artifact-bucket shares per retrieval mode, with
 * an absolute sanity gate plus an optional comparison against a committed metric
 * baseline so ranking changes (e.g. relevance-first ordering) are gated on
 * real-corpus drift. Trace mode avoids writing pack usage rows.
 *
 * Usage:
 *   pnpm run eval:pack -- --db /path/to.sqlite [--json] [--top 5]
 *                         [--baseline scripts/eval/baselines/main.json]
 *                         [--write-baseline scripts/eval/baselines/main.json]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStore, resolveDbPath } from "@codemem/core";
import {
	compareToBaseline,
	evaluateGate,
	isSnapshot,
	runAll,
	type Snapshot,
	snapshot,
} from "./lib.js";
import { DEFAULT_PROBES } from "./scenarios.js";

interface Args {
	db?: string;
	json: boolean;
	top: number;
	baseline?: string;
	writeBaseline?: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { json: false, top: 5 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--db") args.db = argv[++i];
		else if (a === "--json") args.json = true;
		else if (a === "--top") args.top = Number(argv[++i]) || 5;
		else if (a === "--baseline") args.baseline = argv[++i];
		else if (a === "--write-baseline") args.writeBaseline = argv[++i];
	}
	return args;
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function printHuman(snap: Snapshot): void {
	const line = (label: string, value: number) => {
		console.log(`  ${label.padEnd(38)} ${pct(value).padStart(7)}`);
	};
	console.log("\nNon-recap retrieval (default/task/debug):");
	line("durable share (want high)", snap.nonRecap.durable_share);
	line("summary share (want low)", snap.nonRecap.summary_share);
	line("telemetry share (want low)", snap.nonRecap.telemetry_share);
	line("stored derived marker (diagnostic)", snap.nonRecap.stored_derived_fact_share);
	console.log("\nExplicit recap:");
	line("summary share", snap.recap.summary_share);
	line("summary-first rate (want high)", snap.recap.summary_top1_rate);
	if (snap.recap.route_mismatch_count > 0) {
		console.log(`  recap route mismatches                 ${snap.recap.route_mismatch_count}`);
	}
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const dbPath = resolveDbPath(args.db);
	const store = new MemoryStore(dbPath);
	let exitCode = 0;
	try {
		const metrics = runAll(store, DEFAULT_PROBES, args.top);
		const snap = snapshot(metrics);
		const gate = evaluateGate(snap);

		// Optional comparison against a committed metric baseline.
		let baselineDrift: { ok: boolean; notes: string[] } | undefined;
		if (args.baseline) {
			try {
				const prior = JSON.parse(readFileSync(args.baseline, "utf8")) as unknown;
				if (!isSnapshot(prior)) {
					throw new Error("baseline does not match expected snapshot schema");
				}
				baselineDrift = compareToBaseline(prior, snap);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				baselineDrift = {
					ok: false,
					notes: [`baseline unreadable or invalid at ${args.baseline}: ${message}`],
				};
			}
		}

		// Never freeze a baseline from a run the tool itself rejected (failed
		// absolute gate, or regressed vs an explicit --baseline). Otherwise a bad
		// snapshot could be committed as the new "good" reference.
		if (args.writeBaseline) {
			const writable = gate.passed && (baselineDrift ? baselineDrift.ok : true);
			if (writable) {
				mkdirSync(dirname(args.writeBaseline), { recursive: true });
				writeFileSync(args.writeBaseline, `${JSON.stringify(snap, null, 2)}\n`);
				console.log(`Wrote baseline metrics to ${args.writeBaseline}`);
			} else {
				console.log(
					`Refusing to write baseline to ${args.writeBaseline}: run did not pass (gate ${
						gate.passed ? "ok" : "FAILED"
					}${baselineDrift && !baselineDrift.ok ? ", baseline REGRESSED" : ""}).`,
				);
			}
		}

		if (args.json) {
			console.log(JSON.stringify({ snapshot: snap, gate, baselineDrift, perProbe: metrics }, null, 2));
		} else {
			console.log(`DB: ${dbPath}`);
			console.log(`Probes: ${DEFAULT_PROBES.length}  topN: ${args.top}`);
			printHuman(snap);
			console.log("");
			if (gate.passed) {
				console.log("GATE: PASS — explicit recap routes through recall mode.");
			} else {
				console.log("GATE: FAIL");
				for (const f of gate.failures) console.log(`  - ${f}`);
			}
			if (baselineDrift) {
				console.log(`\nBaseline drift: ${baselineDrift.ok ? "ok" : "REGRESSED"}`);
				for (const n of baselineDrift.notes) console.log(`  - ${n}`);
			}
		}

		exitCode = !gate.passed || (baselineDrift ? !baselineDrift.ok : false) ? 1 : 0;
	} finally {
		store.close();
	}
	process.exit(exitCode);
}

main();
