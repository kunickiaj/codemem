import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	captureLegacyCompletionOwnerProof,
	legacyCompletionOwnerProofSql,
} from "./coordinator-legacy-completion-owner-proof.js";
import {
	LEGACY_OWNER_INPUT_SQL,
	legacyOwnerKeyMetadata,
} from "./coordinator-legacy-owner-compatibility.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import {
	backendFor,
	buildReview,
	history,
	now,
	revoke,
	seed,
	signer,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import {
	canonicalReviewedWeakLabels,
	captureLegacyOwnerResolutionRecord,
	type LegacyOwnerResolutionRecord,
} from "./coordinator-legacy-owner-resolution-metadata.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	type CoordinatorLegacyTeamCompletionManifestV1,
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
} from "./coordinator-legacy-team-completion.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "./recipient-policy-identifiers.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const futureGroup = "future-completion";
const completions = "coordinator_legacy_team_completions";
const resolutions = "coordinator_legacy_owner_resolutions";
const controllers = "coordinator_auth_controller_attestations";

function manifest(
	f: LinkFixture,
	owner = "identity-a",
	options: { deviceId?: string; publicKey?: string; groupId?: string } = {},
): CoordinatorLegacyTeamCompletionManifestV1 {
	const candidate = legacyTeamCandidateId(f.cfg.coordinatorId, options.groupId ?? futureGroup);
	return {
		version: 1,
		coordinator_id: f.cfg.coordinatorId,
		candidate_ref: candidate,
		candidate_digest: "a".repeat(64),
		team_id: deterministicPolicyTeamId(candidate),
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Future Team",
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
		completed_at: now,
	};
}

function completionRows(f: LinkFixture) {
	return f.db.prepare(`SELECT * FROM ${completions} ORDER BY rowid`).all();
}

async function ordinary(f: LinkFixture) {
	await f.store.createGroup(futureGroup);
	await f.store.enrollDevice(futureGroup, {
		deviceId: signer.deviceId,
		publicKey: signer.publicKey,
		fingerprint: fingerprintPublicKey(signer.publicKey),
	});
	return manifest(f);
}

async function captureHelper(
	f: LinkFixture,
	kind: Backend,
	value: CoordinatorLegacyTeamCompletionManifestV1,
) {
	const h = backendFor(f, kind);
	const d1 = sqliteD1(f.db);
	const backend = {
		first: h.backend.first,
		async all<T>({ sql, values }: AuthLinkStatement): Promise<T[]> {
			if (kind === "D1") {
				const statement = d1.prepare(sql).bind(...values);
				if (!statement.all) throw new Error("fixture D1 all unavailable");
				return (await statement.all<T>()).results ?? [];
			}
			return f.db.prepare(sql).all(...values) as T[];
		},
	};
	const manifestJson = canonical(value);
	const keyMetadata = await legacyOwnerKeyMetadata(
		f.db.prepare("SELECT DISTINCT public_key FROM enrolled_devices ORDER BY public_key").all() as {
			public_key: string;
		}[],
	);
	const proof = await captureLegacyCompletionOwnerProof({
		backend,
		groupId: futureGroup,
		manifestJson,
		keyMetadata,
	});
	const sql = legacyCompletionOwnerProofSql(proof);
	const bindings = [manifestJson, futureGroup, keyMetadata, ...sql.values];
	const captured = JSON.parse(sql.values[0] ?? "null") as {
		atoms: string[];
		rows: Record<string, number[][]>;
	};
	return {
		captured,
		// Exercise generated decoder CTEs only. Altered test snapshots are never
		// submitted as a capability or used for a completion INSERT.
		async readExpectedRows(atoms: string[], rows: unknown[][]) {
			const snapshot = { ...captured, atoms, rows: { ...captured.rows, resolutions: rows } };
			return backend.all<{ row: string }>({
				sql: `${LEGACY_OWNER_INPUT_SQL}${sql.ctes} SELECT row FROM completion_expected_resolutions`,
				values: [...bindings.slice(0, 3), JSON.stringify(snapshot)],
			});
		},
		async evaluateChangedReference(reference: unknown) {
			const snapshot = structuredClone(captured);
			const row = snapshot.rows.schema?.[0];
			if (!row) throw new Error("codec fixture requires observed schema");
			const changed: unknown[] = [...row];
			changed[0] = reference;
			const rows = {
				...snapshot.rows,
				schema: [changed, ...(snapshot.rows.schema?.slice(1) ?? [])],
			};
			return backend.first<{ current: number }>({
				sql: `${LEGACY_OWNER_INPUT_SQL}${sql.ctes} SELECT (${sql.currentSql}) AS current`,
				values: [...bindings.slice(0, 3), JSON.stringify({ ...snapshot, rows })],
			});
		},
		async evaluate() {
			return backend.first<{ current: number; compatible: number }>({
				sql: `${LEGACY_OWNER_INPUT_SQL}${sql.ctes} SELECT (${sql.currentSql}) AS current, (${sql.compatibleSql}) AS compatible`,
				values: bindings,
			});
		},
	};
}

function rosterKey(index: number) {
	// Deterministic actual Ed25519 public keys, not random 32-byte fake points.
	const seed = Buffer.alloc(32);
	seed.writeUInt32BE(index, 28);
	const key = createPrivateKey({
		key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
		format: "der",
		type: "pkcs8",
	});
	const der = createPublicKey(key).export({ format: "der", type: "spki" });
	const wire = Buffer.concat([
		Buffer.from("0000000b7373682d6564323535313900000020", "hex"),
		der.subarray(-32),
	]);
	return `ssh-ed25519 ${wire.toString("base64")}`;
}

