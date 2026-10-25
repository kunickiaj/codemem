import { env } from "cloudflare:workers";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readConnectionSchemaState } from "../../core/src/coordinator-account-connection-schema.js";
import type { CoordinatorAuthControllerReviewInput } from "../../core/src/coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { CoordinatorDeviceOwnershipEvidence } from "../../core/src/coordinator-device-ownership-evidence.js";
import { ed25519KeyIdForRevocation } from "../../core/src/coordinator-ed25519-key-id-compat.js";
import {
	commitReviewedOwnerResolution,
	type InternalOwnerResolutionReview,
} from "../../core/src/coordinator-legacy-owner-resolution-commit.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "../../core/src/coordinator-legacy-team-completion.js";
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
type Definition = { type: string; name: string; sql: string };
type Fixture = Awaited<ReturnType<typeof setup>>;
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
let initialDefinitions: Definition[] | undefined;

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

async function exec(sql: string, ...values: AuthLinkStatement["values"]) {
	return db
		.prepare(sql)
		.bind(...values)
		.run();
}
async function rows(table: string) {
	// Catalog-derived names only. Sorting full rows also supports every WITHOUT ROWID table.
	const result = await db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all();
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
	// Ephemeral test storage only: restore the complete captured graph between cases,
	// never DELETE immutable resolutions or bypass any V3/0036/0037 guard during an operation.
	const current = await definitions();
	if (!initialDefinitions) initialDefinitions = current;
	else {
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
	const { publicKey: key } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(key.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length, 0);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")} synthetic-current`;
	return {
		groupId: origin.signer.groupId,
		deviceId: "resolution-current",
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
	};
}
async function setup(options: { weakCurrent?: boolean } = {}) {
	await reset();
	const hooks: {
		beforeBatch?: () => Promise<void>;
		mapStatement?: (statement: AuthLinkStatement) => AuthLinkStatement;
		afterBatch?: () => void;
		beforeFirst?: (statement: AuthLinkStatement) => void;
	} = {};
	const diagnostics: {
		stage: string;
		error?: unknown;
		statements: AuthLinkStatement[];
		batches: number;
	} = { stage: "setup", statements: [], batches: 0 };
	const prepare = ({ sql, values }: AuthLinkStatement) => db.prepare(sql).bind(...values);
	const backend: AuthLinkBackend = {
		async first<T>(statement: AuthLinkStatement) {
			hooks.beforeFirst?.(statement);
			try {
				return await prepare(statement).first<T>();
			} catch (error) {
				diagnostics.stage = `first: ${statement.sql}`;
				diagnostics.error = error;
				throw error;
			}
		},
		async run(statement) {
			return (await prepare(statement).run()).meta.changes;
		},
		async batch(statements) {
			diagnostics.batches++;
			await hooks.beforeBatch?.();
			diagnostics.statements = statements.map(
				(statement) => hooks.mapStatement?.(statement) ?? statement,
			);
			try {
				const result = await db.batch(diagnostics.statements.map(prepare));
				hooks.afterBatch?.();
				return result.map((row) => row.meta.changes);
			} catch (error) {
				diagnostics.stage = "native batch";
				diagnostics.error = error;
				throw error;
			}
		},
	};
	const store = new D1CoordinatorStore(db, { authClock: () => NOW });
	// Real accepted claim -> browser proof -> finalized link -> V3 migration proof.
	// The synthetic verified provider result is stored locally; no provider is contacted.
	await changeFixture(store, backend);
	const signer = laptop();
	await store.enrollDevice(signer.groupId, signer);
	await history(signer);
	if (options.weakCurrent)
		await exec(
			"UPDATE enrolled_devices SET identity_id='identity-c' WHERE device_id=?",
			signer.deviceId,
		);
	expect(await readConnectionSchemaState(backend)).toBe("ready");
	diagnostics.batches = 0;
	const evidence = new CoordinatorDeviceOwnershipEvidence(
		{
			first: backend.first,
			async all<T>(statement: AuthLinkStatement) {
				return (await prepare(statement).all<T>()).results;
			},
		},
		config,
	);
	return { store, signer, backend, evidence, hooks, diagnostics };
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
function ordinary(
	signer: ReturnType<typeof laptop>,
	changes: Partial<CoordinatorAuthControllerReviewInput> = {},
): CoordinatorAuthControllerReviewInput {
	return {
		...signer,
		coordinatorId: config.coordinatorId,
		identityId: origin.identityId,
		attestationId: "original-controller",
		reviewReceiptId: "original-receipt",
		evidenceDigest: "e".repeat(64),
		...changes,
	};
}
async function originalController(f: Fixture, options: { oldGroup?: boolean } = {}) {
	let signer = f.signer;
	if (options.oldGroup) {
		signer = { ...signer, groupId: "old-source", publicKey: `${signer.publicKey} original-alias` };
		await f.store.createGroup(signer.groupId);
		await f.store.enrollDevice(signer.groupId, signer);
	}
	const result = await f.store.createAuthControllerAttestation(ordinary(signer));
	if (result.kind !== "created") throw new Error("native ordinary source rejected");
	return result.attestation;
}
async function buildReview(
	f: Fixture,
	options: Partial<
		Pick<
			InternalOwnerResolutionReview,
			"existingController" | "existingResolution" | "resolutionId"
		>
	> = {},
): Promise<InternalOwnerResolutionReview> {
	// Weak C correctly fails the ordinary target reader. Resolve the real account
	// generation using its original proved signer, not a fabricated link row.
	const target = await f.store.readAccountOwnerTarget(
		{ targetIdentityId: origin.identityId, signer: origin.signer },
		config,
	);
	if (target.kind !== "ready") throw new Error("native original birth proof unavailable");
	const enrollment = await db
		.prepare("SELECT identity_id FROM enrolled_devices WHERE group_id=? AND device_id=?")
		.bind(f.signer.groupId, f.signer.deviceId)
		.first<{ identity_id: string | null }>();
	if (!enrollment) throw new Error("native current enrollment missing");
	const controllerReview = ordinary(f.signer, {
		attestationId: "resolution-controller",
		reviewReceiptId: "resolution-controller-receipt",
		evidenceDigest: "d".repeat(64),
		verifiedSnapshot: {
			enrollmentIdentityId: enrollment.identity_id,
			invites: [],
			legacyHistory: await f.store.captureAuthControllerLegacyHistory({
				coordinatorId: config.coordinatorId,
				...f.signer,
			}),
			accountOwnerTarget: {
				purpose: "existing_account_owner",
				coordinatorId: config.coordinatorId,
				targetIdentityId: origin.identityId,
				issuer: config.issuer,
				linkId: target.linkId,
				authConfigRevision: target.currentGeneration.authConfigRevision,
				createdAtMs: target.currentGeneration.createdAtMs,
			},
		},
	});
	const verifiedHistory = controllerReview.verifiedSnapshot?.legacyHistory;
	if (!verifiedHistory) throw new Error("native review history unavailable");
	const collection = await f.evidence.collect({
		canonicalOwnerId: origin.identityId,
		actualSigner: { ...f.signer },
		verifiedHistory,
	});
	if (collection.kind !== "collected") throw new Error("native ownership evidence unavailable");
	const ownershipEvidenceDigest = await f.evidence.reviewedEvidenceDigest(
		collection.recheckSnapshot,
	);
	if (!ownershipEvidenceDigest || !/^[a-f0-9]{64}$/u.test(ownershipEvidenceDigest))
		throw new Error("native ownership evidence digest unavailable");
	const digest = createHash("sha256")
		.update(JSON.stringify({ controllerReview, ownershipEvidenceDigest, ...options }))
		.digest("hex");
	return {
		controllerReview,
		ownershipEvidenceDigest,
		existingController: options.existingController ?? null,
		existingResolution: options.existingResolution ?? null,
		resolutionId: options.resolutionId ?? "resolution-a",
		consent: {
			purpose: "existing_account_owner",
			scope: "historical_included_owner_labels_only",
			evidenceDigest: digest,
			confirmedDigest: digest,
		},
	};
}
async function commit(f: Fixture, review: InternalOwnerResolutionReview) {
	try {
		return await commitReviewedOwnerResolution({
			backend: f.backend,
			evidence: f.evidence,
			review,
			now,
		});
	} catch (error) {
		// Production deliberately normalizes failures. Preserve the actual native stage
		// and stack in test failures without adding production logging or changing SQL.
		throw new Error(`${String(error)}; ${f.diagnostics.stage}`, {
			cause: f.diagnostics.error ?? error,
		});
	}
}
async function revoke(signer: ReturnType<typeof laptop>, kind: "device_id" | "ed25519_key") {
	await exec(
		"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?)",
		kind,
		kind === "device_id" ? signer.deviceId : await ed25519KeyIdForRevocation(signer.publicKey),
		`revocation-${kind}`,
		signer.groupId,
		signer.deviceId,
		signer.publicKey,
		signer.fingerprint,
		now,
	);
}
function isWinner(sql: string, table: string) {
	const columns =
		new RegExp(`INSERT INTO ${table}\\s*\\(([^)]+)\\)`)
			.exec(sql)?.[1]
			?.split(",")
			.map((column) => column.trim()) ?? [];
	if (table === controllerTable)
		return (
			columns.length === 13 &&
			columns.includes("enrollment_identity_id") &&
			columns.includes("revoked_at")
		);
	return (
		columns.length === 20 &&
		/SELECT json_extract\(value,/u.test(sql) &&
		/FROM \(SELECT \? AS value\)\s*$/u.test(sql)
	);
}

async function consumedInvite(
	signer: ReturnType<typeof laptop>,
	options: { kind: "project_share" | "team_member"; label: string },
) {
	await exec(
		`INSERT INTO coordinator_invites
		(invite_id,group_id,token,policy,created_at,expires_at,consumed_at,revoked_at,
		bound_device_id,bound_public_key,bound_fingerprint,invite_kind,
		assigned_identity_id,target_identity_id,recipient_actor_id,reviewed_preview_digest)
		VALUES ('freshness-invite',?,?,'open',?,?,?,NULL,?,?,?,?,?,NULL,?,?)`,
		signer.groupId,
		"synthetic-freshness-token",
		new Date(NOW - 1000).toISOString(),
		new Date(NOW + 60000).toISOString(),
		now,
		signer.deviceId,
		signer.publicKey,
		signer.fingerprint,
		options.kind,
		options.kind === "team_member" ? options.label : null,
		options.label,
		"f".repeat(64),
	);
}

async function ownerInvites(f: Fixture) {
	// Match the ordinary review's bound owner-invitation projection, not all
	// consumed Project rows or discovery candidates for another device/key.
	return (await f.store.listInvites(f.signer.groupId)).filter(
		(invite) =>
			invite.group_id === f.signer.groupId &&
			invite.revoked_at === null &&
			!!invite.consumed_at &&
			(invite.invite_kind === "team_member" || invite.invite_kind === "add_device") &&
			invite.bound_device_id === f.signer.deviceId &&
			invite.bound_public_key === f.signer.publicKey &&
			invite.bound_fingerprint === f.signer.fingerprint,
	);
}

it("native consumed Project actor arriving before writer collection rejects the reviewed digest without a batch", async () => {
	// Arrange: retain the original confirmation while only weak evidence changes.
	const f = await setup({ weakCurrent: true });
	const review = await buildReview(f);
	const expectedDigest = review.ownershipEvidenceDigest;
	const originalOwnerInvites = await ownerInvites(f);
	const before = await snapshot(["coordinator_invites"]);
	await consumedInvite(f.signer, { kind: "project_share", label: "identity-d" });
	const injected = await snapshot();
	const fresh = await buildReview(f);
	const verifiedHistory = review.controllerReview.verifiedSnapshot?.legacyHistory;
	if (!verifiedHistory) throw new Error("native reviewed history missing");
	const collected = await f.evidence.collect({
		canonicalOwnerId: origin.identityId,
		actualSigner: { ...f.signer },
		verifiedHistory,
	});
	// Act: the writer must compare fresh evidence with the old, unchanged hash.
	const pending = commit(f, review);
	// Assert: this is valid new weak evidence, not malformed proof or changed history.
	await expect(pending).rejects.toThrow(/outcome is unavailable/u);
	expect(collected).toMatchObject({
		kind: "collected",
		decision: "weak_label_review_required",
		weakLabels: expect.arrayContaining([
			expect.objectContaining({ label: "identity-d", kind: "consumed_project_actor_label" }),
		]),
	});
	expect(fresh.ownershipEvidenceDigest).not.toBe(expectedDigest);
	expect(review.ownershipEvidenceDigest).toBe(expectedDigest);
	expect(fresh.controllerReview.verifiedSnapshot?.legacyHistory).toEqual(verifiedHistory);
	expect(await ownerInvites(f)).toEqual(originalOwnerInvites);
	expect(fresh.controllerReview.verifiedSnapshot?.invites).toEqual(
		review.controllerReview.verifiedSnapshot?.invites,
	);
	expect(f.diagnostics.batches).toBe(0);
	expect(await rows(controllerTable)).toEqual([]);
	expect(await rows(resolutionTable)).toEqual([]);
	expect(await rows("coordinator_invites")).toHaveLength(1);
	expect(await snapshot()).toEqual(injected);
	expect(await snapshot(["coordinator_invites"])).toEqual(before);
});

it("native valid unrelated Unicode/junk discovery candidate preserves the reviewed digest and commits", async () => {
	// Arrange: another canonical key remains unrelated even when SQL discovers its text.
	const f = await setup({ weakCurrent: true });
	const review = await buildReview(f);
	const originalOwnerInvites = await ownerInvites(f);
	const verifiedHistory = review.controllerReview.verifiedSnapshot?.legacyHistory;
	if (!verifiedHistory) throw new Error("native reviewed history missing");
	const originalCollection = await f.evidence.collect({
		canonicalOwnerId: origin.identityId,
		actualSigner: { ...f.signer },
		verifiedHistory,
	});
	if (originalCollection.kind !== "collected")
		throw new Error("native original evidence unavailable");
	const originalAtomic = f.evidence.prepareAtomicRecheck(originalCollection.recheckSnapshot);
	const other = laptop();
	const publicKey = `\u2003${other.publicKey.replace(" ", "\u00a0!")}\u2003`;
	const otherKeyId = await ed25519KeyIdForRevocation(publicKey);
	expect(otherKeyId).toMatch(/^[a-f0-9]{64}$/u);
	expect(otherKeyId).toBe(await ed25519KeyIdForRevocation(other.publicKey));
	expect(otherKeyId).not.toBe(await ed25519KeyIdForRevocation(f.signer.publicKey));
	expect(otherKeyId).not.toBe(await ed25519KeyIdForRevocation(origin.signer.publicKey));
	await consumedInvite(
		{
			...other,
			deviceId: "unrelated-device-b",
			publicKey,
			fingerprint: fingerprintPublicKey(publicKey),
		},
		{ kind: "team_member", label: "identity-b" },
	);
	const injected = await snapshot(receipts);
	const fresh = await buildReview(f);
	const collected = await f.evidence.collect({
		canonicalOwnerId: origin.identityId,
		actualSigner: { ...f.signer },
		verifiedHistory,
	});
	if (collected.kind !== "collected") throw new Error("native unrelated fixture unavailable");
	const freshDigest = await f.evidence.reviewedEvidenceDigest(collected.recheckSnapshot);
	const oldAtomicAfterInvite = await f.backend.first(originalAtomic);
	// Act: the original confirmation must still work with the newly collected atomic snapshot.
	const result = await commit(f, review);
	// Assert: candidate discovery is not ownership and does not churn human confirmation.
	expect(oldAtomicAfterInvite).toEqual({ matches: 0 });
	expect(collected.decision).toBe("weak_label_review_required");
	expect(freshDigest).toBe(review.ownershipEvidenceDigest);
	expect(fresh.ownershipEvidenceDigest).toBe(review.ownershipEvidenceDigest);
	expect(fresh.controllerReview.verifiedSnapshot?.legacyHistory).toEqual(verifiedHistory);
	expect(await ownerInvites(f)).toEqual(originalOwnerInvites);
	expect(result).toMatchObject({
		controllerDisposition: "created",
		resolutionDisposition: "created",
	});
	expect(f.diagnostics.batches).toBe(1);
	expect(await rows(controllerTable)).toEqual([result.controller]);
	expect(await rows(resolutionTable)).toEqual([result.resolution]);
	expect(await snapshot(receipts)).toEqual(injected);
});

it("native weak-current C creates both receipts but grants no ordinary account authority", async () => {
	// Arrange
	const f = await setup({ weakCurrent: true });
	const review = await buildReview(f);
	const before = await snapshot(receipts);
	const ordinaryBefore = await f.store.readAccountLinkStatus(f.signer, config, {
		identityId: origin.identityId,
	});
	// Act
	const ordinaryCreate = await f.store.createAuthControllerAttestation(review.controllerReview);
	const result = await commit(f, review);
	const ordinaryAfter = await f.store.readAccountLinkStatus(f.signer, config, {
		identityId: origin.identityId,
	});
	const target = await f.store.readAccountOwnerTarget(
		{ targetIdentityId: origin.identityId, signer: f.signer },
		config,
	);
	// Assert: only the explicit writer has the narrow weak-label exception.
	expect(ordinaryCreate.kind).toBe("rejected");
	expect(result).toMatchObject({
		controllerDisposition: "created",
		resolutionDisposition: "created",
		controller: { identity_id: origin.identityId, enrollment_identity_id: "identity-c" },
	});
	expect(Object.keys(result.resolution)).toHaveLength(20);
	expect(JSON.parse(result.resolution.reviewed_weak_labels_json).length).toBeGreaterThan(0);
	expect(await rows(controllerTable)).toEqual([result.controller]);
	expect(await rows(resolutionTable)).toEqual([result.resolution]);
	expect(ordinaryAfter).toEqual(ordinaryBefore);
	expect(target).toEqual({ kind: "unavailable" });
	expect(f.diagnostics.batches).toBe(1);
	expect(await snapshot(receipts)).toEqual(before);
});

it("native ordinary A controller is reused only with fresh resolution consent", async () => {
	// Arrange
	const f = await setup();
	const original = await originalController(f);
	const review = await buildReview(f, { existingController: original });
	const before = await snapshot([resolutionTable]);
	// Act
	const result = await commit(f, review);
	// Assert
	expect(result.controllerDisposition).toBe("reused");
	expect(result.resolutionDisposition).toBe("created");
	expect(result.controller).toEqual(original);
	expect(result.resolution.source_evidence_digest).toBe(original.evidence_digest);
	expect(result.resolution.source_review_receipt_id).toBe(original.review_receipt_id);
	expect(await snapshot([resolutionTable])).toEqual(before);
});

it("native exact retry preserves all 20 original resolution fields after more weak history", async () => {
	// Arrange
	const f = await setup();
	const first = await commit(f, await buildReview(f));
	await history(f.signer, "history-d", "identity-d");
	const review = await buildReview(f, {
		existingController: first.controller,
		existingResolution: first.resolution,
	});
	const before = await snapshot();
	// Act
	const retry = await commit(f, review);
	// Assert
	expect(review.consent.evidenceDigest).not.toBe(first.resolution.resolution_evidence_digest);
	expect(retry).toEqual({
		...first,
		controllerDisposition: "reused",
		resolutionDisposition: "reused",
	});
	expect(await snapshot()).toEqual(before);
});

it("native missing fresh consent cannot reuse an ordinary controller", async () => {
	// Arrange
	const f = await setup();
	const review = await buildReview(f, { existingController: await originalController(f) });
	review.consent.confirmedDigest = "0".repeat(64);
	const before = await snapshot();
	// Act
	const pending = commit(f, review);
	// Assert
	await expect(pending).rejects.toThrow(/outcome is unavailable/u);
	expect(f.diagnostics.batches).toBe(0);
	expect(await snapshot()).toEqual(before);
});

it.each(["device", "canonical key"] as const)(
	"native strong B authority for the same %s denies resolution consent",
	async (family) => {
		// Arrange
		const f = await setup();
		const review = await buildReview(f);
		const b = {
			...f.signer,
			groupId: "strong-b",
			deviceId: family === "device" ? f.signer.deviceId : "alias-device",
			publicKey: family === "device" ? origin.signer.publicKey : `${f.signer.publicKey} B-alias`,
		};
		await f.store.createGroup(b.groupId);
		await f.store.enrollDevice(b.groupId, b);
		expect(
			await f.store.createAuthControllerAttestation(
				ordinary(b, { identityId: "identity-b", attestationId: "strong-b" }),
			),
		).toMatchObject({ kind: "created" });
		const before = await snapshot();
		// Act
		const pending = commit(f, review);
		// Assert
		await expect(pending).rejects.toThrow(/outcome is unavailable/u);
		expect(await snapshot()).toEqual(before);
	},
);

it.each(["device_id", "ed25519_key"] as const)(
	"native late current %s revocation denies every sibling write",
	async (kind) => {
		// Arrange
		const f = await setup();
		const review = await buildReview(f);
		let injected: Snapshot | undefined;
		f.hooks.beforeBatch = async () => {
			await revoke(f.signer, kind);
			injected = await snapshot();
		};
		// Act
		const pending = commit(f, review);
		// Assert
		await expect(pending).rejects.toThrow(/outcome is unavailable/u);
		expect(injected).toBeDefined();
		expect(await snapshot()).toEqual(injected);
	},
);

it("native origin device and key retirement alone do not revoke account A", async () => {
	// Arrange
	const f = await setup();
	const review = await buildReview(f);
	await revoke(origin.signer, "device_id");
	await revoke(origin.signer, "ed25519_key");
	const before = await snapshot(receipts);
	// Act
	const result = await commit(f, review);
	// Assert
	expect(result.controller.identity_id).toBe(origin.identityId);
	expect(result.resolutionDisposition).toBe("created");
	expect(await snapshot(receipts)).toEqual(before);
});

it.each([
	["history", "UPDATE coordinator_legacy_team_completions SET created_at='changed'"],
	["current group", "UPDATE groups SET archived_at='changed' WHERE group_id='group-a'"],
	["link generation", "UPDATE coordinator_auth_account_links SET created_at_ms=created_at_ms+1"],
] as const)(
	"native late %s change before actual batch aborts without sibling writes",
	async (_label, mutation) => {
		// Arrange
		const f = await setup();
		const review = await buildReview(f);
		let injected: Snapshot | undefined;
		f.hooks.beforeBatch = async () => {
			await exec(mutation);
			injected = await snapshot();
		};
		// Act
		const pending = commit(f, review);
		// Assert
		await expect(pending).rejects.toThrow(/outcome is unavailable/u);
		expect(f.diagnostics.batches).toBe(1);
		expect(injected).toBeDefined();
		expect(await snapshot()).toEqual(injected);
	},
);

it.each(receipts)(
	"native zero-row %s winner forces checked rollback and preserves old source",
	async (table) => {
		// Arrange: alter the real INSERT predicate, not JS change counts or the schema.
		const f = await setup();
		const old = await originalController(f, { oldGroup: true });
		const review = await buildReview(f);
		let mapped = 0;
		f.hooks.mapStatement = (statement) => {
			if (!isWinner(statement.sql, table)) return statement;
			mapped++;
			const conjunction = table === controllerTable ? "AND" : "WHERE";
			return { ...statement, sql: `${statement.sql} ${conjunction} 0=1` };
		};
		const before = await snapshot();
		// Act
		const pending = commit(f, review);
		// Assert: native changes() plus invalid-INSERT sentinels really abort the batch.
		await expect(pending).rejects.toThrow(/outcome is unavailable/u);
		expect(mapped).toBe(1);
		expect(f.diagnostics.batches).toBe(1);
		expect(String(f.diagnostics.error)).toMatch(/constraint|legacy_owner_resolution/u);
		expect(await snapshot()).toEqual(before);
		expect(await rows(controllerTable)).toEqual([old]);
	},
);

it("native resolution constraint failure rolls back the new controller, retaining old source bytes", async () => {
	// Arrange: no attached trigger; the original bound values and ready-schema checks survive.
	const f = await setup();
	const old = await originalController(f, { oldGroup: true });
	const review = await buildReview(f);
	let mapped = 0;
	f.hooks.mapStatement = (statement) => {
		if (!isWinner(statement.sql, resolutionTable)) return statement;
		mapped++;
		return {
			...statement,
			sql: statement.sql.replace("json_extract(value,'$.purpose')", "'invalid-purpose'"),
		};
	};
	const before = await snapshot();
	// Act
	const pending = commit(f, review);
	// Assert
	await expect(pending).rejects.toThrow(/outcome is unavailable/u);
	expect(mapped).toBe(1);
	expect(String(f.diagnostics.error)).toMatch(/CHECK constraint failed: purpose/u);
	expect(await snapshot()).toEqual(before);
	expect(await rows(controllerTable)).toEqual([old]);
});

it.each(["revoked", "missing"] as const)(
	"native %s source pin denies reuse without repairing the source",
	async (kind) => {
		// Arrange
		const f = await setup();
		const old = await originalController(f);
		const review = await buildReview(f, { existingController: old });
		if (kind === "revoked") await exec(`UPDATE ${controllerTable} SET revoked_at=?`, now);
		else await exec(`DELETE FROM ${controllerTable}`);
		const before = await snapshot();
		// Act
		const pending = commit(f, review);
		// Assert
		await expect(pending).rejects.toThrow(/outcome is unavailable/u);
		expect(await snapshot()).toEqual(before);
	},
);

it("native removed old source group still allows reuse through an eligible current group", async () => {
	// Arrange
	const f = await setup();
	const old = await originalController(f, { oldGroup: true });
	await exec("DELETE FROM enrolled_devices WHERE group_id=?", old.group_id);
	await exec("DELETE FROM groups WHERE group_id=?", old.group_id);
	const review = await buildReview(f, { existingController: old });
	const before = await snapshot([resolutionTable]);
	// Act
	const result = await commit(f, review);
	// Assert
	expect(result.controllerDisposition).toBe("reused");
	expect(result.controller).toEqual(old);
	expect(result.resolution.source_public_key).toBe(old.public_key);
	expect(result.resolution.source_group_id).toBe(old.group_id);
	expect(await snapshot([resolutionTable])).toEqual(before);
});

it("native postcommit read failure throws unknown outcome while both receipts remain committed", async () => {
	// Arrange
	const f = await setup();
	const review = await buildReview(f);
	const before = await snapshot(receipts);
	f.hooks.afterBatch = () => {
		f.hooks.beforeFirst = () => {
			throw new Error("synthetic postcommit read failure");
		};
	};
	// Act
	const pending = commit(f, review);
	// Assert: an unavailable read does not mean rollback.
	await expect(pending).rejects.toThrow(/check its status before retrying/u);
	expect(await rows(controllerTable)).toHaveLength(1);
	expect(await rows(resolutionTable)).toHaveLength(1);
	expect(await snapshot(receipts)).toEqual(before);
});
