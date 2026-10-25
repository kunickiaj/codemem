import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { ed25519KeyIdForRevocation } from "../../core/src/coordinator-ed25519-key-id-compat.js";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS } from "../../core/src/coordinator-legacy-owner-resolution-schema.js";
import {
	commitOwnerEnrollment,
	type OwnerAttempt,
} from "../../core/src/coordinator-owner-enrollment-commit.js";
import {
	ownerEnrollmentConfirmationHash,
	ownerEnrollmentFinalMessage,
} from "../../core/src/coordinator-owner-enrollment-proof.js";
import type { CoordinatorConsumeRecipientInviteInput } from "../../core/src/coordinator-store-contract.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { recipientReviewedIntentDigest } from "../../core/src/recipient-reviewed-intent.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import {
	input as claimInput,
	config,
	NOW,
	otherKey,
	seedEnrollmentSql,
} from "./device-claim-eligibility-fixture.js";
import { pendingKey } from "./owner-authority-test-fixture.js";
import {
	resetCeremony,
	seedNativeOwnerAuthority,
	snapshot,
} from "./owner-ceremony-test-fixtures.js";

export const db = env.COORDINATOR_DB;
export const resolutionTable = "coordinator_legacy_owner_resolutions";
export const sourceTable = "coordinator_auth_controller_attestations";
export const timestamp = new Date(NOW).toISOString();
export type ProducerKind = "claim" | "enrollment" | "team_member" | "add_device";
type Row = Record<string, string | number | null>;
export type Subject = {
	coordinatorId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	ownerIdentityId: string;
};
export const exec = async (sql: string, ...values: unknown[]) =>
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
export async function installSchema() {
	await db.batch(LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
}
export async function reset() {
	await resetCeremony();
	await exec(`DROP TABLE IF EXISTS ${resolutionTable}`);
	await installSchema();
	for (const table of [
		"coordinator_invites",
		"coordinator_bootstrap_grants",
		"coordinator_legacy_team_completions",
	])
		await exec(`DELETE FROM ${table}`);
}
export async function state() {
	return {
		catalog: (
			await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()
		).results,
		rows: await snapshot(),
	};
}

export async function retain(
	subject: Subject,
	options: {
		match?: "device" | "key";
		removeSource?: boolean;
		persistResolution?: boolean;
		foreign?: boolean;
	} = {},
) {
	const deviceId = options.match === "key" ? "removed-original-device" : subject.deviceId;
	const publicKey = options.match === "device" ? otherKey : `${subject.publicKey} original-alias`;
	const source = {
		attestation_id: "producer-original-controller",
		coordinator_id: options.foreign ? "foreign-coordinator" : subject.coordinatorId,
		identity_id: subject.ownerIdentityId,
		group_id: "removed-original-group",
		device_id: deviceId,
		public_key: publicKey,
		fingerprint: subject.fingerprint,
		review_receipt_id: "producer-original-review",
		evidence_digest: "b".repeat(64),
		enrollment_identity_id: null,
		revision: 1,
		created_at: "2026-09-01T00:00:00.000Z",
		revoked_at: null,
	};
	await insert(sourceTable, source);
	const resolution = {
		coordinator_id: source.coordinator_id,
		resolution_id: "producer-original-resolution",
		resolution_version: 1,
		device_id: deviceId,
		key_id: await ed25519KeyIdForRevocation(publicKey),
		owner_identity_id: source.identity_id,
		purpose: "existing_account_owner",
		scope: "historical_included_owner_labels_only",
		source_attestation_id: source.attestation_id,
		source_group_id: source.group_id,
		source_controller_revision: 1,
		source_public_key: publicKey,
		source_fingerprint: source.fingerprint,
		source_enrollment_identity_id: null,
		source_created_at: source.created_at,
		source_review_receipt_id: source.review_receipt_id,
		source_evidence_digest: source.evidence_digest,
		resolution_evidence_digest: "d".repeat(64),
		reviewed_weak_labels_json: "[]",
		created_at: "2026-09-02T00:00:00.000Z",
	};
	if (options.persistResolution !== false) await insert(resolutionTable, resolution);
	if (options.removeSource)
		await exec(`DELETE FROM ${sourceTable} WHERE attestation_id=?`, source.attestation_id);
	return resolution;
}

/** Forward real native statements, including immutable bind clones and whole batches. */
export function nativeHarness(gate: RegExp) {
	const statements = new WeakMap<D1PreparedStatement, { sql: string; values: unknown[] }>();
	let mutate: (() => Promise<void>) | undefined;
	let observed = false;
	let afterMutation: Awaited<ReturnType<typeof state>> | undefined;
	let maxBinds = 0;
	let catalogChange: (() => Promise<void>) | undefined;
	let catalogObserved = false;
	const before = async (entries: { sql: string; values: unknown[] }[]) => {
		if (!entries.some(({ sql }) => gate.test(sql))) return;
		maxBinds = Math.max(maxBinds, ...entries.map(({ values }) => values.length));
		if (!mutate || observed) return;
		observed = true;
		await mutate();
		afterMutation = await state();
	};
	const wrap = (
		statement: D1PreparedStatement,
		sql: string,
		values: unknown[] = [],
	): D1PreparedStatement => {
		const proxy = new Proxy(statement, {
			get(target, key) {
				if (key === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
				if (key === "first")
					return async (...args: Parameters<D1PreparedStatement["first"]>) => {
						const result = await target.first(...args);
						if (
							catalogChange &&
							!catalogObserved &&
							/\bFROM\s+sqlite_master\b/iu.test(sql) &&
							(sql.includes(resolutionTable) || values.includes(resolutionTable))
						) {
							catalogObserved = true;
							await catalogChange();
						}
						return result;
					};
				if (key === "run")
					return async () => {
						await before([{ sql, values }]);
						return target.run();
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		statements.set(proxy, { sql, values });
		return proxy;
	};
	const database = new Proxy(db, {
		get(target, key) {
			if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
			if (key === "batch")
				return async (batch: D1PreparedStatement[]) => {
					await before(
						batch.map((statement) => {
							const entry = statements.get(statement);
							if (!entry) throw new Error("native statement metadata missing");
							return entry;
						}),
					);
					return target.batch(batch);
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const prepare = (s: AuthLinkStatement) => database.prepare(s.sql).bind(...s.values);
	const backend = {
		first: <T>(s: AuthLinkStatement) => prepare(s).first<T>(),
		all: async <T>(s: AuthLinkStatement) => (await prepare(s).all<T>()).results,
		run: async (s: AuthLinkStatement) => (await prepare(s).run()).meta.changes,
		batch: async (batch: AuthLinkStatement[]) => {
			await database.batch(batch.map(prepare));
		},
	};
	return {
		store: new D1CoordinatorStore(database, { authClock: () => NOW }),
		backend,
		arm: (change: () => Promise<void>) => {
			mutate = change;
		},
		observed: () => observed,
		afterCatalog: (change: () => Promise<void>) => {
			catalogChange = change;
		},
		catalogObserved: () => catalogObserved,
		afterMutation: () => afterMutation,
		maxBinds: () => maxBinds,
	};
}
export type Harness = ReturnType<typeof nativeHarness>;
export interface Producer {
	kind: ProducerKind;
	h: Harness;
	subject: Subject;
	run(): Promise<unknown>;
	denyAdmission(): Promise<unknown>;
	omitNamespace?(): void;
}

async function claim(h: Harness): Promise<Producer> {
	await db.batch(
		seedEnrollmentSql
			.split(";")
			.map((sql) => sql.trim())
			.filter(Boolean)
			.map((sql) => db.prepare(sql)),
	);
	const request = {
		authority: { kind: "device_claim" as const, identityId: claimInput.identityId },
		signer: claimInput.signer,
		attemptId: "attempt-a",
		runtimeVerifierHash: "b".repeat(64),
		browserStartHash: "e".repeat(64),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const browserConfig = {
		...config,
		redirectUri: "https://coordinator.example.test/auth/callback",
	};
	const transaction = {
		purpose: "link" as const,
		attemptId: request.attemptId,
		browserStartHash: request.browserStartHash,
		stateHash: "3".repeat(64),
		binderHash: "4".repeat(64),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect(await h.store.createAuthLinkAttempt(request, config)).toMatchObject({ kind: "created" });
	expect(await h.store.startAuthBrowserTransaction(transaction, browserConfig)).toMatchObject({
		kind: "started",
	});
	const bound = await h.store.resolveAuthLinkBrowserTransaction(
		{ attemptId: request.attemptId, binderHash: transaction.binderHash },
		browserConfig,
	);
	if (!bound) throw new Error("native claim browser not bound");
	expect(
		await h.store.consumeAuthBrowserTransaction(
			{ stateHash: transaction.stateHash, binderHash: transaction.binderHash },
			browserConfig,
		),
	).toMatchObject({ kind: "consumed" });
	const browser = { attemptId: request.attemptId, ...bound };
	expect(
		await h.store.recordAuthLinkOidcVerified(
			{ ...browser, account: { issuer: config.issuer, subject: "synthetic-provider-subject" } },
			config,
		),
	).toMatchObject({ kind: "applied" });
	expect(await h.store.readAuthLinkCompletionDestination(browser, config)).toEqual({
		destination: request.loopbackRedirect,
	});
	expect(
		await h.store.confirmAuthLinkAttempt(
			{ ...browser, completionSecretHash: "d".repeat(64) },
			config,
		),
	).toMatchObject({ kind: "applied" });
	const proof = {
		purpose: "coordinator-account-link-v1" as const,
		coordinatorId: config.coordinatorId,
		attemptId: request.attemptId,
		groupId: claimInput.signer.groupId,
		identityId: claimInput.identityId,
		deviceId: claimInput.signer.deviceId,
		fingerprint: claimInput.signer.fingerprint,
		runtimeVerifierHash: request.runtimeVerifierHash,
		completionSecretHash: "d".repeat(64),
		signer: claimInput.signer,
	};
	return {
		kind: "claim",
		h,
		subject: {
			...claimInput.signer,
			coordinatorId: config.coordinatorId,
			ownerIdentityId: claimInput.identityId,
		},
		run: () => h.store.finalizeAuthLinkAttempt(proof, config),
		denyAdmission: () =>
			exec("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?", claimInput.signer.deviceId),
	};
}

async function enrollment(h: Harness): Promise<Producer> {
	const key = await pendingKey();
	const keyId = await ed25519KeyIdForRevocation(key.publicKey);
	if (!keyId) throw new Error("native key fixture invalid");
	const birth = {
		admission_owner_hash: null,
		coordinator_id: config.coordinatorId,
		attempt_id: "owner-attempt-a",
		purpose: "owner_enroll" as const,
		origin: "https://coordinator.example.test",
		device_id: "new-owner-device",
		public_key: key.publicKey,
		key_id: keyId,
		fingerprint: fingerprintPublicKey(key.publicKey),
		issuer: config.issuer,
		auth_config_revision: config.revision,
		loopback_redirect: "http://127.0.0.1:4567/complete",
		browser_start_hash: "b".repeat(64),
		browser_binder_hash: null,
		state: "pending",
		created_at_ms: NOW,
		expires_at_ms: NOW + 600000,
	};
	const secret = Buffer.alloc(32, 9).toString("base64url");
	const row: OwnerAttempt = {
		...birth,
		state: "confirmed",
		account_subject: "synthetic-owner-subject",
		identity_id: "identity-a",
		link_id: "link-a",
		link_attempt_id: "historical-attempt",
		link_controller_attestation_id: "historical-controller",
		link_auth_config_revision: "c".repeat(64),
		grant_revisions_json: '[{"groupId":"group-a","revision":1},{"groupId":"group-b","revision":1}]',
		browser_transaction_hash: "d".repeat(64),
		browser_binder_hash: "8".repeat(64),
		confirmation_hash: null,
		completion_secret_hash: createHash("sha256").update(Buffer.alloc(32, 9)).digest("hex"),
		final_key_proof_hash: null,
		finalized_at_ms: null,
		binding_id: null,
		audit_event_id: null,
		final_outcome_json: null,
	};
	row.confirmation_hash = await ownerEnrollmentConfirmationHash(row);
	await insert("coordinator_owner_enrollment_attempts", birth);
	for (const [stage, names] of [
		["browser_claimed", "browser_transaction_hash browser_binder_hash"],
		[
			"oidc_verified",
			"account_subject identity_id link_id link_attempt_id link_controller_attestation_id link_auth_config_revision grant_revisions_json",
		],
		["confirmed", "confirmation_hash completion_secret_hash"],
	]) {
		const fields = (names as string).split(" ") as (keyof OwnerAttempt)[];
		await exec(
			`UPDATE coordinator_owner_enrollment_attempts SET state=?, ${fields.map((name) => `${name}=?`).join(",")}`,
			stage,
			...fields.map((name) => row[name]),
		);
	}
	await seedNativeOwnerAuthority({
		coordinatorId: config.coordinatorId,
		issuer: row.issuer,
		revision: "c".repeat(64),
		linkId: "link-a",
		subject: "synthetic-owner-subject",
		identityId: "identity-a",
		attemptId: "historical-attempt",
		controllerAttestationId: "historical-controller",
		controllerReviewReceiptId: "historical-receipt",
		redirectUri: "https://coordinator.example.test/auth/callback",
		groupId: "historical-group",
		deviceId: "historical-device",
		publicKey: "fixture-historical-controller-key",
		fingerprint: "f".repeat(64),
		createdAtMs: NOW,
	});
	for (const group of ["group-a", "group-b"]) {
		await exec("INSERT INTO groups(group_id,created_at) VALUES (?,?)", group, timestamp);
		await insert("coordinator_identity_group_grants", {
			coordinator_id: config.coordinatorId,
			identity_id: "identity-a",
			group_id: group,
			status: "active",
			revision: 1,
			source_kind: "controller_attestation",
			source_receipt_id: "historical-receipt",
			created_at: timestamp,
		});
	}
	const signature = await key.sign(ownerEnrollmentFinalMessage(row, secret));
	return {
		kind: "enrollment",
		h,
		subject: {
			coordinatorId: config.coordinatorId,
			deviceId: row.device_id,
			publicKey: row.public_key,
			fingerprint: row.fingerprint,
			ownerIdentityId: "identity-a",
		},
		run: () =>
			commitOwnerEnrollment({
				backend: h.backend,
				row,
				revision: row.auth_config_revision,
				now: NOW,
				completionSecret: secret,
				signature,
			}),
		denyAdmission: () =>
			exec("UPDATE coordinator_identity_group_grants SET status='revoked',revoked_at=?", timestamp),
	};
}

async function invitation(h: Harness, kind: "team_member" | "add_device"): Promise<Producer> {
	await h.store.createGroup("group-a");
	await h.store.enrollDevice("group-a", {
		deviceId: "invite-seed",
		publicKey: otherKey,
		fingerprint: fingerprintPublicKey(otherKey),
		identityId: "identity-recipient",
	});
	const reviewedIntent =
		kind === "team_member"
			? {
					version: 1,
					journey: "team",
					team: { teamId: "policy-team", displayName: "Team", futureProjectsInherit: true },
					projects: [],
					excludedProjects: [],
				}
			: {
					version: 1,
					journey: "add_device",
					targetIdentity: { identityId: "identity-recipient", displayName: "Recipient" },
					projects: [],
					excludedProjects: [],
				};
	const invite = await h.store.createInvite({
		groupId: "group-a",
		policy: "auto_admit",
		expiresAt: "2099-01-01T00:00:00Z",
		inviteKind: kind,
		inviterDeviceId: "invite-seed",
		...(kind === "team_member"
			? { policyTeamId: "policy-team" }
			: { targetIdentityId: "identity-recipient" }),
		reviewedIntent,
		reviewedPreviewDigest: await recipientReviewedIntentDigest(reviewedIntent),
	});
	const input: CoordinatorConsumeRecipientInviteInput = {
		coordinatorId: config.coordinatorId,
		token: invite.token,
		inviteKind: kind,
		identityId: kind === "team_member" ? String(invite.assigned_identity_id) : "identity-recipient",
		deviceId: "invite-recipient",
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
		recipientDisplayName: "Recipient",
		deviceDisplayName: "Recipient device",
		now: timestamp,
	};
	return {
		kind,
		h,
		subject: { ...input, coordinatorId: config.coordinatorId, ownerIdentityId: input.identityId },
		run: () => h.store.consumeRecipientInvite(input),
		omitNamespace: () => {
			delete input.coordinatorId;
		},
		denyAdmission: async () =>
			insert("coordinator_device_ownership_bindings", {
				device_id: input.deviceId,
				key_id: (await ed25519KeyIdForRevocation(input.publicKey)) as string,
				identity_id: input.identityId,
				coordinator_id: config.coordinatorId,
				binding_id: "old-binding",
				provenance: "owner_enrollment",
				source_ref: "synthetic-old-birth",
				bound_at: timestamp,
			}),
	};
}

export async function producer(kind: ProducerKind) {
	const gates = {
		claim: /UPDATE coordinator_auth_link_attempts\s+SET state = 'finalized'/u,
		enrollment: /UPDATE coordinator_owner_enrollment_attempts AS a SET state = 'finalized'/u,
		team_member: /UPDATE coordinator_invites SET token\s*=/u,
		add_device: /UPDATE coordinator_invites SET token\s*=/u,
	};
	const h = nativeHarness(gates[kind]);
	if (kind === "claim") return claim(h);
	if (kind === "enrollment") return enrollment(h);
	return invitation(h, kind);
}
