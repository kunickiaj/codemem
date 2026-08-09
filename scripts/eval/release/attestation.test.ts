import { describe, expect, it } from "vitest";
import {
	MAX_ATTESTATION_AGE_MS,
	MAX_ATTESTATION_FUTURE_SKEW_MS,
	parseReleaseAttestation,
	parseReleaseThresholdProfile,
	parseReleaseThresholdProfileDocument,
	type ReleaseAttestationV1,
	type ReleaseThresholdProfileV1,
	releaseAttestationPath,
	releaseThresholdProfilePath,
	verifyReleaseAttestation,
} from "./attestation.js";
import { digest } from "./canonical.js";
import type { ComponentDigests, JsonValue } from "./types.js";

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;
const SHA_C = `sha256:${"c".repeat(64)}` as const;
const COMPONENTS: ComponentDigests = { observer: SHA_A, retrieval: SHA_B, injection: SHA_C };
const NOW = new Date("2026-08-08T12:00:00.000Z");

function profileDigestFixture(): ReleaseThresholdProfileV1 {
	const zeroCommit = "0".repeat(40);
	const zeroDigest = `sha256:${"0".repeat(64)}` as const;
	return {
		benchmark_profile: "release-v1",
		candidate_commit_policy: "equal",
		expected_evidence: {
			configuration_digest: zeroDigest,
			corpus_digests: {
				injection_public: zeroDigest,
				observer_private: zeroDigest,
				retrieval_private: zeroDigest,
			},
			evaluator_commit: zeroCommit,
			subject_commits: [
				{
					resolved_commit: zeroCommit,
					subject: { kind: "candidate", version: "0.0.0" },
				},
			],
		},
		minimum_repetitions: 1,
		profile_id: "x-v1",
		required_suites: { injection: 1, observer: 1, retrieval: 1 },
		schema_version: 1,
		status: "approved",
		thresholds: [
			{
				gate_id: "a",
				operator: "lte",
				selector: {
					component: "observer",
					metric: "parser_data_loss_rate",
					phase: "final",
					subject: { kind: "candidate", version: "0.0.0" },
				},
				threshold: 0,
				unit: "ratio",
			},
			{
				gate_id: "b",
				operator: "gte",
				selector: {
					component: "observer",
					metric: "schema_compliance_rate",
					phase: "final",
					subject: { kind: "candidate", version: "0.0.0" },
				},
				threshold: 1,
				unit: "ratio",
			},
			{
				gate_id: "c",
				operator: "gte",
				selector: {
					component: "retrieval",
					lane: "candidate_semantic",
					metric: "relevant_placement_rate",
					subject: { kind: "candidate", version: "0.0.0" },
				},
				threshold: 1,
				unit: "ratio",
			},
		],
	};
}

function profile(): ReleaseThresholdProfileV1 {
	return {
		schema_version: 1,
		profile_id: "stable-release-v1",
		benchmark_profile: "release-v1",
		status: "approved",
		candidate_commit_policy: "equal",
		minimum_repetitions: 3,
		required_suites: { observer: 12, retrieval: 12, injection: 10 },
		expected_evidence: {
			evaluator_commit: COMMIT,
			configuration_digest: SHA_A,
			corpus_digests: {
				observer_private: SHA_A,
				retrieval_private: SHA_C,
				injection_public: SHA_B,
			},
			subject_commits: [
				{
					subject: { kind: "candidate", version: "0.40.0" },
					resolved_commit: COMMIT,
				},
			],
		},
		thresholds: [
			{
				gate_id: "candidate-observer-parser-data-loss",
				selector: {
					component: "observer",
					metric: "parser_data_loss_rate",
					subject: { kind: "candidate", version: "0.40.0" },
					phase: "final",
				},
				operator: "lte",
				threshold: 0,
				unit: "ratio",
			},
			{
				gate_id: "candidate-observer-schema-compliance",
				selector: {
					component: "observer",
					metric: "schema_compliance_rate",
					subject: { kind: "candidate", version: "0.40.0" },
					phase: "final",
				},
				operator: "gte",
				threshold: 0.8,
				unit: "ratio",
			},
			{
				gate_id: "candidate-semantic-relevant-placement",
				selector: {
					component: "retrieval",
					lane: "candidate_semantic",
					metric: "relevant_placement_rate",
					subject: { kind: "candidate", version: "0.40.0" },
				},
				operator: "gte",
				threshold: 0.8,
				unit: "ratio",
			},
		],
	};
}