async function recovery(f: LinkFixture, kind: Backend) {
	const h = backendFor(f, kind);
	await seed(f, h);
	// Fixture-only pre-upgrade state: exact device/key has historical A and B,
	// with B still the current enrollment and consumed Project actor label.
	f.db.prepare(`DELETE FROM ${completions}`).run();
	history(f, "history-a", "identity-a");
	history(f, "history-b", "identity-b");
	f.db
		.prepare("UPDATE enrolled_devices SET identity_id='identity-b' WHERE device_id=?")
		.run(signer.deviceId);
	await f.store.createGroup(futureGroup);
	f.db
		.prepare(`INSERT INTO enrolled_devices
		(group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at)
		SELECT ?,device_id,public_key,?,'identity-b',enabled,created_at
		FROM enrolled_devices WHERE group_id=? AND device_id=?`)
		.run(futureGroup, fingerprintPublicKey(signer.publicKey), signer.groupId, signer.deviceId);
	f.db
		.prepare(`INSERT INTO coordinator_invites
		(invite_id,group_id,token,policy,created_at,expires_at,consumed_at,
		bound_device_id,bound_public_key,bound_fingerprint,invite_kind,
		assigned_identity_id,target_identity_id,recipient_actor_id,reviewed_preview_digest)
		VALUES ('completion-project',?,'synthetic-completion-token','open',?,?,?,?,?,?,'project_share',NULL,NULL,'identity-b',?)`)
		.run(
			signer.groupId,
			now,
			"2026-10-05T00:00:00.000Z",
			now,
			signer.deviceId,
			signer.publicKey,
			signer.fingerprint,
			"e".repeat(64),
		);
	const result = await commitReviewedOwnerResolution({
		backend: h.backend,
		evidence: h.evidence,
		review: await buildReview(f),
		now,
	});
	expect(result.resolutionDisposition).toBe("created");
	expect(
		await h.evidence.verifyControllerSource({
			sourceRef: result.resolution,
			expectedOwnerId: "identity-a",
			actualSigner: {
				...signer,
				groupId: futureGroup,
				fingerprint: fingerprintPublicKey(signer.publicKey),
			},
		}),
	).toEqual({ kind: "verified_controller_source" });
	expect(JSON.parse(result.resolution.reviewed_weak_labels_json)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ label: "identity-b", kind: "legacy_included_owner_label" }),
			expect.objectContaining({ label: "identity-b", kind: "consumed_project_actor_label" }),
		]),
	);
	expect(
		f.db.prepare(`SELECT * FROM ${completions} WHERE group_id=?`).get(futureGroup),
	).toBeUndefined();
	return { h, result, value: manifest(f) };
}

async function verifyRosterReceipt(
	f: LinkFixture,
	h: ReturnType<typeof backendFor>,
	receipt: LegacyOwnerResolutionRecord,
) {
	const persisted = f.db
		.prepare(`SELECT * FROM ${resolutions} WHERE resolution_id=?`)
		.get(receipt.resolution_id);
	expect(await captureLegacyOwnerResolutionRecord(persisted)).toEqual(receipt);
	expect(
		await h.evidence.verifyControllerSource({
			sourceRef: persisted,
			expectedOwnerId: receipt.owner_identity_id,
			actualSigner: {
				groupId: futureGroup,
				deviceId: receipt.device_id,
				publicKey: receipt.source_public_key,
				fingerprint: receipt.source_fingerprint,
			},
		}),
	).toEqual({ kind: "verified_controller_source" });
}

function rosterIdentifiers(f: LinkFixture, index: number, shape: "short" | "writer") {
	if (shape === "short")
		return {
			deviceId: `d${index}`,
			owner: `a${index}`,
			weak: `b${index}`,
			groupId: `h${index}`,
			attestationId: `c${index}`,
			reviewReceiptId: `v${index}`,
			resolutionId: `r${index}`,
		};
	const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const uuid = (name: string) => {
		const bytes = Buffer.from(sha(["writer-shaped-roster", name, index]).slice(0, 32), "hex");
		bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
		bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
		const text = bytes.toString("hex");
		return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
	};
	// sync-identity uses randomUUID; owner fallback is local:<device UUID>.
	// These exact SHA(JSON-array) ID formulas come from buildInternalReview in
	// coordinator-owner-resolution-review.ts, rather than invented long strings.
	const deviceId = uuid("device");
	const owner = `local:${uuid("owner-origin-device")}`;
	const weak = `local:${uuid("historical-owner-origin-device")}`;
	const fingerprint = fingerprintPublicKey(rosterKey(index + 1000));
	const digest = "c".repeat(64);
	const attestationId = `controller-v1:${sha([f.cfg.coordinatorId, futureGroup, deviceId, fingerprint])}`;
	return {
		deviceId,
		owner,
		weak,
		groupId: uuid("history-group"),
		attestationId,
		reviewReceiptId: `review-v1:${sha([attestationId, owner, digest])}`,
		resolutionId: `resolution-v1:${sha([f.cfg.coordinatorId, deviceId, owner, digest])}`,
	};
}

