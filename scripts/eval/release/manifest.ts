import {
	commitId,
	exactKeys,
	finiteNumber,
	jsonObject,
	nonEmptyTrimmedString,
	safeInteger,
	sha256Digest,
} from "./json-shape.js";
import type {
	ComponentFileSetManifestV1,
	CorpusTier,
	ReleaseEvalManifestV1,
	SanitizedSubjectIdentifier,
} from "./types.js";

const VERSION_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSanitizedSubjectIdentifier(
	value: unknown,
	path = "subject",
): SanitizedSubjectIdentifier {
	const input = jsonObject(value, path);
	exactKeys(input, ["kind", "version"], path);
	if (input.kind !== "candidate" && input.kind !== "approved_stable" && input.kind !== "release")
		throw new TypeError(`${path}.kind is not supported`);
	const version = nonEmptyTrimmedString(input.version, `${path}.version`);
	if (!VERSION_PATTERN.test(version))
		throw new TypeError(`${path}.version must be a semantic version`);
	return { kind: input.kind, version };
}

function unique<T>(values: T[], path: string): T[] {
	if (
		new Set(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))))
			.size !== values.length
	)
		throw new TypeError(`${path} must not contain duplicates`);
	return values;
}

export function parseReleaseEvalManifest(value: unknown): ReleaseEvalManifestV1 {
	const root = jsonObject(value, "manifest");
	exactKeys(
		root,
		["schema_version", "benchmark_profile", "corpora", "evaluator", "subjects", "repetitions"],
		"manifest",
	);
	if (root.schema_version !== 1) throw new TypeError("manifest.schema_version must be 1");
	if (root.benchmark_profile !== "release-v1")
		throw new TypeError("manifest.benchmark_profile must be release-v1");
	if (!Array.isArray(root.corpora) || root.corpora.length === 0)
		throw new TypeError("manifest.corpora must be a non-empty array");
	const corpora = root.corpora.map((entry, index) => {
		const path = `manifest.corpora[${index}]`;
		const item = jsonObject(entry, path);
		exactKeys(item, ["tier", "schema_version", "source_path", "expected_digest"], path);
		if (item.tier !== "public" && item.tier !== "private")
			throw new TypeError(`${path}.tier is invalid`);
		if (item.schema_version !== 1) throw new TypeError(`${path}.schema_version must be 1`);
		return {
			tier: item.tier as CorpusTier,
			schema_version: 1 as const,
			source_path: nonEmptyTrimmedString(item.source_path, `${path}.source_path`),
			expected_digest: sha256Digest(item.expected_digest, `${path}.expected_digest`),
		};
	});
	unique(
		corpora.map((entry) => entry.tier),
		"manifest.corpora tiers",
	);

	const evaluator = jsonObject(root.evaluator, "manifest.evaluator");
	exactKeys(evaluator, ["commit", "configuration"], "manifest.evaluator");
	const configuration = jsonObject(evaluator.configuration, "manifest.evaluator.configuration");
	exactKeys(
		configuration,
		[
			"provider",
			"transport",
			"endpoint_mode",
			"model",
			"temperature",
			"openai_responses",
			"reasoning_effort",
			"reasoning_summary",
			"max_output_tokens",
			"tier_routing_enabled",
		],
		"manifest.evaluator.configuration",
	);
	if (configuration.endpoint_mode !== "provider_default")
		throw new TypeError("manifest.evaluator.configuration.endpoint_mode must be provider_default");
	if (configuration.tier_routing_enabled !== false)
		throw new TypeError("manifest.evaluator.configuration.tier_routing_enabled must be false");
	if (typeof configuration.openai_responses !== "boolean")
		throw new TypeError("manifest.evaluator.configuration.openai_responses must be boolean");
	if (configuration.reasoning_effort !== null && typeof configuration.reasoning_effort !== "string")
		throw new TypeError("reasoning_effort must be a string or null");
	if (
		configuration.reasoning_summary !== null &&
		typeof configuration.reasoning_summary !== "string"
	)
		throw new TypeError("reasoning_summary must be a string or null");
	if (!Array.isArray(root.subjects) || root.subjects.length === 0)
		throw new TypeError("manifest.subjects must be a non-empty array");
	const subjects = root.subjects.map((entry, index) => {
		const path = `manifest.subjects[${index}]`;
		const item = jsonObject(entry, path);
		exactKeys(
			item,
			["label", "requested_ref", "observer_context_schema_version", "subject", "components"],
			path,
		);
		if (item.observer_context_schema_version !== 1)
			throw new TypeError(`${path}.observer_context_schema_version must be 1`);
		if (!Array.isArray(item.components) || item.components.length === 0)
			throw new TypeError(`${path}.components must be non-empty`);
		const components = unique(
			item.components.map((component, componentIndex) => {
				if (component !== "observer" && component !== "retrieval" && component !== "injection")
					throw new TypeError(`${path}.components[${componentIndex}] is not supported`);
				return component;
			}),
			`${path}.components`,
		);
		return {
			label: nonEmptyTrimmedString(item.label, `${path}.label`),
			requested_ref: nonEmptyTrimmedString(item.requested_ref, `${path}.requested_ref`),
			observer_context_schema_version: 1 as const,
			subject: parseSanitizedSubjectIdentifier(item.subject, `${path}.subject`),
			components,
		};
	});
	unique(
		subjects.map((entry) => entry.label),
		"manifest.subject labels",
	);
	unique(
		subjects.map((entry) => entry.subject),
		"manifest structured subjects",
	);
	return {
		schema_version: 1,
		benchmark_profile: "release-v1",
		corpora,
		evaluator: {
			commit: commitId(evaluator.commit, "manifest.evaluator.commit"),
			configuration: {
				provider: nonEmptyTrimmedString(
					configuration.provider,
					"manifest.evaluator.configuration.provider",
				),
				transport: nonEmptyTrimmedString(
					configuration.transport,
					"manifest.evaluator.configuration.transport",
				),
				endpoint_mode: "provider_default",
				model: nonEmptyTrimmedString(configuration.model, "manifest.evaluator.configuration.model"),
				temperature: finiteNumber(
					configuration.temperature,
					"manifest.evaluator.configuration.temperature",
				),
				openai_responses: configuration.openai_responses,
				reasoning_effort: configuration.reasoning_effort,
				reasoning_summary: configuration.reasoning_summary,
				max_output_tokens: safeInteger(
					configuration.max_output_tokens,
					"manifest.evaluator.configuration.max_output_tokens",
					1,
				),
				tier_routing_enabled: false,
			},
		},
		subjects,
		repetitions: safeInteger(root.repetitions, "manifest.repetitions", 1),
	};
}

