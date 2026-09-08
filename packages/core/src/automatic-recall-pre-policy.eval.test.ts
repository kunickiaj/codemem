import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../../../scripts/eval/automatic-recall-pre-policy.json";
import report from "../../../scripts/eval/baselines/automatic-recall-pre-policy.json";
import fixture from "../../../scripts/eval/fixtures/automatic-recall-pre-policy.json";
import { buildMemoryPackTrace, estimateTokens } from "./pack.js";
import { MemoryStore } from "./store.js";

type FixtureMemory = (typeof fixture.sessions)[number]["memories"][number];

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const fields = Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"));
		return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) as string;
}

function verifySourceIdentity() {
	const cwd = fileURLToPath(new URL("../../../", import.meta.url));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	expect(git("rev-parse", `${manifest.source.commit}^{tree}`)).toBe(manifest.source.tree);
	for (const [path, blob] of Object.entries(manifest.source.blobs)) {
		expect(git("rev-parse", `${manifest.source.commit}:${path}`), path).toBe(blob);
		expect(git("hash-object", path), path).toBe(blob);
	}
	for (const [path, hash] of Object.entries(report.provenance.harness_sha256)) {
		expect(
			createHash("sha256")
				.update(readFileSync(new URL(`../../../${path}`, import.meta.url)))
				.digest("hex"),
			path,
		).toBe(hash);
	}
}

function seedIncident(store: MemoryStore): Map<string, number> {
	const ids = new Map<string, number>();
	for (const session of fixture.sessions) {
		const sessionId = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: session.host_session_id,
			project: fixture.project,
			startedAt: session.started_at,
		});
		for (const memory of session.memories) {
			ids.set(memory.key, insertMemory(store, sessionId, memory));
		}
	}
	return ids;
}

function insertMemory(store: MemoryStore, sessionId: number, memory: FixtureMemory): number {
	const id = store.remember(
		sessionId,
		memory.kind,
		memory.title,
		memory.body,
		memory.confidence,
		memory.tags,
		memory.metadata,
	);
	store.db
		.prepare("UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?")
		.run(memory.created_at, memory.created_at, id);
	return id;
}

function stableOutcome(store: MemoryStore, query: string, ids: Map<string, number>) {
	const trace = buildMemoryPackTrace(
		store,
		query,
		fixture.limit,
		fixture.core_token_budget,
		{ project: fixture.project },
		undefined,
		{ compressionMode: fixture.compression_mode },
	);
	const selectedIds = Object.values(trace.assembly.sections).flat();
	const keysFor = (sectionIds: number[]) =>
		[...ids]
			.filter(([, id]) => sectionIds.includes(id))
			.map(([key]) => key)
			.sort();
	const selectedKeys = [...ids]
		.filter(([, id]) => selectedIds.includes(id))
		.map(([key]) => key)
		.sort();
	return {
		mode: trace.mode.selected,
		selected_keys: selectedKeys,
		summary_keys: keysFor(trace.assembly.sections.summary),
		timeline_keys: keysFor(trace.assembly.sections.timeline),
		pack_tokens: trace.output.estimated_tokens,
		wrapped_estimated_tokens: {
			new: estimateTokens(`${fixture.synthetic_wrapper_prefix}${trace.output.pack_text}`),
			retained: 0,
		},
	};
}

function countMatches(selectedKeys: string[], expectedKeys: readonly string[]): number {
	return expectedKeys.filter((key) => selectedKeys.includes(key)).length;
}

describe("automatic recall actual-source pre-policy baseline", () => {
	let store: MemoryStore;
	let ids: Map<string, number>;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(fixture.clock));
		store = new MemoryStore(":memory:");
		ids = seedIncident(store);
	});

	afterEach(() => {
		store.close();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("pins fixture provenance and the missing host-to-numeric session mapping", () => {
		// Arrange
		const digestInput = canonicalJson(fixture);

		// Act
		const digest = createHash("sha256").update(digestInput).digest("hex");
		const mappings = store.db
			.prepare(
				"SELECT stream_id, session_id FROM opencode_sessions WHERE source = 'opencode' ORDER BY stream_id",
			)
			.all() as Array<{ stream_id: string; session_id: number }>;

		// Assert
		expect(digest).toBe(manifest.gates.incident_fixture_digest);
		expect(report.provenance.source_commit).toBe(manifest.source.commit);
		expect(report.provenance.source_tree).toBe(manifest.source.tree);
		expect(report.provenance.fixture_sha256).toBe(digest);
		expect(mappings).toHaveLength(fixture.sessions.length);
		expect(mappings.every((mapping) => Number.isSafeInteger(mapping.session_id))).toBe(true);
	});

	it("verifies pinned Git blobs and separately hashed harness content", verifySourceIdentity);

	it("records the unwanted generic Continue inclusion separately from desired gold", () => {
		// Arrange
		const gold = fixture.gold.generic_continue;

		// Act
		const first = stableOutcome(store, fixture.query, ids);
		const second = stableOutcome(store, fixture.query, ids);

		// Assert
		expect(first).toEqual(second);
		expect(first).toMatchObject(report.observed.generic_continue);
		expect(first.selected_keys).toEqual(
			expect.arrayContaining([...gold.required_keys, ...gold.forbidden_keys]),
		);
		expect(report.gold.generic_continue.forbidden_keys).toEqual(gold.forbidden_keys);
		expect(report.incident.generic_continue.useful_fact_coverage).toEqual({
			present: countMatches(first.selected_keys, gold.required_keys),
			total: gold.required_keys.length,
		});
		expect(report.incident.generic_continue.wrongful_summary_inclusion).toEqual({
			count: countMatches(first.selected_keys, gold.forbidden_keys),
			total: gold.forbidden_keys.length,
		});
		expect(report.incident.generic_continue.missed_updates).toEqual({ count: 0, total: 0 });
	});

	it("keeps the relevant durable fact without the unrelated summary under explicit retrieval", () => {
		// Arrange
		const gold = fixture.gold.explicit_control;

		// Act
		const first = stableOutcome(store, fixture.explicit_control_query, ids);
		const second = stableOutcome(store, fixture.explicit_control_query, ids);

		// Assert
		expect(first).toEqual(second);
		expect(first).toMatchObject(report.observed.explicit_control);
		expect(first.selected_keys).toEqual(expect.arrayContaining(gold.required_keys));
		expect(first.selected_keys).not.toEqual(expect.arrayContaining(gold.forbidden_keys));
		expect(report.incident.explicit_control.useful_fact_coverage).toEqual({
			present: countMatches(first.selected_keys, gold.required_keys),
			total: gold.required_keys.length,
		});
		expect(report.incident.explicit_control.wrongful_summary_inclusion).toEqual({
			count: countMatches(first.selected_keys, gold.forbidden_keys),
			total: gold.forbidden_keys.length,
		});
		expect(report.incident.explicit_control.missed_updates).toEqual({ count: 0, total: 0 });
	});
});
