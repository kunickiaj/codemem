import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
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
import {
	type ResolvedAccountOwnerStatus,
	ResolvedAccountOwnerStatusOperations,
} from "../../core/src/coordinator-resolved-account-owner-status.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { legacyTeamCandidateId } from "../../core/src/recipient-policy-identifiers.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { changeFixture, config, NOW, input as origin } from "./account-change-fixture.js";
import { resetCeremony } from "./owner-ceremony-test-fixtures.js";

const db = env.COORDINATOR_DB;
const now = new Date(NOW).toISOString();
const originalIssuer = config.issuer;
const profile = {
	displayName: "Synthetic Owner A",
	email: "owner-a@example.test",
	emailVerified: true,
	pictureUrl: "https://lh3.googleusercontent.com/synthetic-owner-a",
};
const publicProfile = {
	displayName: profile.displayName,
	email: profile.email,
	pictureUrl: profile.pictureUrl,
};

/** A device running as another Identity never receives the owner's details. */
const withheldProfile = expect.toSatisfy(
	(value: unknown) => JSON.stringify(value) === "{}",
	"withheld owner profile",
);
type Definition = { type: string; name: string; sql: string };
type Fixture = Awaited<ReturnType<typeof setup>>;
let initialDefinitions: Definition[] | undefined;

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	config.issuer = "https://accounts.google.com";
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	config.issuer = originalIssuer;
	vi.restoreAllMocks();
});

