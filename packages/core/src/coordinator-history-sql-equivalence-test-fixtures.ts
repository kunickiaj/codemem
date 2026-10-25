import { expect } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	captureLegacyCompletionOwnerProof,
	legacyCompletionOwnerProofSql,
} from "./coordinator-legacy-completion-owner-proof.js";
import { LEGACY_OWNER_INPUT_SQL } from "./coordinator-legacy-owner-compatibility.js";

type Backend = {
	all<T>(statement: AuthLinkStatement): Promise<T[]>;
	first<T>(statement: AuthLinkStatement): Promise<T | null>;
};
const start =
	"SELECT DISTINCT json_array(c.group_id,c.candidate_ref,c.manifest_version,c.completed_at,c.created_at,c.manifest_json) AS row FROM coordinator_legacy_team_completions c";
// Frozen selector from 6594432a, before statement-local membership sets. Only this
// selector is substituted; the production CTEs, codec, caps and bindings stay live.
const oldSelector = `${start} WHERE EXISTS (
 SELECT 1 FROM completion_proof_active s
 WHERE (json_extract(CASE WHEN json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END,'$.coordinator_id')=(SELECT json_extract(value,'$.coordinator') FROM completion_proof_input)
 OR json_extract(CASE WHEN json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END,'$.coordinator_id') IS NULL)
 AND (EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END,'$.device_decisions') d
 WHERE json_extract(CASE WHEN d.type='object' THEN d.value ELSE '{}' END,'$.device_id')=s.deviceId
 OR json_extract(CASE WHEN d.type='object' THEN d.value ELSE '{}' END,'$.key_fingerprint') IN (SELECT value FROM json_each(s.value,'$.fingerprints'))
 OR ((d.type<>'object' OR json_type(CASE WHEN d.type='object' THEN d.value ELSE '{}' END,'$.device_id') IS NOT 'text'
 OR json_type(CASE WHEN d.type='object' THEN d.value ELSE '{}' END,'$.key_fingerprint') IS NOT 'text')
 AND (instr(CASE WHEN d.type='text' THEN json_quote(d.value) ELSE d.value END,json_quote(s.deviceId))>0
 OR EXISTS (SELECT 1 FROM json_each(s.value,'$.fingerprints') f WHERE instr(d.value,f.value)>0))))
 OR ((json_valid(c.manifest_json)=0 OR json_type(CASE WHEN json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END,'$.device_decisions') IS NOT 'array')
 AND (instr(c.manifest_json,json_quote(s.deviceId))>0
 OR EXISTS (SELECT 1 FROM json_each(s.value,'$.fingerprints') f WHERE instr(c.manifest_json,f.value)>0)))))`;

export function referenceHistorySql(sql: string): string {
	const offset = sql.indexOf(start);
	if (offset < 0) throw new Error("history selector not observed");
	// Balanced SQL parentheses, ignoring quoted SQL literals. This also works for
	// the selector embedded in the atomic writer's observed-history CTE.
	let depth = 0;
	let quoted = false;
	let end = offset;
	for (; end < sql.length; end++) {
		const ch = sql[end];
		if (ch === "'") {
			if (quoted && sql[end + 1] === "'") {
				end++;
				continue;
			}
			quoted = !quoted;
		}
		if (quoted) continue;
		if (ch === "(") depth++;
		if (ch === ")" && depth-- === 0) break;
	}
	return sql.slice(0, offset) + oldSelector + sql.slice(end);
}

export async function captureHistorySql(
	backend: Backend,
	input: { groupId: string; manifestJson: string; keyMetadata: string },
) {
	let observed: AuthLinkStatement | undefined;
	let observedRows: unknown[] = [];
	const proof = await captureLegacyCompletionOwnerProof({
		...input,
		backend: {
			first: backend.first,
			async all<T>(statement: AuthLinkStatement): Promise<T[]> {
				const rows = await backend.all<T>(statement);
				if (statement.sql.includes(start)) {
					observed = statement;
					observedRows = rows;
				}
				return rows;
			},
		},
	});
	if (!observed) throw new Error("real capture did not reach history");
	const winning = legacyCompletionOwnerProofSql(proof);
	expect(winning.values).toHaveLength(1);
	const statement = observed;
	return {
		statement,
		observedRows,
		async current(options: { reference?: boolean } = {}) {
			let sql = `${LEGACY_OWNER_INPUT_SQL}${winning.ctes} SELECT (${winning.currentSql}) AS current`;
			if (options.reference) sql = referenceHistorySql(sql);
			return backend.first<{ current: number }>({
				sql,
				values: [input.manifestJson, input.groupId, input.keyMetadata, ...winning.values],
			});
		},
	};
}

