import { env } from "cloudflare:workers";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { expect } from "vitest";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { CoordinatorDeviceOwnershipEvidence } from "../../core/src/coordinator-device-ownership-evidence.js";
import { ed25519KeyIdForRevocation } from "../../core/src/coordinator-ed25519-key-id-compat.js";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalReviewedWeakLabels,
	captureLegacyOwnerResolutionRecord,
} from "../../core/src/coordinator-legacy-owner-resolution-metadata.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS } from "../../core/src/coordinator-legacy-owner-resolution-schema.js";
import {
	type CoordinatorLegacyTeamCompletionManifestV1,
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
} from "../../core/src/coordinator-legacy-team-completion.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "../../core/src/recipient-policy-identifiers.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { resetCeremony, snapshot } from "./owner-ceremony-test-fixtures.js";

export const db = env.COORDINATOR_DB;
export const coordinatorId = "native-completion-owner-proof";
export const futureGroup = "native-future-completion";
export const sourceGroup = "native-retained-source-group";
export const completions = "coordinator_legacy_team_completions";
export const resolutions = "coordinator_legacy_owner_resolutions";
export const controllers = "coordinator_auth_controller_attestations";
export const timestamp = "2026-10-03T12:00:00.000Z";
export const signer = {
	deviceId: "native-recovered-device",
	publicKey: CANONICAL_PUBLIC_KEY,
	fingerprint: fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
};
export const otherKey =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM";
type Row = Record<string, string | number | null>;
export const exec = (sql: string, ...values: unknown[]) =>
	db
		.prepare(sql)
		.bind(...values)
		.run();