async function recoveredRoster(f: LinkFixture, kind: Backend, shape: "short" | "writer" = "short") {
	const started = performance.now();
	await f.store.createGroup(futureGroup);
	f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	const h = backendFor(f, kind);
	const value = manifest(f);
	value.memberships = [];
	value.device_decisions = [];
	const insert = (table: string, row: object) => {
		const entries = Object.entries(row);
		f.db
			.prepare(`INSERT INTO ${table} (${entries.map(([name]) => name).join(",")})
			VALUES (${entries.map(() => "?").join(",")})`)
			.run(...entries.map(([, item]) => item));
	};
	const keys = new Set<string>();
	for (let index = 0; index < 500; index++) {
		const { deviceId, owner, weak, groupId, attestationId, reviewReceiptId, resolutionId } =
			rosterIdentifiers(f, index, shape);
		const publicKey = rosterKey(index + 1000);
		const fingerprint = fingerprintPublicKey(publicKey);
		const keyId = await ed25519KeyIdForRevocation(publicKey);
		if (!keyId) throw new Error("authentic roster key unavailable");
		keys.add(keyId);
		insert("enrolled_devices", {
			group_id: futureGroup,
			device_id: deviceId,
			public_key: publicKey,
			fingerprint,
			identity_id: weak,
			enabled: 1,
			created_at: now,
		});
		const old = manifest(f, weak, { groupId, deviceId, publicKey });
		insert(completions, {
			group_id: groupId,
			candidate_ref: old.candidate_ref,
			manifest_version: 1,
			manifest_json: canonical(old),
			completed_at: now,
			created_at: now,
		});
		const source = {
			attestation_id: attestationId,
			coordinator_id: f.cfg.coordinatorId,
			identity_id: owner,
			group_id: futureGroup,
			device_id: deviceId,
			public_key: publicKey,
			fingerprint,
			review_receipt_id: reviewReceiptId,
			evidence_digest: "c".repeat(64),
			enrollment_identity_id: weak,
			revision: 1,
			created_at: now,
			revoked_at: null,
		};
		insert(controllers, source);
		const reviewed = canonicalReviewedWeakLabels([
			{
				label: weak,
				kind: "legacy_included_owner_label",
				group_id: groupId,
				device_id: deviceId,
				evidence_ref: old.source_digest,
				effect: "account_owner_display_only",
			},
		]);
		if (!reviewed) throw new Error("roster reviewed history invalid");
		const receipt: LegacyOwnerResolutionRecord = {
			coordinator_id: f.cfg.coordinatorId,
			resolution_id: resolutionId,
			resolution_version: 1,
			device_id: deviceId,
			key_id: keyId,
			owner_identity_id: owner,
			purpose: "existing_account_owner",
			scope: "historical_included_owner_labels_only",
			source_attestation_id: source.attestation_id,
			source_group_id: source.group_id,
			source_controller_revision: 1,
			source_public_key: publicKey,
			source_fingerprint: fingerprint,
			source_enrollment_identity_id: weak,
			source_created_at: now,
			source_review_receipt_id: source.review_receipt_id,
			source_evidence_digest: source.evidence_digest,
			resolution_evidence_digest: "e".repeat(64),
			reviewed_weak_labels_json: reviewed,
			created_at: now,
		};
		insert(resolutions, receipt);
		// Validate persisted immutable receipts and their actual original controllers,
		// not a submitted approval list or metadata-only ownership assertion.
		await verifyRosterReceipt(f, h, receipt);
		value.memberships.push({ identity_id: owner, role: "member" });
		value.device_decisions.push({
			device_id: deviceId,
			key_fingerprint: fingerprint,
			enabled: true,
			identity_id: owner,
			decision: "included",
		});
	}
	expect(keys.size).toBe(500);
	expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${resolutions}`).get()).toEqual({ n: 500 });
	expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${controllers}`).get()).toEqual({ n: 500 });
	return { value, preparationMs: performance.now() - started };
}