function filePath(value: unknown, path: string): string {
	const parsed = nonEmptyTrimmedString(value, path);
	const segments = parsed.split("/");
	if (
		parsed.startsWith("/") ||
		parsed.startsWith("\\") ||
		parsed.includes("\\") ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new TypeError(`${path} must be a repository-relative POSIX path`);
	}
	return parsed;
}

export function parseComponentFileSetManifest(value: unknown): ComponentFileSetManifestV1 {
	const root = jsonObject(value, "component manifest");
	exactKeys(root, ["schema_version", "components"], "component manifest");
	if (root.schema_version !== 1) throw new TypeError("component manifest.schema_version must be 1");
	const components = jsonObject(root.components, "component manifest.components");
	const unknownComponents = Object.keys(components).filter(
		(key) => key !== "evaluator" && key !== "retrieval" && key !== "injection",
	);
	if (unknownComponents.length > 0)
		throw new TypeError(
			`component manifest.components contains unknown field(s): ${unknownComponents.join(", ")}`,
		);
	if (!Array.isArray(components.evaluator) || components.evaluator.length === 0)
		throw new TypeError("component manifest.components.evaluator must be non-empty");
	const optionalComponent = (name: "retrieval" | "injection"): string[] | undefined => {
		const value = components[name];
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.length === 0)
			throw new TypeError(`component manifest.components.${name} must be non-empty`);
		return unique(
			value.map((entry, index) =>
				filePath(entry, `component manifest.components.${name}[${index}]`),
			),
			`component manifest.components.${name}`,
		);
	};
	const retrieval = optionalComponent("retrieval");
	const injection = optionalComponent("injection");
	return {
		schema_version: 1,
		components: {
			evaluator: unique(
				components.evaluator.map((entry, index) =>
					filePath(entry, `component manifest.components.evaluator[${index}]`),
				),
				"component manifest.components.evaluator",
			),
			...(retrieval ? { retrieval } : {}),
			...(injection ? { injection } : {}),
		},
	};
}
