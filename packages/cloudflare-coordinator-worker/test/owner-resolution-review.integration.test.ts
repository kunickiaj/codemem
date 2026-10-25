import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { ed25519KeyIdForRevocation } from "../../core/src/coordinator-ed25519-key-id-compat.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "../../core/src/coordinator-legacy-team-completion.js";
import {
	type OwnerResolutionReviewBackend,
	OwnerResolutionReviewOperations,
	type OwnerResolutionReviewResult,
} from "../../core/src/coordinator-owner-resolution-review.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { legacyTeamCandidateId } from "../../core/src/recipient-policy-identifiers.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { changeFixture, config, NOW, input as origin } from "./account-change-fixture.js";
import { resetCeremony } from "./owner-ceremony-test-fixtures.js";

const db = env.COORDINATOR_DB;
const now = new Date(NOW).toISOString();
const controllerTable = "coordinator_auth_controller_attestations";
const resolutionTable = "coordinator_legacy_owner_resolutions";
const receipts = [controllerTable, resolutionTable];
const scope = "historical_included_owner_labels_only";
type Definition = { type: string; name: string; sql: string };
type Fixture = Awaited<ReturnType<typeof setup>>;
let initialDefinitions: Definition[] | undefined;

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => vi.restoreAllMocks());