function attestation(profileValue = profile()): ReleaseAttestationV1 {
	const runs: ReleaseAttestationV1["candidate_semantic_retrieval"]["runs"] = [1, 2, 3].map(
		(repetition) => ({
			lane: "candidate_semantic",
			candidate_commit: COMMIT,
			repetition,
			probe_suite_digest: SHA_A,
			source_corpus_digest: SHA_C,
			retrieval_subject_digest: SHA_B,
			probe_count: 4,
			readiness: {
				state: "healthy",
				mode: "semantic",
				embedding_model: "semantic-model-v1",
				semantic_search_model: "semantic-model-v1",
				materialized_memory_count: 8,
				active_memory_count: 8,
				embeddable_memory_count: 8,
				indexed_memory_count: 8,
				pending_memory_count: 0,
				tagged_memory_count: 8,
				expected_file_ref_count: 4,
				file_ref_count: 4,
				expected_concept_ref_count: 4,
				concept_ref_count: 4,
				pending_ref_backfill: false,
				blocking_maintenance_job_count: 0,
			},
			metrics: [{ id: "relevant_placement_rate", value: 0.9, unit: "ratio" }],
		}),
	);
	const values = [0, 0.9, 0.9];
	return {
		schema_version: 1,
		benchmark_profile: "release-v1",
		status: "pass",
		release_version: "0.40.0",
		release_tag: "v0.40.0",
		evaluated_at: "2026-08-08T11:00:00.000Z",
		candidate_commit: COMMIT,
		profile: { id: profileValue.profile_id, digest: digest(profileValue as unknown as JsonValue) },
		provenance: {
			evaluator_commit: COMMIT,
			configuration_digest: SHA_A,
			corpus_digests: {
				observer_private: SHA_A,
				retrieval_private: SHA_C,
				injection_public: SHA_B,
			},
			component_digests: COMPONENTS,
			subject_commits: [
				{
					subject: { kind: "candidate", version: "0.40.0" },
					resolved_commit: COMMIT,
				},
			],
		},
		completeness: {
			repetitions: 3,
			suites: {
				observer: { completed: 12, expected: 12 },
				retrieval: { completed: 12, expected: 12 },
				injection: { completed: 10, expected: 10 },
			},
		},
		execution: { fallback: 0, unavailable: 0, partial: 0, failed: 0 },
		candidate_semantic_retrieval: {
			status: "complete",
			lane: "candidate_semantic",
			candidate_commit: COMMIT,
			probe_suite_digest: SHA_A,
			source_corpus_digest: SHA_C,
			retrieval_subject_digest: SHA_B,
			embedding_model: "semantic-model-v1",
			probe_count: 4,
			repetition_count: 3,
			aggregate_metrics: [{ id: "relevant_placement_rate", value: 0.9, unit: "ratio" }],
			runs,
		},
		metrics: profileValue.thresholds.map((threshold, index) => ({
			selector: structuredClone(threshold.selector),
			value: values[index] ?? 0,
			unit: threshold.unit,
		})),
		gates: profileValue.thresholds.map((threshold, index) => ({
			gate_id: threshold.gate_id,
			selector: structuredClone(threshold.selector),
			operator: threshold.operator,
			threshold: threshold.threshold,
			actual: values[index] ?? 0,
			unit: threshold.unit,
			passed: true,
		})),
	};
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function fixtureAt<T>(values: readonly T[], index: number, label: string): T {
	const value = values[index];
	if (value === undefined)
		throw new Error(`Fixture invariant failed: missing ${label} at index ${index}`);
	return value;
}

function verify(
	overrides: {
		attestation?: unknown;
		profile?: unknown;
		components?: ComponentDigests;
		target?: string;
		now?: Date;
		missing?: "report" | "profile" | "components";
	} = {},
) {
	const profileValue = overrides.profile ?? profile();
	const report = overrides.attestation ?? attestation(profileValue as ReleaseThresholdProfileV1);
	return verifyReleaseAttestation({
		repositoryRoot: "/repo",
		reportPath: releaseAttestationPath("0.40.0"),
		dependencies: {
			readText: async (path) => {
				if (path.endsWith("release-attestation-v1.json")) {
					if (overrides.missing === "report") throw new Error("missing");
					return JSON.stringify(report);
				}
				if (path.endsWith("stable-release-v1.json")) {
					if (overrides.missing === "profile") throw new Error("missing");
					return JSON.stringify(profileValue);
				}
				if (path.endsWith("component-files.json")) {
					if (overrides.missing === "components") throw new Error("missing");
					return JSON.stringify({
						schema_version: 1,
						components: {
							evaluator: ["observer.ts"],
							retrieval: ["retrieval.ts"],
							injection: ["injection.ts"],
						},
					});
				}
				if (path.endsWith("packages/core/package.json"))
					return JSON.stringify({ version: "0.40.0" });
				throw new Error(`unexpected read ${path}`);
			},
			resolveTargetCommit: async () => overrides.target ?? COMMIT,
			digestComponents: async () => overrides.components ?? COMPONENTS,
			now: () => overrides.now ?? NOW,
		},
	});
}

describe("strict release attestation contracts", () => {
	it("binds profile digests to canonical strict source JSON", () => {
		const fixture = profileDigestFixture();
		const expected = "sha256:5f5aa4f6c4355c4d69fba9a58e71bba7fd7b971201f16c17acc4434773decb27";
		expect(parseReleaseThresholdProfileDocument(fixture).digest).toBe(expected);

		const reordered = Object.fromEntries(Object.entries(fixture).reverse());
		expect(parseReleaseThresholdProfileDocument(reordered).digest).toBe(expected);

		const changed = { ...fixture, minimum_repetitions: 2 };
		expect(parseReleaseThresholdProfileDocument(changed).digest).not.toBe(expected);
	});

	it("uses deterministic version and profile paths", () => {
		expect(releaseAttestationPath("0.40.0")).toBe(
			"scripts/eval/baselines/releases/v0.40.0/release-attestation-v1.json",
		);
		expect(releaseThresholdProfilePath("stable-release-v1")).toBe(
			"scripts/eval/baselines/release-threshold-profiles/stable-release-v1.json",
		);
	});

	it.each([
		[
			"unknown",
			(value: Record<string, unknown>): void => {
				value.extra = true;
			},
		],
		[
			"missing",
			(value: Record<string, unknown>): void => {
				delete value.status;
			},
		],
		[
			"schema",
			(value: Record<string, unknown>): void => {
				value.schema_version = 2;
			},
		],
		[
			"tag",
			(value: Record<string, unknown>): void => {
				value.release_tag = "v0.40.1";
			},
		],
		[
			"timestamp",
			(value: Record<string, unknown>): void => {
				value.evaluated_at = "yesterday";
			},
		],
	] as const)("rejects malformed %s attestation data", (_name, mutate) => {
		const value = clone(attestation()) as unknown as Record<string, unknown>;
		mutate(value);
		expect(() => parseReleaseAttestation(value)).toThrow();
	});

	it("rejects unknown profile fields, wrong units, selectors, and missing mandatory gates", () => {
		const unknown = clone(profile()) as unknown as Record<string, unknown>;
		unknown.extra = true;
		expect(() => parseReleaseThresholdProfile(unknown)).toThrow("unknown field");
		const unit = clone(profile()) as unknown as Record<string, unknown>;
		fixtureAt(unit.thresholds as Array<Record<string, unknown>>, 0, "threshold").unit = "count";
		expect(() => parseReleaseThresholdProfile(unit)).toThrow("must be ratio");
		const selector = clone(profile()) as unknown as Record<string, unknown>;
		const selectorThreshold = fixtureAt(
			selector.thresholds as Array<Record<string, unknown>>,
			0,
			"selector threshold",
		);
		const selectorValue = selectorThreshold.selector;
		if (!selectorValue || typeof selectorValue !== "object" || Array.isArray(selectorValue))
			throw new Error(
				"Fixture invariant failed: selector threshold must contain an object selector",
			);
		(selectorValue as Record<string, unknown>).extra = true;
		expect(() => parseReleaseThresholdProfile(selector)).toThrow("unknown field");
		const missing = profile();
		missing.thresholds = missing.thresholds.filter(
			(entry) =>
				entry.selector.component !== "observer" ||
				entry.selector.metric !== "parser_data_loss_rate",
		);
		expect(() => parseReleaseThresholdProfile(missing)).toThrow("parser_data_loss_rate");
	});

	it("rejects any candidate commit policy other than exact equality", () => {
		const value = clone(profile()) as unknown as Record<string, unknown>;
		value.candidate_commit_policy = "ancestor_or_equal";
		expect(() => parseReleaseThresholdProfileDocument(value)).toThrow(
			"candidate_commit_policy must be equal",
		);
	});
});

describe("offline release attestation verification", () => {
	it("accepts fresh complete candidate-bound evidence", async () => {
		await expect(verify()).resolves.toEqual({
			status: "pass",
			release_version: "0.40.0",
			profile_id: "stable-release-v1",
			candidate_commit: COMMIT,
		});
	});

	it("fails closed for missing report/profile and wrong deterministic report path", async () => {
		await expect(verify({ missing: "report" })).rejects.toThrow("attestation is missing");
		await expect(verify({ missing: "profile" })).rejects.toThrow("profile is missing");
		await expect(
			verifyReleaseAttestation({
				repositoryRoot: "/repo",
				reportPath: "report.json",
				dependencies: {
					readText: async () => JSON.stringify(attestation()),
					resolveTargetCommit: async () => COMMIT,
					digestComponents: async () => COMPONENTS,
					now: () => NOW,
				},
			}),
		).rejects.toThrow("path must be");
	});

	it("fails closed with a clear missing component manifest diagnostic", async () => {
		await expect(verify({ missing: "components" })).rejects.toThrow(
			"Component file-set manifest is missing",
		);
	});

	it("compares subject commit sets canonically", async () => {
		const profileValue = profile();
		profileValue.expected_evidence.subject_commits.push({
			subject: { kind: "approved_stable", version: "0.39.0" },
			resolved_commit: OTHER_COMMIT,
		});
		const value = attestation(profileValue);
		value.provenance.subject_commits = [
			...profileValue.expected_evidence.subject_commits,
		].reverse();
		await expect(verify({ attestation: value, profile: profileValue })).resolves.toMatchObject({
			status: "pass",
		});
	});

	it("sorts semantic repetitions before aggregate recomputation", async () => {
		const value = attestation();
		value.candidate_semantic_retrieval.runs.reverse();
		await expect(verify({ attestation: value })).resolves.toMatchObject({ status: "pass" });
	});

	it.each([
		["candidate", (value: ReleaseAttestationV1) => (value.candidate_commit = OTHER_COMMIT)],
		[
			"evaluator",
			(value: ReleaseAttestationV1) => (value.provenance.evaluator_commit = OTHER_COMMIT),
		],
		[
			"subject",
			(value: ReleaseAttestationV1) => {
				fixtureAt(value.provenance.subject_commits, 0, "candidate subject").resolved_commit =
					OTHER_COMMIT;
			},
		],
		[
			"configuration",
			(value: ReleaseAttestationV1) => (value.provenance.configuration_digest = SHA_B),
		],
		[
			"observer private corpus",
			(value: ReleaseAttestationV1) => (value.provenance.corpus_digests.observer_private = SHA_B),
		],
		[
			"retrieval private corpus",
			(value: ReleaseAttestationV1) => (value.provenance.corpus_digests.retrieval_private = SHA_A),
		],
		[
			"injection public corpus",
			(value: ReleaseAttestationV1) => (value.provenance.corpus_digests.injection_public = SHA_C),
		],
	] as const)("rejects wrong %s binding", async (_name, mutate) => {
		const value = clone(attestation());
		mutate(value);
		await expect(verify({ attestation: value })).rejects.toThrow();
	});

	it("rejects wrong component and profile digests", async () => {
		await expect(verify({ components: { ...COMPONENTS, injection: SHA_A } })).rejects.toThrow(
			"injection component digest",
		);
		const value = clone(attestation());
		value.profile.digest = SHA_A;
		await expect(verify({ attestation: value })).rejects.toThrow("profile digest");
	});

	it("rejects noncanonical, future, and stale timestamps", async () => {
		const noncanonical = clone(attestation()) as unknown as Record<string, unknown>;
		noncanonical.evaluated_at = "2026-08-08T11:00:00Z";
		expect(() => parseReleaseAttestation(noncanonical)).toThrow("canonical");
		const future = clone(attestation());
		future.evaluated_at = new Date(
			NOW.getTime() + MAX_ATTESTATION_FUTURE_SKEW_MS + 1,
		).toISOString();
		await expect(verify({ attestation: future })).rejects.toThrow("future");
		const stale = clone(attestation());
		stale.evaluated_at = new Date(NOW.getTime() - MAX_ATTESTATION_AGE_MS - 1).toISOString();
		await expect(verify({ attestation: stale })).rejects.toThrow("stale");
	});

	it("rejects insufficient, incomplete, and unresolved execution", async () => {
		const repetitions = clone(attestation());
		repetitions.completeness.repetitions = 2;
		await expect(verify({ attestation: repetitions })).rejects.toThrow("insufficient repetitions");
		const incomplete = clone(attestation());
		incomplete.completeness.suites.retrieval.completed = 11;
		await expect(verify({ attestation: incomplete })).rejects.toThrow(
			"retrieval suite is incomplete",
		);
		const unresolved = clone(attestation());
		unresolved.execution.failed = 1;
		await expect(verify({ attestation: unresolved })).rejects.toThrow("unresolved failed");
	});

	it("rejects duplicate/missing/failing/wrong-unit/wrong-selector gates", async () => {
		const duplicate = clone(attestation());
		duplicate.gates.push(clone(fixtureAt(duplicate.gates, 0, "gate")));
		await expect(verify({ attestation: duplicate })).rejects.toThrow("duplicates");
		const missing = clone(attestation());
		missing.gates.pop();
		await expect(verify({ attestation: missing })).rejects.toThrow("Gate count mismatch");
		const failing = clone(attestation());
		fixtureAt(failing.metrics, 1, "schema compliance metric").value = 0.7;
		fixtureAt(failing.gates, 1, "schema compliance gate").actual = 0.7;
		await expect(verify({ attestation: failing })).rejects.toThrow("failed when recomputed");
		const unit = clone(attestation()) as unknown as Record<string, unknown>;
		fixtureAt(unit.metrics as Array<Record<string, unknown>>, 0, "attestation metric").unit =
			"count";
		await expect(verify({ attestation: unit })).rejects.toThrow("must be ratio");
		const selector = clone(attestation());
		const selectorGate = fixtureAt(selector.gates, 0, "selector gate");
		if (selectorGate.selector.component !== "observer")
			throw new Error("Fixture invariant failed: selector gate must target observer metrics");
		selectorGate.selector.phase = "initial";
		await expect(verify({ attestation: selector })).rejects.toThrow("selector mismatch");
	});

	it("rejects incomplete semantic repetitions, readiness, identity, and aggregate mismatch", async () => {
		const missing = clone(attestation());
		missing.candidate_semantic_retrieval.runs.pop();
		await expect(verify({ attestation: missing })).rejects.toThrow("run count mismatch");
		const duplicate = clone(attestation());
		fixtureAt(
			duplicate.candidate_semantic_retrieval.runs,
			2,
			"third semantic repetition",
		).repetition = 2;
		await expect(verify({ attestation: duplicate })).rejects.toThrow("duplicates");
		const readiness = clone(attestation());
		fixtureAt(
			readiness.candidate_semantic_retrieval.runs,
			0,
			"semantic readiness repetition",
		).readiness.pending_memory_count = 1;
		await expect(verify({ attestation: readiness })).rejects.toThrow("pending maintenance");
		const identity = clone(attestation());
		fixtureAt(
			identity.candidate_semantic_retrieval.runs,
			0,
			"semantic identity repetition",
		).probe_suite_digest = SHA_B;
		await expect(verify({ attestation: identity })).rejects.toThrow("probe identity mismatch");
		const aggregate = clone(attestation());
		fixtureAt(
			aggregate.candidate_semantic_retrieval.aggregate_metrics,
			0,
			"semantic aggregate metric",
		).value = 0.95;
		await expect(verify({ attestation: aggregate })).rejects.toThrow("aggregate mismatch");
	});
});