async function exec(sql: string, ...values: AuthLinkStatement["values"]) {
	return db
		.prepare(sql)
		.bind(...values)
		.run();
}
async function snapshot() {
	const catalog = (
		await db
			.prepare(
				"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
			)
			.all<{ type: string; name: string; tbl_name: string; sql: string | null }>()
	).results.filter(
		({ name, tbl_name }) => !name.startsWith("_cf_") && !tbl_name.startsWith("_cf_"),
	);
	const tables = await Promise.all(
		catalog
			.filter(({ type }) => type === "table")
			.map(async ({ name }) => ({
				table: name,
				rows: (
					await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
				).results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
			})),
	);
	return { catalog, tables };
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
		// Only the ephemeral native fixture graph is reset, never a live database.
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
	// Deterministic synthetic wire key; no signing or provider network is involved.
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
		deviceId: "resolved-current",
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
async function setup(options: { fact?: boolean } = {}) {
	await reset();
	const hooks: { final?: () => Promise<void> } = {};
	const diagnostics: {
		phase: string;
		finalReads: number;
		writes: number;
		failure?: { stage: string; sql: string; error: unknown };
	} = { phase: "birth", finalReads: 0, writes: 0 };
	const prepare = ({ sql, values }: AuthLinkStatement) => db.prepare(sql).bind(...values);
	async function read<T>(statement: AuthLinkStatement, mode: "first" | "all"): Promise<T> {
		try {
			if (
				statement.sql.includes("coordinator_legacy_owner_resolutions") &&
				/coordinator_auth_(?:account|link)_profiles/u.test(statement.sql)
			) {
				diagnostics.finalReads++;
				const inject = hooks.final;
				hooks.final = undefined;
				await inject?.();
			}
			if (mode === "all") return (await prepare(statement).all()).results as T;
			return (await prepare(statement).first()) as T;
		} catch (error) {
			diagnostics.failure ??= { stage: `${diagnostics.phase}/${mode}`, sql: statement.sql, error };
			throw error;
		}
	}
	const backend = {
		first: <T>(statement: AuthLinkStatement) => read<T | null>(statement, "first"),
		all: <T>(statement: AuthLinkStatement) => read<T[]>(statement, "all"),
		async run(statement: AuthLinkStatement) {
			diagnostics.writes++;
			return (await prepare(statement).run()).meta.changes;
		},
		async batch(statements: AuthLinkStatement[]) {
			diagnostics.writes++;
			try {
				return (await db.batch(statements.map(prepare))).map((row) => row.meta.changes);
			} catch (error) {
				diagnostics.failure ??= {
					stage: `${diagnostics.phase}/batch`,
					sql: statements.map(({ sql }) => sql).join(";\n"),
					error,
				};
				throw error;
			}
		},
	};
	const store = new D1CoordinatorStore(db, { authClock: () => NOW });
	// Accepted claim, browser transaction, local verified Google result, finalization, V3 migration.
	const birth = await changeFixture(store, backend);
	await birth.prepare(1, "refresh", profile);
	expect(await birth.operations.finalize(birth.proof(1), config)).toMatchObject({
		intent: "refresh",
	});
	const signer = laptop();
	await store.enrollDevice(signer.groupId, signer);
	await history(signer);
	// The original independent source is accepted while unlabelled, before current weak C.
	const sourceSigner = {
		...signer,
		groupId: "retained-source",
		publicKey: `${signer.publicKey} original-alias`,
	};
	await store.createGroup(sourceSigner.groupId);
	await store.enrollDevice(sourceSigner.groupId, sourceSigner);
	const created = await store.createAuthControllerAttestation({
		...sourceSigner,
		coordinatorId: config.coordinatorId,
		identityId: origin.identityId,
		attestationId: "original-controller",
		reviewReceiptId: "original-review",
		evidenceDigest: "e".repeat(64),
	});
	if (created.kind !== "created") throw new Error("native retained controller rejected");
	await exec(
		"UPDATE enrolled_devices SET identity_id='identity-c' WHERE group_id=? AND device_id=?",
		signer.groupId,
		signer.deviceId,
	);
	const evidence = new CoordinatorDeviceOwnershipEvidence(backend, config);
	const f = {
		store,
		signer,
		backend,
		evidence,
		hooks,
		diagnostics,
		birth,
		controller: created.attestation,
	};
	if (options.fact !== false) {
		diagnostics.phase = "checked resolution writer";
		await checkedFact(f);
	}
	diagnostics.phase = "resolved status";
	diagnostics.writes = 0;
	return f;
}
async function checkedFact(
	f: Pick<Fixture, "store" | "signer" | "backend" | "evidence" | "controller" | "diagnostics">,
	resolutionId = "resolution-a",
) {
	const target = await f.store.readAccountOwnerTarget(
		{ targetIdentityId: origin.identityId, signer: origin.signer },
		config,
	);
	if (target.kind !== "ready") throw new Error("native actual account birth unavailable");
	const controllerReview = {
		...f.signer,
		coordinatorId: config.coordinatorId,
		identityId: origin.identityId,
		attestationId: "resolution-controller",
		reviewReceiptId: "resolution-review",
		evidenceDigest: "d".repeat(64),
		verifiedSnapshot: {
			enrollmentIdentityId: "identity-c",
			invites: [],
			legacyHistory: await f.store.captureAuthControllerLegacyHistory({
				coordinatorId: config.coordinatorId,
				...f.signer,
			}),
			accountOwnerTarget: {
				purpose: "existing_account_owner" as const,
				coordinatorId: config.coordinatorId,
				targetIdentityId: origin.identityId,
				issuer: config.issuer,
				linkId: target.linkId,
				authConfigRevision: target.currentGeneration.authConfigRevision,
				createdAtMs: target.currentGeneration.createdAtMs,
			},
		},
	};
	const collection = await f.evidence.collect({
		canonicalOwnerId: origin.identityId,
		actualSigner: { ...f.signer },
		verifiedHistory: controllerReview.verifiedSnapshot.legacyHistory,
	});
	if (collection.kind !== "collected")
		throwNativeFailure(f.diagnostics, "native writer evidence unavailable");
	if (collection.kind !== "collected") throw new Error("native writer evidence unavailable");
	const ownershipEvidenceDigest = await f.evidence.reviewedEvidenceDigest(
		collection.recheckSnapshot,
	);
	if (!ownershipEvidenceDigest) throw new Error("native private reviewed evidence digest missing");
	const digest = createHash("sha256")
		.update(JSON.stringify({ controllerReview, ownershipEvidenceDigest, resolutionId }))
		.digest("hex");
	const review: InternalOwnerResolutionReview = {
		controllerReview,
		ownershipEvidenceDigest,
		existingController: f.controller,
		existingResolution: null,
		resolutionId,
		consent: {
			purpose: "existing_account_owner",
			scope: "historical_included_owner_labels_only",
			evidenceDigest: digest,
			confirmedDigest: digest,
		},
	};
	try {
		return await commitReviewedOwnerResolution({
			backend: f.backend,
			evidence: f.evidence,
			review,
			now,
		});
	} catch (error) {
		throwNativeFailure(f.diagnostics, String(error));
		throw error;
	}
}
function throwNativeFailure(diagnostics: Fixture["diagnostics"], fallback: string): never {
	const failure = diagnostics.failure;
	if (failure)
		throw new Error(
			`native SQL stage ${failure.stage}; ${failure.sql.length} SQL bytes\n${failure.sql}`,
			{ cause: failure.error },
		);
	throw new Error(fallback);
}
async function status(f: Fixture, signer = f.signer, ownerIdentityId = origin.identityId) {
	try {
		const result = await new ResolvedAccountOwnerStatusOperations(
			f.backend,
		).readResolvedAccountOwnerStatus(signer, config, { ownerIdentityId });
		if (f.diagnostics.failure) throwNativeFailure(f.diagnostics, "native read failed");
		return result;
	} catch (error) {
		if (f.diagnostics.failure) throwNativeFailure(f.diagnostics, String(error));
		throw error;
	}
}
function displayOnly(result: ResolvedAccountOwnerStatus) {
	expect(Object.keys(result).sort()).toEqual(
		[
			"version",
			"coordinatorId",
			"groupId",
			"deviceId",
			"fingerprint",
			"state",
			"ownerIdentity",
			"profileState",
			"profile",
		].sort(),
	);
	expect(JSON.stringify(result)).not.toMatch(
		/authority|canLink|grants|actions|eligibility|publicKey|account-A|sourceRef|evidenceDigest/u,
	);
}
function undisclosed(result: ResolvedAccountOwnerStatus) {
	displayOnly(result);
	expect(result).toMatchObject({
		state: "owner_unconfirmed",
		ownerIdentity: null,
		profileState: "unavailable",
		profile: null,
	});
}
async function revoke(signer: Fixture["signer"], kind: "device_id" | "ed25519_key") {
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
async function projectLabel(f: Fixture) {
	await exec(
		`INSERT INTO coordinator_invites
	(invite_id,group_id,token,policy,created_at,expires_at,consumed_at,revoked_at,bound_device_id,bound_public_key,bound_fingerprint,invite_kind,assigned_identity_id,target_identity_id,recipient_actor_id,reviewed_preview_digest)
	VALUES ('later-project',?,?,'open',?,?,?,NULL,?,?,?,'project_share',NULL,NULL,?,?)`,
		f.signer.groupId,
		"synthetic-project-token",
		new Date(NOW - 1000).toISOString(),
		new Date(NOW + 60000).toISOString(),
		now,
		f.signer.deviceId,
		f.signer.publicKey,
		f.signer.fingerprint,
		"project-actor",
		"f".repeat(64),
	);
}
async function strongB(f: Fixture) {
	const signer = { ...f.signer, groupId: "strong-b-group" };
	await f.store.createGroup(signer.groupId);
	await f.store.enrollDevice(signer.groupId, signer);
	const result = await f.store.createAuthControllerAttestation({
		...signer,
		coordinatorId: config.coordinatorId,
		identityId: "identity-b",
		attestationId: "strong-b",
		reviewReceiptId: "strong-b-review",
		evidenceDigest: "b".repeat(64),
	});
	// Current producers refuse this conflict. Model a late historical writer directly
	// so the final status SELECT still has to detect it independently.
	expect(result.kind).toBe("rejected");
	await exec(
		`INSERT INTO coordinator_auth_controller_attestations
		(attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,
		review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at,revoked_at)
		VALUES (?,?,?,?,?,?,?,?,?,NULL,1,?,NULL)`,
		"strong-b",
		config.coordinatorId,
		"identity-b",
		signer.groupId,
		signer.deviceId,
		signer.publicKey,
		signer.fingerprint,
		"strong-b-review",
		"b".repeat(64),
		now,
	);
}

it("native exact persisted proof displays Google profile read-only without granting ordinary weak C authority", async () => {
	// Arrange: two checked writer receipts retain the same real thirteen-field source.
	// Exercise native compiler boundaries without changing pool limits or production SQL.
	expect(await db.prepare(`SELECT ${Array(100).fill("1").join("+")} AS n`).first()).toEqual({
		n: 100,
	});
	await expect(db.prepare(`SELECT ${Array(101).fill("1").join("+")} AS n`).first()).rejects.toThrow(
		/depth 100/u,
	);
	expect(
		(await db.prepare(Array(5).fill("SELECT 1 AS n").join(" UNION ALL ")).all()).results,
	).toHaveLength(5);
	await expect(
		db.prepare(Array(6).fill("SELECT 1 AS n").join(" UNION ALL ")).all(),
	).rejects.toThrow(/too many terms/u);
	const f = await setup();
	const second = await checkedFact(f, "resolution-second");
	expect(Object.keys(second.controller)).toHaveLength(13);
	expect(Object.keys(second.resolution)).toHaveLength(20);
	const ordinary = await f.store.readAccountLinkStatus(f.signer, config, {
		identityId: origin.identityId,
	});
	expect(
		await f.store.readAccountLinkStatus(origin.signer, config, { identityId: origin.identityId }),
	).toMatchObject({ state: "linked", account: publicProfile });
	const before = await snapshot();
	f.diagnostics.writes = 0;
	// Act: both the instrumented operations and actual store delegate use native D1.
	const result = await status(f);
	const delegated = await f.store.readResolvedAccountOwnerStatus(f.signer, config, {
		ownerIdentityId: origin.identityId,
	});
	// Assert
	expect(result).toMatchObject({
		state: "owner_confirmed",
		ownerIdentity: origin.identityId,
		profileState: "linked",
		profile: withheldProfile,
	});
	expect(delegated).toEqual(result);
	displayOnly(result);
	expect(f.diagnostics.finalReads).toBe(1);
	expect(f.diagnostics.writes).toBe(0);
	expect(ordinary.state).not.toBe("linked");
	expect(
		await f.store.readAccountLinkStatus(f.signer, config, { identityId: origin.identityId }),
	).toEqual(ordinary);
	expect(await snapshot()).toEqual(before);
});

it("native retained controller and caller metadata cannot replace a missing persisted fact", async () => {
	// Arrange
	const f = await setup({ fact: false });
	const before = await snapshot();
	// Act
	const result = await status(f);
	const forged = new ResolvedAccountOwnerStatusOperations(f.backend).readResolvedAccountOwnerStatus(
		f.signer,
		config,
		{ ownerIdentityId: origin.identityId, sourceRef: f.controller, verified: true } as {
			ownerIdentityId: string;
		},
	);
	// Assert
	undisclosed(result);
	undisclosed(await forged);
	expect(await snapshot()).toEqual(before);
});

it.each(["other device same key", "other key same device", "foreign owner"] as const)(
	"native exact subject rejects %s",
	async (variant) => {
		// Arrange
		const f = await setup();
		let signer = f.signer;
		let owner = origin.identityId;
		if (variant === "other device same key") signer = { ...signer, deviceId: "other-current" };
		if (variant === "other key same device")
			signer = {
				...signer,
				publicKey: origin.signer.publicKey,
				fingerprint: fingerprintPublicKey(origin.signer.publicKey),
			};
		if (variant === "foreign owner") owner = "identity-b";
		if (variant !== "foreign owner") await f.store.enrollDevice(signer.groupId, signer);
		const before = await snapshot();
		// Act
		const result = await status(f, signer, owner);
		// Assert
		undisclosed(result);
		expect(await snapshot()).toEqual(before);
	},
);

it.each(["missing", "revoked", "receipt mismatch"] as const)(
	"native source %s denies despite complete persisted resolution",
	async (variant) => {
		// Arrange
		const f = await setup();
		if (variant === "receipt mismatch") {
			const signer = { ...f.signer, groupId: "second-retained-source" };
			await f.store.createGroup(signer.groupId);
			await f.store.enrollDevice(signer.groupId, signer);
			const source = await f.store.createAuthControllerAttestation({
				...signer,
				coordinatorId: config.coordinatorId,
				identityId: origin.identityId,
				attestationId: "second-source",
				reviewReceiptId: "second-source-review",
				evidenceDigest: "b".repeat(64),
			});
			if (source.kind !== "created") throw new Error("native second retained source rejected");
			await checkedFact({ ...f, controller: source.attestation }, "resolution-second");
			await exec(
				"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='wrong-receipt' WHERE attestation_id='original-controller'",
			);
			// Act / Assert: a later complete proof survives an earlier incomplete receipt.
			expect(await status(f)).toMatchObject({ state: "owner_confirmed", profile: withheldProfile });
			// Arrange: each receipt now disagrees with a different original source field.
			await exec(
				"UPDATE coordinator_auth_controller_attestations SET evidence_digest=? WHERE attestation_id='second-source'",
				"f".repeat(64),
			);
		}
		if (variant === "missing")
			await exec(
				"DELETE FROM coordinator_auth_controller_attestations WHERE attestation_id='original-controller'",
			);
		if (variant === "revoked")
			await exec(
				"UPDATE coordinator_auth_controller_attestations SET revoked_at=? WHERE attestation_id='original-controller'",
				now,
			);
		if (variant === "receipt mismatch")
			await exec(
				"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='wrong-receipt' WHERE attestation_id='original-controller'",
			);
		const before = await snapshot();
		// Act
		const result = await status(f);
		// Assert
		undisclosed(result);
		expect(await snapshot()).toEqual(before);
	},
);

it.each(["device_id", "ed25519_key"] as const)(
	"native global current %s revocation denies",
	async (kind) => {
		// Arrange
		const f = await setup();
		await revoke(f.signer, kind);
		const before = await snapshot();
		// Act
		const result = await status(f);
		// Assert
		undisclosed(result);
		expect(await snapshot()).toEqual(before);
	},
);

it("native removed source enrollment/group, later authentic weak labels and original OTHER-key retirement preserve A", async () => {
	// Arrange
	const f = await setup();
	await exec("DELETE FROM enrolled_devices WHERE group_id='retained-source'");
	await exec("DELETE FROM groups WHERE group_id='retained-source'");
	await history(f.signer, "later-history", "identity-later");
	await projectLabel(f);
	await revoke(origin.signer, "ed25519_key");
	const before = await snapshot();
	// Act
	const result = await status(f);
	// Assert
	expect(result).toMatchObject({
		state: "owner_confirmed",
		profileState: "linked",
		profile: withheldProfile,
	});
	displayOnly(result);
	expect(await snapshot()).toEqual(before);
});

it("native current verified profile wins; unverified email and credential-bearing picture are omitted", async () => {
	// Arrange: accepted refresh, not a fabricated provider/profile provenance row.
	const f = await setup();
	await f.birth.prepare(2, "refresh", {
		displayName: "Current A",
		email: "unverified@example.test",
		emailVerified: false,
		pictureUrl: "https://user:password@lh3.googleusercontent.com/image",
	});
	expect(await f.birth.operations.finalize(f.birth.proof(2), config)).toMatchObject({
		intent: "refresh",
	});
	const before = await snapshot();
	// Act
	const result = await status(f);
	// Assert
	expect(result).toMatchObject({
		state: "owner_confirmed",
		profileState: "linked",
		profile: withheldProfile,
	});
	expect(await snapshot()).toEqual(before);
});

it("native absent link preserves unrevoked independent source without stale profile; revoked source then denies", async () => {
	// Arrange: isolate link absence from disconnect's intentional source revocation.
	const f = await setup();
	await exec("DELETE FROM coordinator_auth_account_links");
	const before = await snapshot();
	// Act
	const result = await status(f);
	// Assert
	expect(result).toMatchObject({
		state: "owner_confirmed",
		profileState: "account_unlinked",
		profile: null,
	});
	expect(await snapshot()).toEqual(before);
	// Arrange / Act / Assert: source revocation must not be forced into a positive unlink case.
	await exec(
		"UPDATE coordinator_auth_controller_attestations SET revoked_at=? WHERE attestation_id='original-controller'",
		now,
	);
	undisclosed(await status(f));
	// Arrange: a real disconnect leaves this independent source unrevoked.
	const disconnect = await setup();
	await disconnect.birth.prepare(2, "disconnect");
	expect(
		await disconnect.birth.operations.finalize(disconnect.birth.proof(2), config),
	).toMatchObject({ intent: "disconnect" });
	expect(
		await db
			.prepare(
				"SELECT revoked_at FROM coordinator_auth_controller_attestations WHERE attestation_id='original-controller'",
			)
			.first(),
	).toEqual({ revoked_at: null });
	const afterDisconnect = await snapshot();
	// Act
	const disconnected = await status(disconnect);
	// Assert
	expect(disconnected).toMatchObject({
		state: "owner_confirmed",
		profileState: "account_unlinked",
		profile: null,
	});
	expect(await snapshot()).toEqual(afterDisconnect);
});

it.each(["source revocation", "requester changed", "new strong B"] as const)(
	"native final SELECT catches %s after prechecks",
	async (race) => {
		// Arrange: mutation happens at actual profile/fact SQL, after preliminary source verification.
		const f = await setup();
		let afterMutation: Awaited<ReturnType<typeof snapshot>> | undefined;
		f.hooks.final = async () => {
			if (race === "source revocation")
				await exec(
					"UPDATE coordinator_auth_controller_attestations SET revoked_at=? WHERE attestation_id='original-controller'",
					now,
				);
			if (race === "requester changed")
				await exec(
					"UPDATE enrolled_devices SET enabled=0 WHERE group_id=? AND device_id=?",
					f.signer.groupId,
					f.signer.deviceId,
				);
			if (race === "new strong B") await strongB(f);
			afterMutation = await snapshot();
		};
		// Act
		const result = await status(f);
		// Assert
		expect(f.diagnostics.finalReads).toBe(1);
		expect(afterMutation).toBeDefined();
		undisclosed(result);
		expect(await snapshot()).toEqual(afterMutation);
		if (race === "requester changed") {
			for (const assignment of [
				"public_key=public_key || ' changed-text'",
				"fingerprint='wrong-fingerprint'",
				"enabled=0",
			] as const) {
				// Arrange: restore exact current signer, then race one field at the final SELECT.
				await exec(
					"UPDATE enrolled_devices SET enabled=1,public_key=?,fingerprint=? WHERE group_id=? AND device_id=?",
					f.signer.publicKey,
					f.signer.fingerprint,
					f.signer.groupId,
					f.signer.deviceId,
				);
				f.hooks.final = async () => {
					await exec(
						`UPDATE enrolled_devices SET ${assignment} WHERE group_id=? AND device_id=?`,
						f.signer.groupId,
						f.signer.deviceId,
					);
					afterMutation = await snapshot();
				};
				// Act
				const changed = await status(f);
				// Assert
				undisclosed(changed);
				expect(await snapshot()).toEqual(afterMutation);
			}
			// Arrange: current-group archival is independent of source-group retention.
			await exec(
				"UPDATE enrolled_devices SET enabled=1,public_key=?,fingerprint=? WHERE group_id=? AND device_id=?",
				f.signer.publicKey,
				f.signer.fingerprint,
				f.signer.groupId,
				f.signer.deviceId,
			);
			f.hooks.final = async () => {
				await exec("UPDATE groups SET archived_at=? WHERE group_id=?", now, f.signer.groupId);
				afterMutation = await snapshot();
			};
			// Act
			const archived = await status(f);
			// Assert
			undisclosed(archived);
			expect(await snapshot()).toEqual(afterMutation);
		}
	},
);

it("native final SELECT reads an actual refreshed profile consistently and rejects broken current generation", async () => {
	// Arrange: prepare a real local verified callback; finalize only at final SQL boundary.
	const f = await setup();
	const next = {
		displayName: "New A",
		email: "new-a@example.test",
		emailVerified: true,
		pictureUrl: profile.pictureUrl,
	};
	await f.birth.prepare(2, "refresh", next);
	let afterMutation: Awaited<ReturnType<typeof snapshot>> | undefined;
	f.hooks.final = async () => {
		expect(await f.birth.operations.finalize(f.birth.proof(2), config)).toMatchObject({
			intent: "refresh",
		});
		afterMutation = await snapshot();
	};
	// Act
	const current = await status(f);
	// Assert
	expect(f.diagnostics.finalReads).toBe(1);
	expect(current.state).toBe("owner_confirmed");
	if (current.profile !== null) expect(current.profile).toEqual(withheldProfile);
	expect(JSON.stringify(current)).not.toContain(profile.email);
	expect(await snapshot()).toEqual(afterMutation);
	// Arrange: corrupt only the current connection generation after its preliminary reads.
	f.hooks.final = async () => {
		await exec("UPDATE coordinator_auth_account_links SET attempt_id='unknown-current-generation'");
		afterMutation = await snapshot();
	};
	// Act
	const changed = await status(f);
	// Assert
	expect(f.diagnostics.finalReads).toBe(2);
	expect(changed.profile).toBeNull();
	expect(changed.profileState).toBe("unavailable");
	expect(await snapshot()).toEqual(afterMutation);
});

it("native unknown schema and real missing storage report unavailable, never a successful false unlink", async () => {
	// Arrange
	const f = await setup();
	await exec("DROP INDEX idx_legacy_owner_resolutions_key");
	const operations = new ResolvedAccountOwnerStatusOperations(f.backend);
	const before = await snapshot();
	// Act
	const unsupported = operations.readResolvedAccountOwnerStatus(f.signer, config, {
		ownerIdentityId: origin.identityId,
	});
	// Assert
	await expect(unsupported).rejects.toThrow(/unavailable|upgrade_required/u);
	expect(await snapshot()).toEqual(before);
	// Arrange / Act / Assert: genuine native storage failure, not a mocked successful read.
	await exec("DROP TABLE coordinator_legacy_owner_resolutions");
	const missing = operations.readResolvedAccountOwnerStatus(f.signer, config, {
		ownerIdentityId: origin.identityId,
	});
	await expect(missing).rejects.toThrow(/unavailable|upgrade_required/u);
});