async function exec(sql: string, ...values: AuthLinkStatement["values"]) {
	return db
		.prepare(sql)
		.bind(...values)
		.run();
}
async function rows(table: string) {
	const result = await db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();
	// Full-row sorting includes WITHOUT ROWID tables without assuming a rowid.
	return result.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function snapshot(except: string[] = []) {
	const tables = await db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all<{ name: string }>();
	return Promise.all(
		tables.results
			.filter(({ name }) => !name.startsWith("_cf_") && !except.includes(name))
			.map(async ({ name }) => ({ table: name, rows: await rows(name) })),
	);
}
async function definitions() {
	return (
		await db
			.prepare(`SELECT type,name,sql FROM sqlite_master
		WHERE (tbl_name GLOB 'coordinator_auth_*' OR tbl_name IN ('coordinator_account_change_attempts','coordinator_legacy_owner_resolutions'))
		AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name`)
			.all<Definition>()
	).results;
}
async function reset() {
	const current = await definitions();
	if (!initialDefinitions) initialDefinitions = current;
	else {
		// Ephemeral fixture reset only; all schema guards remain installed during operations.
		await resetCeremony();
		await db.batch([
			...current
				.filter(({ type }) => type === "table")
				.map(({ name }) => db.prepare(`DROP TABLE "${name}"`)),
			...initialDefinitions.map(({ sql }) => db.prepare(sql)),
		]);
	}
	await exec("DELETE FROM coordinator_legacy_team_completions");
	await exec("DELETE FROM coordinator_invites");
	expect(await definitions()).toEqual(initialDefinitions);
}
function laptop() {
	// Public synthetic Ed25519 wire key, distinct from the account's original signer.
	const kind = Buffer.from("ssh-ed25519");
	const raw = Buffer.alloc(32, 19);
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length, 0);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")} synthetic-current`;
	return {
		groupId: origin.signer.groupId,
		deviceId: "review-current",
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
	};
}
async function history(
	signer: ReturnType<typeof laptop>,
	groupId = "history-c",
	identityId = "identity-c",
) {
	const record = normalize({
		version: 1,
		coordinator_id: config.coordinatorId,
		candidate_ref: legacyTeamCandidateId(config.coordinatorId, groupId),
		candidate_digest: "a".repeat(64),
		team_id: `team-${groupId}`,
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic historical owner",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: identityId, role: "member" }],
		device_decisions: [
			{
				device_id: signer.deviceId,
				key_fingerprint: signer.fingerprint,
				enabled: true,
				identity_id: identityId,
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: now,
	});
	await exec(
		"INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?,?,1,?,?,?)",
		groupId,
		record.candidate_ref,
		canonical(record),
		now,
		now,
	);
}
async function setup(options: { weakCurrent?: boolean } = {}) {
	await reset();
	const diagnostics: { stage: string; error?: unknown; batches: number; runs: number } = {
		stage: "setup",
		batches: 0,
		runs: 0,
	};
	const hooks: { beforeFirst?: (statement: AuthLinkStatement) => void } = {};
	const prepare = ({ sql, values }: AuthLinkStatement) => db.prepare(sql).bind(...values);
	async function read<T>(
		statement: AuthLinkStatement,
		options: { mode: "first" | "all" },
	): Promise<T> {
		try {
			if (options.mode === "all") return (await prepare(statement).all()).results as T;
			hooks.beforeFirst?.(statement);
			return (await prepare(statement).first()) as T;
		} catch (error) {
			diagnostics.stage = `${options.mode}: ${statement.sql}`;
			diagnostics.error = error;
			throw error;
		}
	}
	const backend: OwnerResolutionReviewBackend = {
		first: <T>(statement: AuthLinkStatement) => read<T | null>(statement, { mode: "first" }),
		all: <T>(statement: AuthLinkStatement) => read<T[]>(statement, { mode: "all" }),
		async run(statement) {
			diagnostics.runs++;
			return (await prepare(statement).run()).meta.changes;
		},
		async batch(statements) {
			diagnostics.batches++;
			try {
				return (await db.batch(statements.map(prepare))).map((row) => row.meta.changes);
			} catch (error) {
				diagnostics.stage = "native batch";
				diagnostics.error = error;
				throw error;
			}
		},
	};
	const store = new D1CoordinatorStore(db, { authClock: () => NOW });
	// Local verified provider fixture creates the actual claim/browser/finalization birth.
	const birth = await changeFixture(store, backend);
	const signer = laptop();
	await store.enrollDevice(signer.groupId, signer);
	await history(signer);
	if (options.weakCurrent !== false)
		await exec(
			"UPDATE enrolled_devices SET identity_id='identity-c' WHERE device_id=?",
			signer.deviceId,
		);
	diagnostics.batches = 0;
	diagnostics.runs = 0;
	const selection = {
		groupId: signer.groupId,
		deviceId: signer.deviceId,
		identityId: origin.identityId,
		fingerprint: signer.fingerprint,
	};
	const operations = new OwnerResolutionReviewOperations(backend, () => NOW);
	return { store, signer, backend, hooks, diagnostics, selection, operations, birth };
}
async function preview(f: Fixture) {
	const result = await f.operations.previewOwnerResolutionReview(f.selection, config);
	// Expose the native SQL stage and stack instead of hiding a compiler failure as needs_review.
	if (f.diagnostics.error) throw new Error(f.diagnostics.stage, { cause: f.diagnostics.error });
	return result;
}
async function confirm(f: Fixture, result: OwnerResolutionReviewResult) {
	return f.operations.confirmOwnerResolutionReview(
		{ ...f.selection, confirmOwnerResolutionDigest: result.owner_resolution_digest },
		config,
	);
}
function safe(result: OwnerResolutionReviewResult, f: Fixture) {
	const text = JSON.stringify(result);
	expect(text).not.toMatch(
		/public_key|publicKey|providerSubject|email|issuer|token|ownershipEvidenceDigest|recheckSnapshot|authority/u,
	);
	expect(text).not.toContain(f.signer.publicKey);
	expect(text).not.toContain(origin.signer.publicKey);
	expect(text).not.toContain("account-A");
}
async function originalController(f: Fixture, identityId = origin.identityId) {
	const result = await f.store.createAuthControllerAttestation({
		...f.signer,
		coordinatorId: config.coordinatorId,
		identityId,
		attestationId: "original-controller",
		reviewReceiptId: "original-review",
		evidenceDigest: "e".repeat(64),
	});
	if (result.kind !== "created") throw new Error("native ordinary controller rejected");
	return result.attestation;
}
async function revoke(signer: ReturnType<typeof laptop>) {
	await exec(
		`INSERT INTO coordinator_device_revocations
		(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at)
		VALUES ('ed25519_key',?,'synthetic-revocation',?,?,?,?,?)`,
		await ed25519KeyIdForRevocation(signer.publicKey),
		signer.groupId,
		signer.deviceId,
		signer.publicKey,
		signer.fingerprint,
		now,
	);
}

async function reconnectTarget(f: Fixture) {
	// Accepted continuation fixture retains the complete original proof and archives
	// its generation. No immutable birth columns are updated or guards disabled.
	const tables = [
		"coordinator_auth_account_links",
		"coordinator_auth_link_attempts",
		"coordinator_auth_link_audit_log",
	];
	const originals = await Promise.all(tables.map(async (table) => (await rows(table))[0]));
	await f.birth.prepare();
	expect(await f.birth.operations.finalize(f.birth.proof(), config)).not.toBeNull();
	for (const [index, table] of tables.entries()) {
		const original = originals[index];
		if (!original) throw new Error("synthetic target birth missing");
		const row = { ...original, link_id: "successor-link", attempt_id: "successor-attempt" };
		if (table === "coordinator_auth_link_attempts")
			Object.assign(row, {
				prior_link_id: original.link_id,
				browser_start_hash: "1".repeat(64),
				browser_transaction_hash: "2".repeat(64),
				runtime_verifier_hash: "3".repeat(64),
				completion_secret_hash: "4".repeat(64),
			});
		const entries = Object.entries(row);
		await exec(
			`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
			...entries.map(([, value]) => value as string | number | null),
		);
	}
	await exec(
		"UPDATE coordinator_auth_account_connection_history SET successor_link_id='successor-link'",
	);
}

it("native preview separates proved A from weak current C and never writes or relaxes ordinary targets", async () => {
	// Arrange
	const f = await setup();
	const before = await snapshot();
	// Act
	const result = await preview(f);
	const ordinary = await f.store.readAccountOwnerTarget(
		{ targetIdentityId: origin.identityId, signer: f.signer },
		config,
	);
	// Assert
	expect(result).toMatchObject({
		state: "ready",
		purpose: "existing_account_owner",
		resolution_scope: scope,
		identity_id: origin.identityId,
		owner_resolution_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
	});
	const storedHistory = await rows("coordinator_legacy_team_completions");
	expect(result.legacy_history).toEqual(
		storedHistory.map((row) => ({ ...row, manifest: JSON.parse(String(row.manifest_json)) })),
	);
	expect(result.reviewed_weak_labels).toEqual(
		expect.arrayContaining([expect.objectContaining({ label: "identity-c" })]),
	);
	expect(Object.keys(result.account_owner_target ?? {}).sort()).toEqual([
		"auth_config_revision",
		"created_at_ms",
		"identity_id",
		"link_id",
	]);
	expect(ordinary.kind).not.toBe("ready");
	for (const table of receipts) expect(await rows(table)).toEqual([]);
	expect(await snapshot()).toEqual(before);
	expect(f.diagnostics).toMatchObject({ batches: 0, runs: 0 });
	safe(result, f);
});

it("native fresh confirmation creates only the two receipts and clock advance alone stays fresh", async () => {
	// Arrange
	const f = await setup();
	let clock = NOW;
	f.operations = new OwnerResolutionReviewOperations(f.backend, () => clock);
	const review = await preview(f);
	const before = await snapshot(receipts);
	clock += 60_000;
	// Act
	const fresh = await preview(f);
	const result = await confirm(f, review);
	// Assert
	expect(fresh.owner_resolution_digest).toBe(review.owner_resolution_digest);
	expect(result).toMatchObject({
		state: "ready",
		purpose: "existing_account_owner",
		resolution_scope: scope,
		owner_resolution_digest: review.owner_resolution_digest,
		recovery_receipt: { disposition: "created", evidence_digest: review.owner_resolution_digest },
		owner_resolution: {
			disposition: "created",
			evidence_digest: review.owner_resolution_digest,
			created_at: new Date(clock).toISOString(),
		},
	});
	expect(await rows(controllerTable)).toEqual([
		expect.objectContaining({
			attestation_id: result.attestation_id,
			identity_id: origin.identityId,
			enrollment_identity_id: "identity-c",
			public_key: f.signer.publicKey,
			review_receipt_id: result.recovery_receipt?.review_receipt_id,
			evidence_digest: review.owner_resolution_digest,
		}),
	]);
	expect(await rows(resolutionTable)).toEqual([
		expect.objectContaining({
			resolution_id: result.owner_resolution?.resolution_id,
			source_attestation_id: result.attestation_id,
			source_review_receipt_id: result.recovery_receipt?.review_receipt_id,
			resolution_evidence_digest: review.owner_resolution_digest,
		}),
	]);
	expect(await snapshot(receipts)).toEqual(before);
	expect(f.diagnostics).toMatchObject({ batches: 1, runs: 0 });
	safe(result, f);
});

for (const digest of [undefined, "0".repeat(64)]) {
	it(`native ${digest ? "wrong" : "missing"} confirmation creates no receipts`, async () => {
		// Arrange
		const f = await setup();
		await preview(f);
		const before = await snapshot();
		// Act / Assert
		await expect(
			f.operations.confirmOwnerResolutionReview(
				{ ...f.selection, confirmOwnerResolutionDigest: digest },
				config,
			),
		).rejects.toMatchObject({ code: "review_stale" });
		expect(await snapshot()).toEqual(before);
		expect(f.diagnostics).toMatchObject({ batches: 0, runs: 0 });
	});
}

for (const change of ["history", "Project", "enrollment key", "target generation"] as const) {
	it(`native changed ${change} rejects stale confirmation without writes`, async () => {
		// Arrange
		const f = await setup();
		const review = await preview(f);
		if (change === "history") await history(f.signer, "history-d", "identity-d");
		if (change === "Project")
			await exec(
				`INSERT INTO coordinator_invites
			(invite_id,group_id,token,policy,created_at,expires_at,consumed_at,bound_device_id,bound_public_key,bound_fingerprint,invite_kind,recipient_actor_id,reviewed_preview_digest)
			VALUES ('project-review',?,'synthetic-token','open',?,?,?,?,?,?,'project_share','identity-project',?)`,
				f.signer.groupId,
				now,
				new Date(NOW + 60_000).toISOString(),
				now,
				f.signer.deviceId,
				f.signer.publicKey,
				f.signer.fingerprint,
				"f".repeat(64),
			);
		if (change === "enrollment key")
			await exec(
				"UPDATE enrolled_devices SET public_key=?,fingerprint=? WHERE device_id=?",
				origin.signer.publicKey,
				origin.signer.fingerprint,
				f.signer.deviceId,
			);
		if (change === "target generation") await reconnectTarget(f);
		const before = await snapshot();
		const batches = f.diagnostics.batches;
		// Act
		const fresh = await preview(f);
		// Assert
		if (change !== "enrollment key") {
			expect(fresh.state, JSON.stringify(fresh)).toBe("ready");
			expect(fresh.owner_resolution_digest).not.toBe(review.owner_resolution_digest);
		} else expect(fresh.state).toBe("needs_review");
		await expect(confirm(f, review)).rejects.toMatchObject({ code: "review_stale" });
		expect(await snapshot()).toEqual(before);
		expect(f.diagnostics.batches).toBe(batches);
	});
}

it("native normal A controller retains all thirteen fields while confirmation adds only the resolution", async () => {
	// Arrange
	const f = await setup({ weakCurrent: false });
	const original = await originalController(f);
	await exec(
		"UPDATE enrolled_devices SET identity_id='identity-c' WHERE device_id=?",
		f.signer.deviceId,
	);
	const review = await preview(f);
	const before = await snapshot([resolutionTable]);
	// Act
	const result = await confirm(f, review);
	// Assert
	expect(Object.keys(original)).toHaveLength(13);
	expect(await rows(controllerTable)).toEqual([original]);
	expect(result).toMatchObject({
		attestation_id: original.attestation_id,
		recovery_receipt: {
			disposition: "reused",
			review_receipt_id: original.review_receipt_id,
			evidence_digest: original.evidence_digest,
			created_at: original.created_at,
		},
		owner_resolution: { disposition: "created", evidence_digest: review.owner_resolution_digest },
	});
	expect(await snapshot([resolutionTable])).toEqual(before);
});

it("native old empty-evidence confirmation is stale after success and preview restores actual receipts read-only", async () => {
	// Arrange
	const f = await setup();
	const review = await preview(f);
	const applied = await confirm(f, review);
	const before = await snapshot();
	const batches = f.diagnostics.batches;
	// Act / Assert
	await expect(confirm(f, review)).rejects.toMatchObject({ code: "review_stale" });
	const restored = await preview(f);
	expect(restored).toMatchObject({
		state: "restored",
		attestation_id: applied.attestation_id,
		recovery_receipt: { ...applied.recovery_receipt, disposition: "reused" },
		owner_resolution: { ...applied.owner_resolution, disposition: "reused" },
	});
	expect(restored.owner_resolution_digest).not.toBe(review.owner_resolution_digest);
	expect(await snapshot()).toEqual(before);
	expect(f.diagnostics.batches).toBe(batches);
	safe(restored, f);
});

it("native current group two restores original receipts after source enrollment and group removal without authority", async () => {
	// Arrange
	const f = await setup();
	const applied = await confirm(f, await preview(f));
	await f.store.createGroup("group-two");
	await f.store.enrollDevice("group-two", f.signer);
	await exec("UPDATE enrolled_devices SET identity_id='identity-c' WHERE group_id='group-two'");
	await exec("DELETE FROM enrolled_devices WHERE group_id=?", f.signer.groupId);
	await exec("DELETE FROM groups WHERE group_id=?", f.signer.groupId);
	const selected = { ...f.selection, groupId: "group-two" };
	const before = await snapshot();
	const batches = f.diagnostics.batches;
	// Act
	const restored = await f.operations.previewOwnerResolutionReview(selected, config);
	// Assert
	expect(restored).toMatchObject({
		state: "restored",
		group_id: "group-two",
		attestation_id: applied.attestation_id,
		recovery_receipt: { ...applied.recovery_receipt, disposition: "reused" },
		owner_resolution: { ...applied.owner_resolution, disposition: "reused" },
	});
	expect(
		await db.prepare(`SELECT * FROM ${controllerTable} WHERE group_id='group-two'`).all(),
	).toMatchObject({ results: [] });
	expect(await rows(controllerTable)).toEqual([
		expect.objectContaining({ group_id: f.signer.groupId, revoked_at: null }),
	]);
	expect(await snapshot()).toEqual(before);
	expect(f.diagnostics.batches).toBe(batches);
	safe(restored, f);
});

for (const denial of [
	"revoked source",
	"current global key revocation",
	"strong other B",
] as const) {
	it(`native ${denial} denies review and writes nothing`, async () => {
		// Arrange
		const f = await setup({ weakCurrent: denial !== "strong other B" });
		if (denial === "strong other B") await originalController(f, "identity-b");
		else {
			await confirm(f, await preview(f));
			if (denial === "revoked source")
				await exec(`UPDATE ${controllerTable} SET revoked_at=?`, now);
			else await revoke(f.signer);
		}
		const before = await snapshot();
		const batches = f.diagnostics.batches;
		// Act
		const result = await preview(f);
		// Assert
		expect(result.state).toBe("needs_review");
		expect(result).not.toHaveProperty("owner_resolution_digest");
		expect(result).not.toHaveProperty("owner_resolution");
		await expect(confirm(f, result)).rejects.toMatchObject({ code: "review_stale" });
		expect(await snapshot()).toEqual(before);
		expect(f.diagnostics.batches).toBe(batches);
	});
}

it("native retiring the distinct original account signer does not revoke A's proved account connection", async () => {
	// Arrange
	const f = await setup();
	await revoke(origin.signer);
	const before = await snapshot();
	// Act
	const result = await preview(f);
	// Assert
	expect(result.state).toBe("ready");
	expect(result.account_owner_target?.identity_id).toBe(origin.identityId);
	expect(await snapshot()).toEqual(before);
	expect(f.diagnostics).toMatchObject({ batches: 0, runs: 0 });
});

it("native a shared key alone cannot restore another device's resolution", async () => {
	// Arrange
	const f = await setup();
	await confirm(f, await preview(f));
	await f.store.enrollDevice(f.signer.groupId, { ...f.signer, deviceId: "another-device" });
	const selected = { ...f.selection, deviceId: "another-device" };
	const before = await snapshot();
	const batches = f.diagnostics.batches;
	// Act
	const result = await f.operations.previewOwnerResolutionReview(selected, config);
	// Assert
	expect(result.state).not.toBe("restored");
	expect(result).not.toHaveProperty("owner_resolution");
	expect(await snapshot()).toEqual(before);
	expect(f.diagnostics.batches).toBe(batches);
});

it("native postcommit read failure reports unknown while persisted receipts later restore without writes", async () => {
	// Arrange
	const f = await setup();
	const review = await preview(f);
	const unaffected = await snapshot(receipts);
	f.hooks.beforeFirst = () => {
		if (f.diagnostics.batches > 0) throw new Error("synthetic postcommit read failure");
	};
	// Act / Assert
	await expect(confirm(f, review)).rejects.toMatchObject({
		code: "owner_resolution_outcome_unknown",
	});
	for (const table of receipts) expect(await rows(table)).toHaveLength(1);
	expect(await snapshot(receipts)).toEqual(unaffected);
	f.hooks.beforeFirst = undefined;
	f.diagnostics.error = undefined;
	const before = await snapshot();
	const restored = await preview(f);
	const controller = (await rows(controllerTable))[0];
	const resolution = (await rows(resolutionTable))[0];
	expect(restored).toMatchObject({
		state: "restored",
		attestation_id: controller?.attestation_id,
		recovery_receipt: {
			disposition: "reused",
			review_receipt_id: controller?.review_receipt_id,
			evidence_digest: controller?.evidence_digest,
			created_at: controller?.created_at,
		},
		owner_resolution: {
			disposition: "reused",
			resolution_id: resolution?.resolution_id,
			evidence_digest: resolution?.resolution_evidence_digest,
			created_at: resolution?.created_at,
		},
	});
	expect(await snapshot()).toEqual(before);
	expect(f.diagnostics.batches).toBe(1);
});