function observeRosterOperation(f: LinkFixture, options: { revokeAtInsert: boolean }) {
	const prepare = f.db.prepare.bind(f.db);
	const started = performance.now();
	const metrics = {
		captureMs: 0,
		insertMs: 0,
		maxJsonBindBytes: 0,
		snapshotBytes: 0,
		maxSnapshotSerializedBytes: 0,
		serializedSnapshotSubjects: 0,
		serializedSnapshotApproved: 0,
		maxParameters: 0,
		insertParameters: 0,
		statements: 0,
		historyViews: 0,
		maxHistoryViewRecords: 0,
		injected: false,
		queries: [] as { ms: number; tail: string }[],
	};
	const recordBindings = (values: unknown[], winning: boolean) => {
		metrics.maxParameters = Math.max(metrics.maxParameters, values.length);
		for (const value of values) {
			if (typeof value !== "string" || !value.startsWith("{")) continue;
			const size = Buffer.byteLength(value);
			metrics.maxJsonBindBytes = Math.max(metrics.maxJsonBindBytes, size);
			if (winning && (value.startsWith('{"subjects":') || value.startsWith('{"coordinator":'))) {
				metrics.snapshotBytes = size;
			}
		}
	};
	const beforeInsert = (parameterCount: number) => {
		metrics.captureMs = performance.now() - started;
		metrics.insertParameters = parameterCount;
		if (options.revokeAtInsert) {
			prepare(`UPDATE ${controllers} SET revoked_at=? WHERE attestation_id='c499'`).run(now);
			metrics.injected = true;
		}
	};
	const stringify = JSON.stringify;
	vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
		const result = stringify(value, replacer, space);
		if (
			value &&
			typeof value === "object" &&
			"rows" in value &&
			"subjects" in value &&
			"approved" in value
		) {
			metrics.maxSnapshotSerializedBytes = Math.max(
				metrics.maxSnapshotSerializedBytes,
				Buffer.byteLength(result),
			);
			if (Array.isArray(value.subjects)) metrics.serializedSnapshotSubjects = value.subjects.length;
			if (Array.isArray(value.approved)) metrics.serializedSnapshotApproved = value.approved.length;
		}
		if (value && typeof value === "object" && "records" in value && Array.isArray(value.records)) {
			metrics.historyViews++;
			metrics.maxHistoryViewRecords = Math.max(metrics.maxHistoryViewRecords, value.records.length);
		}
		return result;
	});
	vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
		metrics.statements++;
		const statement = prepare(sql);
		const winning =
			/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+coordinator_legacy_team_completions\s*\(/iu.test(sql);
		for (const method of ["run", "all", "get"] as const) {
			const execute = statement[method].bind(statement);
			vi.spyOn(statement, method).mockImplementation((...values: unknown[]) => {
				recordBindings(values, winning);
				if (winning) beforeInsert(values.length);
				const queryStarted = performance.now();
				try {
					return execute(...values);
				} finally {
					const ms = performance.now() - queryStarted;
					metrics.queries.push({ ms, tail: sql.slice(-220) });
					if (winning) metrics.insertMs = ms;
					if (ms > 250)
						console.info("full-recovery-slow-query", {
							ms,
							tail: sql.slice(-220),
							parameters: values.length,
							maxJsonBindBytes: metrics.maxJsonBindBytes,
							historyViews: metrics.historyViews,
						});
				}
			});
		}
		return statement;
	});
	return metrics;
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);

	test.for([
		{
			name: "null and string null",
			atoms: ["null", '"null"'],
			refs: [0, 1, 0],
			expected: '[null,"null",null]',
		},
		{
			name: "numeric lexemes and strings",
			atoms: ["1", "1.0", "1e0", "1E+0", "-0", "2.5e-3", '"1"'],
			refs: [0, 1, 2, 3, 4, 5, 6],
			expected: '[1,1.0,1e0,1E+0,-0,2.5e-3,"1"]',
		},
		{
			name: "Unicode escape spellings",
			atoms: ['"雪"', '"\\u96ea"', '"\\u96EA"', '"é"', '"e\\u0301"'],
			refs: [0, 1, 2, 3, 4],
			expected: '["雪","\\u96ea","\\u96EA","é","e\\u0301"]',
		},
		{
			name: "quotes backslashes control escapes",
			atoms: ['"\\""', '"\\\\"', '"\\n"', '"\\u0000"', '"\\u000A"', '"\\/"'],
			refs: [0, 1, 2, 3, 4, 5],
			expected: '["\\"","\\\\","\\n","\\u0000","\\u000A","\\/"]',
		},
		{
			name: "repeated atoms and numeric column ordering",
			atoms: ['"same"', "null", "1.0"],
			refs: [0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 2, 0],
			expected: '["same",null,"same",1.0,"same",null,"same",1.0,"same",null,1.0,"same"]',
		},
	])(
		`${kind} private codec decoder preserves $name byte-for-byte`,
		async (sample, { fixture: f }) => {
			// Arrange: obtain the actual decoder SQL from a legitimate read-only capture.
			const value = await ordinary(f);
			f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
			const helper = await captureHelper(f, kind, value);
			const before = snapshot(f);
			// Act
			const decoded = await helper.readExpectedRows(sample.atoms, [
				sample.refs,
				sample.refs.toReversed(),
			]);
			// Assert: rows are a set, but cell order and original lexemes are exact.
			expect(decoded.map(({ row }) => row).sort()).toEqual(
				[
					sample.expected,
					`[${sample.refs
						.toReversed()
						.map((reference) => sample.atoms[reference])
						.join(",")}]`,
				].sort(),
			);
			expect(decoded).toHaveLength(2);
			expect(snapshot(f)).toEqual(before);
		},
	);

	test(`${kind} private codec decoder keeps empty categories empty`, async ({ fixture: f }) => {
		// Arrange
		const value = await ordinary(f);
		f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
		const helper = await captureHelper(f, kind, value);
		// Act
		const decoded = await helper.readExpectedRows([], []);
		// Assert
		expect(decoded).toEqual([]);
		expect(await helper.evaluate()).toEqual({ current: 1, compatible: 1 });
	});

	test.for([-1, 999999, null, "not-an-index", {}])(
		`${kind} private codec invalid reference %j cannot pass freshness`,
		async (reference, { fixture: f }) => {
			// Arrange: malformed snapshots are evaluated only by a SELECT, never a write.
			const value = await ordinary(f);
			f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
			const helper = await captureHelper(f, kind, value);
			const before = snapshot(f);
			// Act
			const result = await helper.evaluateChangedReference(reference);
			// Assert: dropping an undecodable cell cannot match the observed schema row.
			expect(result).toEqual({ current: 0 });
			expect(snapshot(f)).toEqual(before);
		},
	);

	test(`${kind} private codec captures unusual original key comments and null source fields`, async ({
		fixture: f,
	}) => {
		// Arrange: append a complete historical receipt with its matching original source.
		const { value, h, result } = await recovery(f, kind);
		const publicKey = `${signer.publicKey} source "quoted" \\ 雪 é null`;
		const source = {
			...result.controller,
			attestation_id: "codec-source",
			group_id: "codec-source-group",
			public_key: publicKey,
			fingerprint: fingerprintPublicKey(publicKey),
			review_receipt_id: "null",
			enrollment_identity_id: null,
		};
		const receipt = {
			...result.resolution,
			resolution_id: "codec-resolution",
			source_attestation_id: source.attestation_id,
			source_group_id: source.group_id,
			source_public_key: publicKey,
			source_fingerprint: source.fingerprint,
			source_review_receipt_id: source.review_receipt_id,
			source_enrollment_identity_id: null,
		};
		for (const [table, row] of [
			[controllers, source],
			[resolutions, receipt],
		] as const) {
			const entries = Object.entries(row);
			f.db
				.prepare(
					`INSERT INTO ${table} (${entries.map(([name]) => name).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
				)
				.run(...entries.map(([, cell]) => cell));
		}
		await verifyRosterReceipt(f, h, receipt);
		f.db
			.prepare(`DELETE FROM ${controllers} WHERE attestation_id=?`)
			.run(result.controller.attestation_id);
		const before = snapshot(f);
		// Act
		const helper = await captureHelper(f, kind, value);
		const current = await helper.evaluate();
		// Assert: encoder interns actual source JSON lexemes, including distinct null kinds.
		expect(current).toEqual({ current: 1, compatible: 1 });
		expect(helper.captured.atoms).toEqual(
			expect.arrayContaining(["null", '"null"', JSON.stringify(publicKey)]),
		);
		expect(new Set(helper.captured.atoms).size).toBe(helper.captured.atoms.length);
		expect(snapshot(f)).toEqual(before);
		// Arrange / Act: the captured row must not hide a changed original source.
		f.db
			.prepare(`UPDATE ${controllers} SET public_key=? WHERE attestation_id=?`)
			.run(`${publicKey} changed`, source.attestation_id);
		const stale = await helper.evaluate();
		const fresh = await captureHelper(f, kind, value);
		// Assert
		expect(stale?.current).toBe(0);
		expect(await fresh.evaluate()).toEqual({ current: 1, compatible: 0 });
	});

	test(`${kind} full 500 recovered subjects with production-shaped writer IDs`, async ({
		fixture: f,
	}) => {
		// Arrange: all independent original sources remain verified; only identifier shape changes.
		const { value, preparationMs } = await recoveredRoster(f, kind, "writer");
		const before = snapshot(f, [completions]);
		const oldHistory = completionRows(f);
		const metrics = observeRosterOperation(f, { revokeAtInsert: false });
		const started = performance.now();
		// Act: preserve normal 500-subject behavior under the existing cap and default timeout.
		try {
			const result = await f.store.createLegacyTeamCompletion(futureGroup, value);
			// Assert
			expect(result.status).toBe("created");
			expect(result.manifest.device_decisions).toHaveLength(500);
			expect(snapshot(f, [completions])).toEqual(before);
			expect(completionRows(f).slice(0, 500)).toEqual(oldHistory);
			expect(metrics.snapshotBytes).toBeGreaterThan(0);
			expect(metrics.snapshotBytes).toBeLessThanOrEqual(2_000_000);
		} finally {
			console.info("writer-shaped-full-recovery-roster", {
				backend: kind,
				preparationMs,
				operationMs: performance.now() - started,
				...metrics,
			});
		}
	});

	test.for(["success", "late source revocation"] as const)(
		`${kind} full 500 recovered subjects: %s`,
		async (mode, { fixture: f }) => {
			// Arrange: 500 distinct authentic subjects, old histories, and original source receipts.
			const { value, preparationMs } = await recoveredRoster(f, kind);
			console.info("full-recovery-prepared", { backend: kind, mode, preparationMs });
			const before = snapshot(f, [completions, controllers]);
			const oldHistory = completionRows(f);
			const oldControllers = f.db
				.prepare(`SELECT * FROM ${controllers} ORDER BY attestation_id`)
				.all();
			const metrics = observeRosterOperation(f, { revokeAtInsert: mode !== "success" });
			const started = performance.now();
			// Act: actual stores capture backend evidence and decide in the winning INSERT.
			const pending = f.store.createLegacyTeamCompletion(futureGroup, value);
			try {
				if (mode === "success") {
					const result = await pending;
					expect(result.status).toBe("created");
					expect(result.manifest.device_decisions).toHaveLength(500);
				} else {
					await expect(pending).rejects.toThrow();
				}
			} finally {
				console.info("full-recovery-roster", {
					backend: kind,
					mode,
					preparationMs,
					operationMs: performance.now() - started,
					...metrics,
				});
			}
			// Assert: no old history or immutable source receipt can be rewritten by completion.
			expect(snapshot(f, [completions, controllers])).toEqual(before);
			expect(completionRows(f).slice(0, 500)).toEqual(oldHistory);
			expect(metrics.maxJsonBindBytes).toBeLessThanOrEqual(2_000_000);
			expect(metrics.snapshotBytes).toBeGreaterThan(0);
			expect(metrics.maxParameters).toBeLessThanOrEqual(100);
			if (mode === "success") {
				expect(f.db.prepare(`SELECT * FROM ${controllers} ORDER BY attestation_id`).all()).toEqual(
					oldControllers,
				);
			} else {
				expect(metrics.injected).toBe(true);
				expect(
					f.db.prepare(`SELECT * FROM ${completions} WHERE group_id=?`).all(futureGroup),
				).toEqual([]);
				expect(
					f.db.prepare(`SELECT revoked_at FROM ${controllers} WHERE attestation_id='c499'`).get(),
				).toEqual({ revoked_at: now });
			}
		},
	);

	test(`${kind} direct helper accepts retained original A proof with current B weak labels`, async ({
		fixture: f,
	}) => {
		// Arrange: capture and evaluate actual helper SQL, not a completion INSERT.
		const { value } = await recovery(f, kind);
		const before = snapshot(f);
		// Act
		const helper = await captureHelper(f, kind, value);
		const result = await helper.evaluate();
		// Assert: canonical server-derived key metadata and original source are sufficient.
		expect(result).toEqual({ current: 1, compatible: 1 });
		expect(snapshot(f)).toEqual(before);
	});

	test.for(["source", "binding", "catalog"] as const)(
		`${kind} direct helper invalidates captured proof after a %s change`,
		async (changed, { fixture: f }) => {
			// Arrange: verify the positive capture before introducing the late fact.
			const { value, result: accepted } = await recovery(f, kind);
			const helper = await captureHelper(f, kind, value);
			expect(await helper.evaluate()).toEqual({ current: 1, compatible: 1 });
			if (changed === "source") {
				f.db
					.prepare(`UPDATE ${controllers} SET revoked_at=? WHERE attestation_id=?`)
					.run(now, accepted.controller.attestation_id);
			}
			if (changed === "binding") {
				f.db
					.prepare(`INSERT INTO coordinator_device_ownership_bindings
					(device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
					VALUES (?,?,?,?,?,'owner_enrollment','synthetic-proof',?)`)
					.run(
						signer.deviceId,
						accepted.resolution.key_id,
						"identity-c",
						f.cfg.coordinatorId,
						"late-helper-binding",
						now,
					);
			}
			if (changed === "catalog") {
				f.db.exec(
					`CREATE INDEX completion_helper_catalog_change ON ${resolutions}(owner_identity_id)`,
				);
			}
			const before = snapshot(f);
			// Act: evaluate the original opaque token against the changed database.
			const result = await helper.evaluate();
			// Assert: current must fail even if the captured compatibility decision remains true.
			expect(result?.current).toBe(0);
			if (changed === "binding") expect(result?.compatible).toBe(0);
			expect(snapshot(f)).toEqual(before);
		},
	);

	test.for(["included B", "unknown original source"] as const)(
		`${kind} direct helper refuses %s despite ready resolution metadata`,
		async (denied, { fixture: f }) => {
			// Arrange: source deletion simulates lost proof without modifying immutable receipts.
			const { value } = await recovery(f, kind);
			if (denied === "unknown original source") f.db.prepare(`DELETE FROM ${controllers}`).run();
			const requested = denied === "included B" ? manifest(f, "identity-b") : value;
			const before = snapshot(f);
			// Act
			const helper = await captureHelper(f, kind, requested);
			const result = await helper.evaluate();
			// Assert: the negative result is classified from a current, read-only capture.
			expect(result).toEqual({ current: 1, compatible: 0 });
			expect(snapshot(f)).toEqual(before);
		},
	);

	test(`${kind} direct helper accepts retained source after its group and enrollment disappear`, async ({
		fixture: f,
	}) => {
		// Arrange: preserve the original controller and resolution, not their current group.
		const { value } = await recovery(f, kind);
		f.db
			.prepare("DELETE FROM enrolled_devices WHERE group_id=? AND device_id=?")
			.run(signer.groupId, signer.deviceId);
		f.db.prepare("DELETE FROM groups WHERE group_id=?").run(signer.groupId);
		const before = snapshot(f);
		// Act
		const helper = await captureHelper(f, kind, value);
		const result = await helper.evaluate();
		// Assert
		expect(result).toEqual({ current: 1, compatible: 1 });
		expect(snapshot(f)).toEqual(before);
	});

	test(`${kind} ordinary completion without any subject resolution retains old behavior`, async ({
		fixture: f,
	}) => {
		// Arrange: no account recovery receipts or historical ambiguity.
		const value = await ordinary(f);
		const before = snapshot(f, [completions]);
		// Act
		const result = await f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert
		expect(result).toEqual({ status: "created", manifest: value });
		expect(snapshot(f, [completions])).toEqual(before);
	});

	test(`${kind} ordinary completion refuses a new conflicting owner at the winning INSERT`, async ({
		fixture: f,
	}) => {
		// Arrange: hook the write target, not the full generated SQL string.
		const value = await ordinary(f);
		const prepare = f.db.prepare.bind(f.db);
		let injected = false;
		vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
			const statement = prepare(sql);
			if (
				/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+coordinator_legacy_team_completions\s*\(/iu.test(sql)
			) {
				const run = statement.run.bind(statement);
				vi.spyOn(statement, "run").mockImplementation((...values: unknown[]) => {
					injected = true;
					prepare("UPDATE enrolled_devices SET identity_id='identity-c' WHERE group_id=?").run(
						futureGroup,
					);
					return run(...values);
				});
			}
			return statement;
		});
		// Act
		const pending = f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert: a read-time absence of conflicting ownership cannot authorize the write.
		await expect(pending).rejects.toThrow();
		expect(injected).toBe(true);
		expect(f.db.prepare(`SELECT * FROM ${completions} WHERE group_id=?`).all(futureGroup)).toEqual(
			[],
		);
	});

	test(`${kind} missing resolution catalog cannot hide a new receipt at the winning INSERT`, async ({
		fixture: f,
	}) => {
		// Arrange: produce authentic source/receipt rows in an independent local fixture.
		const source = setupStore(kind, { authClock: () => NOW });
		const sourceFixture: LinkFixture = { ...source, cfg: { ...f.cfg }, now: NOW };
		let accepted: Awaited<ReturnType<typeof recovery>>["result"];
		try {
			accepted = (await recovery(sourceFixture, kind)).result;
		} finally {
			await source.store.close();
			if (source.db.open) source.db.close();
		}
		// D1's bootstrap includes this optional catalog; model a pre-upgrade store
		// before inserting any resolution facts, without disabling immutable triggers.
		f.db.exec(`DROP TABLE IF EXISTS ${resolutions}`);
		await ordinary(f);
		const value = manifest(f, "identity-b");
		expect(
			f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(resolutions),
		).toBeUndefined();
		const prepare = f.db.prepare.bind(f.db);
		let injected = false;
		vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
			const statement = prepare(sql);
			if (
				/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+coordinator_legacy_team_completions\s*\(/iu.test(sql)
			) {
				const run = statement.run.bind(statement);
				vi.spyOn(statement, "run").mockImplementation((...values: unknown[]) => {
					injected = true;
					f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
					for (const [table, row] of [
						[controllers, accepted.controller],
						[resolutions, accepted.resolution],
					] as const) {
						const entries = Object.entries(row);
						prepare(`INSERT INTO ${table} (${entries.map(([name]) => name).join(",")})
							VALUES (${entries.map(() => "?").join(",")})`).run(
							...entries.map(([, value]) => value),
						);
					}
					return run(...values);
				});
			}
			return statement;
		});
		// Act
		const pending = f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert: absent schema is a fact to pin, not permission to ignore later ownership.
		await expect(pending).rejects.toThrow();
		expect(injected).toBe(true);
		expect(f.db.prepare(`SELECT * FROM ${completions} WHERE group_id=?`).all(futureGroup)).toEqual(
			[],
		);
	});

	test(`${kind} retained original resolution authorizes A in an unused future slot without rewriting history or sharing`, async ({
		fixture: f,
	}) => {
		// Arrange: normal manifest semantics, real accepted resolution and source proof.
		const { value } = await recovery(f, kind);
		const oldHistory = completionRows(f);
		const oldTables = snapshot(f, [completions]);
		// Act
		const result = await f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert: this appends a completion only; B remains the Project actor/current label.
		expect(result).toEqual({ status: "created", manifest: value });
		expect(completionRows(f).slice(0, oldHistory.length)).toEqual(oldHistory);
		expect(snapshot(f, [completions])).toEqual(oldTables);
	});

	test.for(["identity-b", "identity-c"])(
		`${kind} resolution for A cannot authorize future included %s`,
		async (owner, { fixture: f }) => {
			// Arrange
			await recovery(f, kind);
			const before = snapshot(f);
			// Act
			const pending = f.store.createLegacyTeamCompletion(futureGroup, manifest(f, owner));
			// Assert
			await expect(pending).rejects.toThrow();
			expect(snapshot(f)).toEqual(before);
		},
	);

	test.for([
		"source missing",
		"source revoked",
		"wrong original receipt",
		"wrong coordinator",
		"device revoked",
		"key revoked",
	] as const)(
		`${kind} refuses future A when %s leaves no usable original proof`,
		async (change, { fixture: f }) => {
			// Arrange: metadata alone must never become positive authority.
			let { value } = await recovery(f, kind);
			if (change === "source missing") f.db.prepare(`DELETE FROM ${controllers}`).run();
			if (change === "source revoked")
				f.db.prepare(`UPDATE ${controllers} SET revoked_at=?`).run(now);
			if (change === "wrong original receipt")
				f.db.prepare(`UPDATE ${controllers} SET review_receipt_id='unknown-receipt'`).run();
			if (change === "wrong coordinator") {
				f.cfg.coordinatorId = "other-coordinator";
				value = manifest(f);
			}
			if (change === "device revoked") await revoke(f, "device_id");
			if (change === "key revoked") await revoke(f, "ed25519_key");
			const before = snapshot(f);
			// Act
			const pending = f.store.createLegacyTeamCompletion(futureGroup, value);
			// Assert
			await expect(pending).rejects.toThrow();
			expect(snapshot(f)).toEqual(before);
		},
	);

	test.for(["device only", "key only"] as const)(
		`${kind} A resolution needs exact device AND key, not %s`,
		async (match, { fixture: f }) => {
			// Arrange: the other authentic fixture key is not covered by this resolution.
			await recovery(f, kind);
			const deviceId = match === "device only" ? signer.deviceId : "different-laptop";
			const publicKey = match === "device only" ? CANONICAL_PUBLIC_KEY : signer.publicKey;
			f.db
				.prepare(
					"UPDATE enrolled_devices SET device_id=?,public_key=?,fingerprint=? WHERE group_id=?",
				)
				.run(deviceId, publicKey, fingerprintPublicKey(publicKey), futureGroup);
			const value = manifest(f, "identity-a", { deviceId, publicKey });
			const before = snapshot(f);
			// Act
			const pending = f.store.createLegacyTeamCompletion(futureGroup, value);
			// Assert
			await expect(pending).rejects.toThrow();
			expect(snapshot(f)).toEqual(before);
		},
	);

	test.for(["device only", "key only"] as const)(
		`${kind} strong other owner colliding by %s still vetoes recovery`,
		async (match, { fixture: f }) => {
			// Arrange: negative collisions use device OR key, unlike positive resolution proof.
			const { value, result } = await recovery(f, kind);
			f.db
				.prepare(`INSERT INTO ${controllers}
			SELECT 'other-owner-controller',coordinator_id,'identity-c','other-controller-group',?, ?,fingerprint,
			'other-owner-receipt',evidence_digest,enrollment_identity_id,revision,created_at,NULL
			FROM ${controllers} WHERE attestation_id=?`)
				.run(
					match === "device only" ? signer.deviceId : "different-laptop",
					match === "device only" ? CANONICAL_PUBLIC_KEY : signer.publicKey,
					result.controller.attestation_id,
				);
			const before = snapshot(f);
			// Act
			const pending = f.store.createLegacyTeamCompletion(futureGroup, value);
			// Assert
			await expect(pending).rejects.toThrow();
			expect(snapshot(f)).toEqual(before);
		},
	);

	test(`${kind} reviewed label text cannot cover an unreviewed enrollment origin`, async ({
		fixture: f,
	}) => {
		// Arrange: same B string, but a new origin that was not reviewed.
		const { value } = await recovery(f, kind);
		await f.store.createGroup("unreviewed-label-origin");
		f.db
			.prepare(`INSERT INTO enrolled_devices
			(group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at)
			SELECT 'unreviewed-label-origin',device_id,public_key,fingerprint,identity_id,enabled,created_at
			FROM enrolled_devices WHERE group_id=?`)
			.run(futureGroup);
		const before = snapshot(f);
		// Act
		const pending = f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert
		await expect(pending).rejects.toThrow();
		expect(snapshot(f)).toEqual(before);
	});

	test(`${kind} reviewed B text cannot cover a new consumed Project receipt`, async ({
		fixture: f,
	}) => {
		// Arrange: same actor and exact device/key, but a different unreviewed receipt.
		const { value } = await recovery(f, kind);
		f.db
			.prepare(`INSERT INTO coordinator_invites
			(invite_id,group_id,token,policy,created_at,expires_at,consumed_at,
			bound_device_id,bound_public_key,bound_fingerprint,invite_kind,
			assigned_identity_id,target_identity_id,recipient_actor_id,reviewed_preview_digest)
			SELECT 'new-completion-project',group_id,'new-synthetic-completion-token',policy,
			created_at,expires_at,consumed_at,bound_device_id,bound_public_key,bound_fingerprint,
			invite_kind,assigned_identity_id,target_identity_id,recipient_actor_id,reviewed_preview_digest
			FROM coordinator_invites WHERE invite_id='completion-project'`)
			.run();
		const before = snapshot(f);
		// Act
		const pending = f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert
		await expect(pending).rejects.toThrow();
		expect(snapshot(f)).toEqual(before);
	});

	test(`${kind} 500 authentic distinct roster subjects allow one retained recovery proof`, async ({
		fixture: f,
	}) => {
		// Arrange: full supported roster, with 499 ordinary owners and one recovered A.
		const { value } = await recovery(f, kind);
		const keys = new Set([signer.publicKey]);
		for (let index = 1; index < 500; index++) {
			const publicKey = rosterKey(index);
			keys.add(publicKey);
			const deviceId = `roster-device-${index}`;
			const owner = `roster-owner-${index}`;
			const fingerprint = fingerprintPublicKey(publicKey);
			f.db
				.prepare(`INSERT INTO enrolled_devices
				(group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at)
				VALUES (?,?,?,?,?,1,?)`)
				.run(futureGroup, deviceId, publicKey, fingerprint, owner, now);
			value.memberships.push({ identity_id: owner, role: "member" });
			value.device_decisions.push({
				device_id: deviceId,
				key_fingerprint: fingerprint,
				enabled: true,
				identity_id: owner,
				decision: "included",
			});
		}
		expect(keys.size).toBe(500);
		const before = snapshot(f, [completions]);
		// Act: retain the default timeout; no early subject cap or fake fixture keys.
		const result = await f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert
		expect(result.status).toBe("created");
		expect(result.manifest.device_decisions).toHaveLength(500);
		expect(snapshot(f, [completions])).toEqual(before);
	});

	test.for(["enrollment", "group"] as const)(
		`${kind} retained original source survives removal of its %s`,
		async (removed, { fixture: f }) => {
			// Arrange: resolution proof is retained independently of current source enrollment.
			const { value } = await recovery(f, kind);
			f.db
				.prepare("DELETE FROM enrolled_devices WHERE group_id=? AND device_id=?")
				.run(signer.groupId, signer.deviceId);
			if (removed === "group")
				f.db.prepare("DELETE FROM groups WHERE group_id=?").run(signer.groupId);
			const before = snapshot(f, [completions]);
			// Act
			const result = await f.store.createLegacyTeamCompletion(futureGroup, value);
			// Assert
			expect(result).toEqual({ status: "created", manifest: value });
			expect(snapshot(f, [completions])).toEqual(before);
		},
	);

	test(`${kind} one valid original source suffices despite an extra failed same-owner receipt`, async ({
		fixture: f,
	}) => {
		// Arrange: the extra row is valid metadata but names no surviving controller.
		const { value } = await recovery(f, kind);
		const columns = f.db.prepare(`PRAGMA table_info(${resolutions})`).all() as { name: string }[];
		f.db
			.prepare(`INSERT INTO ${resolutions} (${columns.map(({ name }) => name).join(",")})
			SELECT ${columns
				.map(({ name }) => {
					if (name === "resolution_id") return "'failed-extra-resolution'";
					if (name === "source_attestation_id") return "'missing-extra-controller'";
					return name;
				})
				.join(",")} FROM ${resolutions}`)
			.run();
		const before = snapshot(f, [completions]);
		// Act
		const result = await f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert
		expect(result).toEqual({ status: "created", manifest: value });
		expect(snapshot(f, [completions])).toEqual(before);
	});

	test(`${kind} occupied slot remains exact-retry-only after recovery`, async ({ fixture: f }) => {
		// Arrange: an OLD accepted completion is immutable, not a recovery target.
		const { value } = await recovery(f, kind);
		const old = manifest(f, "identity-b");
		f.db
			.prepare(`INSERT INTO ${completions}
			(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
			VALUES (?,?,1,?,?,?)`)
			.run(futureGroup, old.candidate_ref, canonical(old), now, now);
		const before = snapshot(f);
		// Act
		const pending = f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert
		await expect(pending).rejects.toMatchObject({ code: "completion_conflict" });
		expect(await f.store.createLegacyTeamCompletion(futureGroup, old)).toEqual({
			status: "existing",
			manifest: old,
		});
		expect(snapshot(f)).toEqual(before);
	});

	test(`${kind} stored canonical retry ignores later current owner conflict`, async ({
		fixture: f,
	}) => {
		// Arrange: seed the winner independently so retry is testable before recovery lands.
		const { value } = await recovery(f, kind);
		f.db
			.prepare(`INSERT INTO ${completions}
			(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
			VALUES (?,?,1,?,?,?)`)
			.run(futureGroup, value.candidate_ref, canonical(value), now, now);
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id='identity-c' WHERE group_id=?")
			.run(futureGroup);
		const before = snapshot(f);
		// Act
		const result = await f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert
		expect(result).toEqual({ status: "existing", manifest: value });
		expect(snapshot(f)).toEqual(before);
	});
}