export function historyCases(statement: AuthLinkStatement) {
	const input = JSON.parse(String(statement.values[0])) as {
		coordinator: string;
		subjects: { deviceId: string; fingerprints: string[] }[];
	};
	const subject = input.subjects[0];
	if (!subject) throw new Error("real capture subject absent");
	const device = subject.deviceId;
	const fingerprint = subject.fingerprints[0];
	const decision = { device_id: device, key_fingerprint: fingerprint };
	const manifest = (decisions: unknown, coordinator: unknown = input.coordinator) =>
		JSON.stringify({ coordinator_id: coordinator, device_decisions: decisions });
	const rows: { name: string; raw: string; selected: boolean }[] = [];
	const add = (name: string, raw: string, selected: boolean) => rows.push({ name, raw, selected });
	add("device", manifest([{ ...decision, key_fingerprint: "unrelated" }]), true);
	for (const [index, alias] of subject.fingerprints.entries())
		add(
			`fingerprint-alias-${index}`,
			manifest([{ device_id: "other", key_fingerprint: alias }]),
			true,
		);
	add("both", manifest([decision]), true);
	add("unrelated", manifest([{ device_id: "other", key_fingerprint: "other" }]), false);
	add("cross-coordinator", manifest([decision], "other-coordinator"), false);
	add("null-coordinator", manifest([decision], null), true);
	add("absent-coordinator", JSON.stringify({ device_decisions: [decision] }), true);
	add("numeric-coordinator", manifest([decision], 1), false);
	add("boolean-coordinator", manifest([decision], true), false);
	add("cross-coordinator-malformed", manifest({ note: device }, "other-coordinator"), false);
	add("cross-coordinator-string", manifest([device], "other-coordinator"), false);
	add("empty", manifest([]), false);
	addMalformedHistoryCases({ device, fingerprint, manifest, add });
	add(
		"raw-lexemes",
		` { "coordinator_id": ${JSON.stringify(input.coordinator)}, "device_decisions": [${JSON.stringify(decision)}], "n":1e0,"z":-0,"unicode":"\\u96ea" } `,
		true,
	);
	return rows;
}

function addMalformedHistoryCases({
	device,
	fingerprint,
	manifest,
	add,
}: {
	device: string;
	fingerprint: string | undefined;
	manifest: (decisions: unknown) => string;
	add: (name: string, raw: string, selected: boolean) => unknown;
}) {
	for (const value of [null, 0, 1, true, false, "unrelated", {}, []]) {
		add(`primitive-${JSON.stringify(value)}`, manifest([value]), false);
		add(
			`typed-${JSON.stringify(value)}`,
			manifest([{ device_id: value, key_fingerprint: value }]),
			false,
		);
		add(
			`fallback-${JSON.stringify(value)}`,
			manifest([{ device_id: value, key_fingerprint: fingerprint }]),
			true,
		);
	}
	add("string-device", manifest([device]), true);
	add("string-fingerprint", manifest([fingerprint]), true);
	add("array-decision", manifest([[device, fingerprint]]), true);
	add("malformed-field", manifest([{ device_id: null, note: fingerprint }]), true);
	add(
		"welltyped-note-irrelevant",
		manifest([{ device_id: "other", key_fingerprint: "other", note: fingerprint }]),
		false,
	);
	for (const value of [null, 1, true, "unrelated", { nested: device }]) {
		add(
			`nonarray-${JSON.stringify(value)}`,
			manifest(value),
			typeof value === "object" && value !== null,
		);
		add(
			`nonarray-plausible-${JSON.stringify(value)}`,
			JSON.stringify({ device_decisions: value, note: device }),
			true,
		);
	}
	add("missing-decisions", JSON.stringify({ note: "irrelevant" }), false);
	add("missing-plausible", JSON.stringify({ note: fingerprint }), true);
	add("invalid-json", '{"irrelevant":', false);
	add("invalid-plausible-device", `{"note":${JSON.stringify(device)},`, true);
	add("invalid-plausible-fingerprint", `{"note":"${fingerprint}`, true);
	add("json-null", "null", false);
}

export async function compareHistorySql(backend: Backend, statement: AuthLinkStatement) {
	const run = async (sql: string) => {
		try {
			return { rows: await backend.all<{ row: string }>({ ...statement, sql }) };
		} catch (error) {
			return { error: String(error) };
		}
	};
	const old = await run(referenceHistorySql(statement.sql));
	const current = await run(statement.sql);
	expect(current).toEqual(old);
	return current;
}