export async function insert(table: string, row: Row) {
	const entries = Object.entries(row);
	await exec(
		`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
		...entries.map(([, value]) => value),
	);
}
export async function reset() {
	await resetCeremony();
	await exec(`DROP TABLE IF EXISTS ${resolutions}`);
	await db.batch(LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
	for (const table of [completions, "coordinator_invites", "coordinator_bootstrap_grants"])
		await exec(`DELETE FROM ${table}`);
}
export async function state(options: { excludeCompletion?: boolean } = {}) {
	const rows = await snapshot();
	return {
		catalog: (
			await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()
		).results,
		rows: options.excludeCompletion ? rows.filter(([table]) => table !== completions) : rows,
	};
}
export function manifest(
	owner = "A",
	options: { groupId?: string; deviceId?: string; publicKey?: string } = {},
): CoordinatorLegacyTeamCompletionManifestV1 {
	const candidate = legacyTeamCandidateId(coordinatorId, options.groupId ?? futureGroup);
	return {
		version: 1,
		coordinator_id: coordinatorId,
		candidate_ref: candidate,
		candidate_digest: "a".repeat(64),
		team_id: deterministicPolicyTeamId(candidate),
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic completion Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: owner, role: "member" }],
		device_decisions: [
			{
				device_id: options.deviceId ?? signer.deviceId,
				key_fingerprint: fingerprintPublicKey(options.publicKey ?? signer.publicKey),
				enabled: true,
				identity_id: owner,
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: timestamp,
	};
}
export async function history(groupId: string, owner: string) {
	const value = manifest(owner, { groupId });
	await insert(completions, {
		group_id: groupId,
		candidate_ref: value.candidate_ref,
		manifest_version: 1,
		manifest_json: canonical(value),
		completed_at: timestamp,
		created_at: timestamp,
	});
}

/** Actual native SQL only. Mutations run after composition, immediately before INSERT execution. */
export function harness() {
	let mutation: (() => Promise<void>) | undefined;
	let injected = false;
	let afterMutation: Awaited<ReturnType<typeof state>> | undefined;
	let bindCount = 0;
	let phase = "setup";
	let failingSql = "";
	let operationStarted = 0;
	const metrics = {
		captureMs: 0,
		insertMs: 0,
		operationMs: 0,
		snapshotBytes: 0,
		maxJsonBindBytes: 0,
		snapshotSubjects: 0,
		snapshotApproved: 0,
		parameters: 0,
	};
	const winning = (sql: string) =>
		/\bINSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+coordinator_legacy_team_completions\s*\(/iu.test(sql);
	const wrap = (
		statement: D1PreparedStatement,
		sql: string,
		values: unknown[] = [],
	): D1PreparedStatement =>
		new Proxy(statement, {
			get(target, key) {
				if (key === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
				if (key === "run")
					return async () => {
						if (winning(sql)) {
							bindCount = values.length;
							metrics.parameters = values.length;
							metrics.captureMs = performance.now() - operationStarted;
							for (const value of values) {
								if (typeof value !== "string" || !value.startsWith("{")) continue;
								const size = new TextEncoder().encode(value).byteLength;
								metrics.maxJsonBindBytes = Math.max(metrics.maxJsonBindBytes, size);
								if (!value.includes('"subjects":') || !value.includes('"approved":')) continue;
								const encoded = JSON.parse(value) as { subjects: unknown[]; approved: unknown[] };
								metrics.snapshotBytes = size;
								metrics.snapshotSubjects = encoded.subjects.length;
								metrics.snapshotApproved = encoded.approved.length;
							}
							if (mutation && !injected) {
								injected = true;
								await mutation();
								afterMutation = await state();
							}
						}
						phase = winning(sql) ? "winning completion INSERT" : "native run";
						const started = performance.now();
						try {
							return await target.run();
						} catch (error) {
							failingSql = sql;
							throw error;
						} finally {
							if (winning(sql)) metrics.insertMs = performance.now() - started;
						}
					};
				if (key === "first" || key === "all")
					return async (...args: unknown[]) => {
						phase = `native ${String(key)} evidence/read`;
						try {
							return await Reflect.apply(target[key], target, args);
						} catch (error) {
							failingSql = sql;
							throw error;
						}
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	const database = new Proxy(db, {
		get(target, key) {
			if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const store = new D1CoordinatorStore(database);
	return {
		store,
		arm: (change: () => Promise<void>) => {
			mutation = change;
		},
		injected: () => injected,
		afterMutation: () => afterMutation,
		bindCount: () => bindCount,
		metrics: () => ({ ...metrics }),
		diagnostics: () => ({ phase, bindCount, failingSql }),
		async complete(value: CoordinatorLegacyTeamCompletionManifestV1) {
			operationStarted = performance.now();
			try {
				return await store.createLegacyTeamCompletion(futureGroup, value);
			} catch (error) {
				if (String(error).includes("D1_ERROR"))
					throw new Error(
						`${String(error)}; phase=${phase}; binds=${bindCount}; SQL=${failingSql}`,
						{ cause: error },
					);
				throw error;
			} finally {
				metrics.operationMs = performance.now() - operationStarted;
			}
		},
	};
}

export async function recovery() {
	const h = harness();
	for (const group of [sourceGroup, futureGroup]) {
		await h.store.createGroup(group);
		await insert("enrolled_devices", {
			group_id: group,
			device_id: signer.deviceId,
			public_key: signer.publicKey,
			fingerprint: signer.fingerprint,
			identity_id: "B",
			enabled: 1,
			created_at: timestamp,
		});
	}
	await history("history-A", "A");
	await history("history-B", "B");
	await insert("coordinator_invites", {
		invite_id: "completion-project",
		group_id: sourceGroup,
		token: "synthetic-project-token",
		policy: "open",
		created_at: timestamp,
		expires_at: "2026-10-05T00:00:00.000Z",
		consumed_at: timestamp,
		revoked_at: null,
		bound_device_id: signer.deviceId,
		bound_public_key: signer.publicKey,
		bound_fingerprint: signer.fingerprint,
		invite_kind: "project_share",
		assigned_identity_id: null,
		target_identity_id: null,
		recipient_actor_id: "B",
		reviewed_preview_digest: "e".repeat(64),
	});
	const source = {
		attestation_id: "original-controller",
		coordinator_id: coordinatorId,
		identity_id: "A",
		group_id: sourceGroup,
		device_id: signer.deviceId,
		public_key: `${signer.publicKey} retained-source`,
		fingerprint: signer.fingerprint,
		review_receipt_id: "original-receipt",
		evidence_digest: "b".repeat(64),
		enrollment_identity_id: "B",
		revision: 1,
		created_at: "2026-10-01T00:00:00.000Z",
		revoked_at: null,
	};
	await insert(controllers, source);
	const prepare = (s: AuthLinkStatement) => db.prepare(s.sql).bind(...s.values);
	const evidence = new CoordinatorDeviceOwnershipEvidence(
		{
			first: <T>(s: AuthLinkStatement) => prepare(s).first<T>(),
			all: async <T>(s: AuthLinkStatement) => (await prepare(s).all<T>()).results,
		},
		{ coordinatorId },
	);
	const actualSigner = { ...signer, groupId: futureGroup };
	const collected = await evidence.collect({
		canonicalOwnerId: "A",
		actualSigner,
		verifiedHistory: await h.store.captureAuthControllerLegacyHistory({
			...actualSigner,
			coordinatorId,
		}),
	});
	expect(collected).toMatchObject({ kind: "collected", decision: "weak_label_review_required" });
	if (collected.kind !== "collected") throw new Error("native recovery evidence unavailable");
	const weak = canonicalReviewedWeakLabels(collected.weakLabels);
	const digest = await evidence.reviewedEvidenceDigest(collected.recheckSnapshot);
	if (!weak || !digest) throw new Error("native reviewed evidence digest unavailable");
	expect(collected.weakLabels).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ label: "B", kind: "legacy_included_owner_label" }),
			expect.objectContaining({ label: "B", kind: "consumed_project_actor_label" }),
		]),
	);
	const resolution = {
		coordinator_id: coordinatorId,
		resolution_id: "original-resolution",
		resolution_version: 1,
		device_id: signer.deviceId,
		key_id: await ed25519KeyIdForRevocation(signer.publicKey),
		owner_identity_id: "A",
		purpose: "existing_account_owner",
		scope: "historical_included_owner_labels_only",
		source_attestation_id: source.attestation_id,
		source_group_id: source.group_id,
		source_controller_revision: 1,
		source_public_key: source.public_key,
		source_fingerprint: source.fingerprint,
		source_enrollment_identity_id: source.enrollment_identity_id,
		source_created_at: source.created_at,
		source_review_receipt_id: source.review_receipt_id,
		source_evidence_digest: source.evidence_digest,
		resolution_evidence_digest: digest,
		reviewed_weak_labels_json: weak,
		created_at: timestamp,
	};
	await insert(resolutions, resolution);
	expect(
		await evidence.verifyControllerSource({
			sourceRef: resolution,
			expectedOwnerId: "A",
			actualSigner,
		}),
	).toEqual({ kind: "verified_controller_source" });
	return { h, value: manifest(), source, resolution };
}

export function rosterKey(index: number) {
	const seed = Buffer.alloc(32);
	seed.writeUInt32BE(index, 28);
	const privateKey = createPrivateKey({
		key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
		format: "der",
		type: "pkcs8",
	});
	const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
	return `ssh-ed25519 ${Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), der.subarray(-32)]).toString("base64")}`;
}

/** Same UUID and SHA(JSON-array) formulas as the Node production-shaped roster. */
function writerIdentifiers(index: number, fingerprint: string) {
	const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const uuid = (name: string) => {
		const bytes = Buffer.from(sha(["writer-shaped-roster", name, index]).slice(0, 32), "hex");
		bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
		bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
		const text = bytes.toString("hex");
		return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
	};
	const deviceId = uuid("device");
	const owner = `local:${uuid("owner-origin-device")}`;
	const weak = `local:${uuid("historical-owner-origin-device")}`;
	const digest = "c".repeat(64);
	const attestationId = `controller-v1:${sha([coordinatorId, futureGroup, deviceId, fingerprint])}`;
	return {
		deviceId,
		owner,
		weak,
		groupId: uuid("history-group"),
		attestationId,
		reviewReceiptId: `review-v1:${sha([attestationId, owner, digest])}`,
		resolutionId: `resolution-v1:${sha([coordinatorId, deviceId, owner, digest])}`,
	};
}

function bulkRows(table: string, rows: Row[]): D1PreparedStatement[] {
	const first = rows[0];
	if (!first) throw new Error("native full-roster seed missing rows");
	const columns = Object.keys(first);
	const statements: D1PreparedStatement[] = [];
	for (let offset = 0; offset < rows.length; offset += 100) {
		const encoded = JSON.stringify(rows.slice(offset, offset + 100));
		expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(2_000_000);
		statements.push(
			db
				.prepare(`INSERT INTO ${table} (${columns.join(",")})
			SELECT ${columns.map((name) => `json_extract(j.value,'$.${name}')`).join(",")}
			FROM json_each(?) j`)
				.bind(encoded),
		);
	}
	return statements;
}

async function verifyPersistedRoster(expectedSources: Row[], expectedHistory: Row[]) {
	const [sources, receipts, histories] = await Promise.all([
		db.prepare(`SELECT * FROM ${controllers}`).all<Row>(),
		db.prepare(`SELECT * FROM ${resolutions}`).all<Row>(),
		db.prepare(`SELECT * FROM ${completions}`).all<Row>(),
	]);
	expect([sources.results.length, receipts.results.length, histories.results.length]).toEqual([
		500, 500, 500,
	]);
	const sourceById = new Map(sources.results.map((source) => [source.attestation_id, source]));
	const historyByGroup = new Map(histories.results.map((row) => [row.group_id, row]));
	for (const source of expectedSources)
		expect(sourceById.get(source.attestation_id)).toEqual(source);
	for (const history of expectedHistory)
		expect(historyByGroup.get(history.group_id)).toEqual(history);
	for (const row of receipts.results) {
		const receipt = await captureLegacyOwnerResolutionRecord(row);
		if (!receipt) throw new Error("native persisted roster receipt failed canonical validation");
		expect(sourceById.get(receipt.source_attestation_id)).toEqual({
			attestation_id: receipt.source_attestation_id,
			coordinator_id: receipt.coordinator_id,
			identity_id: receipt.owner_identity_id,
			group_id: receipt.source_group_id,
			device_id: receipt.device_id,
			public_key: receipt.source_public_key,
			fingerprint: receipt.source_fingerprint,
			review_receipt_id: receipt.source_review_receipt_id,
			evidence_digest: receipt.source_evidence_digest,
			enrollment_identity_id: receipt.source_enrollment_identity_id,
			revision: receipt.source_controller_revision,
			created_at: receipt.source_created_at,
			revoked_at: null,
		});
	}
}

/** Data-only historical seed, never a submitted approval list or mocked proof. */
export async function fullRecoveredRoster() {
	const started = performance.now();
	const h = harness();
	await h.store.createGroup(futureGroup);
	const value = manifest();
	value.memberships = [];
	value.device_decisions = [];
	const enrolled: Row[] = [];
	const histories: Row[] = [];
	const sources: Row[] = [];
	const receipts: Row[] = [];
	const keys = new Set<string>();
	const owners = new Set<string>();
	const devices = new Set<string>();
	for (let index = 0; index < 500; index++) {
		const publicKey = rosterKey(index + 1000);
		const fingerprint = fingerprintPublicKey(publicKey);
		const ids = writerIdentifiers(index, fingerprint);
		const keyId = await ed25519KeyIdForRevocation(publicKey);
		if (!keyId) throw new Error("authentic native roster key unavailable");
		keys.add(keyId);
		owners.add(ids.owner);
		devices.add(ids.deviceId);
		enrolled.push({
			group_id: futureGroup,
			device_id: ids.deviceId,
			public_key: publicKey,
			fingerprint,
			identity_id: ids.weak,
			enabled: 1,
			created_at: timestamp,
		});
		const old = manifest(ids.weak, { groupId: ids.groupId, deviceId: ids.deviceId, publicKey });
		histories.push({
			group_id: ids.groupId,
			candidate_ref: old.candidate_ref,
			manifest_version: 1,
			manifest_json: canonical(old),
			completed_at: timestamp,
			created_at: timestamp,
		});
		const source = {
			attestation_id: ids.attestationId,
			coordinator_id: coordinatorId,
			identity_id: ids.owner,
			group_id: futureGroup,
			device_id: ids.deviceId,
			public_key: publicKey,
			fingerprint,
			review_receipt_id: ids.reviewReceiptId,
			evidence_digest: "c".repeat(64),
			enrollment_identity_id: ids.weak,
			revision: 1,
			created_at: timestamp,
			revoked_at: null,
		};
		sources.push(source);
		const reviewed = canonicalReviewedWeakLabels([
			{
				label: ids.weak,
				kind: "legacy_included_owner_label",
				group_id: ids.groupId,
				device_id: ids.deviceId,
				evidence_ref: old.source_digest,
				effect: "account_owner_display_only",
			},
		]);
		if (!reviewed) throw new Error("native roster reviewed history invalid");
		receipts.push({
			coordinator_id: coordinatorId,
			resolution_id: ids.resolutionId,
			resolution_version: 1,
			device_id: ids.deviceId,
			key_id: keyId,
			owner_identity_id: ids.owner,
			purpose: "existing_account_owner",
			scope: "historical_included_owner_labels_only",
			source_attestation_id: source.attestation_id,
			source_group_id: source.group_id,
			source_controller_revision: 1,
			source_public_key: publicKey,
			source_fingerprint: fingerprint,
			source_enrollment_identity_id: ids.weak,
			source_created_at: timestamp,
			source_review_receipt_id: source.review_receipt_id,
			source_evidence_digest: source.evidence_digest,
			resolution_evidence_digest: "e".repeat(64),
			reviewed_weak_labels_json: reviewed,
			created_at: timestamp,
		});
		value.memberships.push({ identity_id: ids.owner, role: "member" });
		value.device_decisions.push({
			device_id: ids.deviceId,
			key_fingerprint: fingerprint,
			enabled: true,
			identity_id: ids.owner,
			decision: "included",
		});
	}
	expect([keys.size, owners.size, devices.size]).toEqual([500, 500, 500]);
	expect(
		[...devices].every((id) =>
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id),
		),
	).toBe(true);
	expect([...owners].every((id) => /^local:[0-9a-f-]{36}$/u.test(id))).toBe(true);
	const statements = [
		...bulkRows("enrolled_devices", enrolled),
		...bulkRows(completions, histories),
		...bulkRows(controllers, sources),
		...bulkRows(resolutions, receipts),
	];
	await db.batch(statements);
	await verifyPersistedRoster(sources, histories);
	const lastSource = sources.at(-1);
	if (!lastSource || typeof lastSource.attestation_id !== "string")
		throw new Error("native final source missing");
	return {
		h,
		value,
		lastSourceId: lastSource.attestation_id,
		setupMs: performance.now() - started,
		seedStatements: statements.length,
	};
}
