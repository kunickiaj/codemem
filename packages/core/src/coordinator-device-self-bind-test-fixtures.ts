import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { expect } from "vitest";
import {
	reopenCoordinator,
	setupV2Store,
} from "./coordinator-account-schema-sqlite-test-fixtures.js";
import { useCurrentAccountSchema } from "./coordinator-account-schema-test-fixtures.js";
import { prepareHistoricalAccountDatabase } from "./coordinator-auth-historical-test-fixture.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	type Backend,
	type Fixture,
	review,
	setupStore,
	sqliteD1,
} from "./coordinator-auth-store-test-fixtures.js";
import { issueBrowserCookie } from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey, issueBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { createDeviceRebindCeremony } from "./coordinator-device-rebind-ceremony.js";
import {
	type DeviceRebindAttempt,
	deviceRebindFinalMessage,
} from "./coordinator-device-rebind-proof.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "./coordinator-legacy-team-completion.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { createD1AuthLinkBackend } from "./d1-coordinator-store.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

export const SELF_BIND_NOW = 1_791_028_800_000;
const ORIGIN = "https://app.example.test";
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const insert = (db: Database.Database, table: string, row: Record<string, unknown>) => {
	const keys = Object.keys(row);
	db.prepare(
		`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
	).run(...Object.values(row));
};

/** Original pre-upgrade account genesis, with an independent own controller review.
 * Peer-origin links intentionally have no relationship to that own review.
 */
export type SelfBindLinkOrigin = "own" | "peer" | "peer_controller";

/**
 * The seeded account history predates the account extension, so coordinators are seeded
 * on V2. `accountSchema: "v2"` keeps them there for tests that install the extension
 * themselves; otherwise SQLite reopens through ordinary startup and D1 takes the
 * account migrations.
 */
async function seedSelfBind(
	kind: Backend,
	origin: SelfBindLinkOrigin,
	identityId: string,
	options: SelfBindFixtureOptions,
) {
	const v2 = kind === "SQLite" ? setupV2Store({ authClock: () => SELF_BIND_NOW }) : null;
	const f: Fixture =
		v2 ?? setupStore(kind, { authClock: () => SELF_BIND_NOW, accountSchema: "v2" });
	const { db } = f;
	const own = commitPendingKey();
	const peer = commitPendingKey();
	const signer = {
		groupId: "group-a",
		deviceId: "device-a",
		publicKey: own.publicKey,
		fingerprint: hash(own.publicKey),
	};
	const historical = new Database(":memory:");
	const pins = prepareHistoricalAccountDatabase(historical, {
		authority: origin === "peer" ? "device_claim" : "controller_attestation",
		bornAtMs: SELF_BIND_NOW - 60000,
	});
	const config = {
		...pins.config,
		redirectUri: `${ORIGIN}/auth/callback`,
		clientId: "test-client",
		clientSecret: "test-secret",
	};
	seedEnrollments(db, signer, identityId);
	let source = signer;
	if (origin !== "own") {
		source = {
			...signer,
			deviceId: "device-peer",
			publicKey: peer.publicKey,
			fingerprint: hash(peer.publicKey),
		};
		insert(db, "enrolled_devices", {
			group_id: "group-a",
			device_id: source.deviceId,
			public_key: source.publicKey,
			fingerprint: source.fingerprint,
			identity_id: identityId,
			enabled: 1,
			created_at: "created",
		});
	}
	await copyHistoricalRows(db, historical, source, identityId);
	historical.close();
	await seedControllerReviews(f, signer, source, identityId, origin);
	let opened: Fixture = f;
	if (options.accountSchema !== "v2") {
		// SQLite startup, or D1 migrations 0046 and 0047, bring the history to current.
		if (v2) opened = await reopenCoordinator(v2, { authClock: () => SELF_BIND_NOW });
		else await useCurrentAccountSchema(createD1AuthLinkBackend(sqliteD1(f.db)));
	}
	return { ...opened, own, signer, identityId, config, pins };
}

async function seedControllerReviews(
	f: ReturnType<typeof setupStore>,
	signer: Signer,
	source: Signer,
	identityId: string,
	origin: SelfBindLinkOrigin,
) {
	if (origin === "peer_controller") {
		expect(
			await f.store.createAuthControllerAttestation(
				review({
					attestationId: "historical-controller",
					reviewReceiptId: "historical-review",
					identityId,
					...source,
				}),
			),
		).toMatchObject({ kind: "created" });
	}
	expect(
		await f.store.createAuthControllerAttestation(
			review({
				attestationId: origin === "own" ? "historical-controller" : "own-controller",
				reviewReceiptId: origin === "own" ? "historical-review" : "own-review",
				identityId,
				...signer,
			}),
		),
	).toMatchObject({ kind: "created" });
}

type Signer = { groupId: string; deviceId: string; publicKey: string; fingerprint: string };

function seedEnrollments(db: Database.Database, signer: Signer, identityId: string) {
	for (const groupId of ["group-a", "group-b"]) {
		db.prepare("INSERT INTO groups (group_id,created_at) VALUES (?,'created')").run(groupId);
		insert(db, "enrolled_devices", {
			group_id: groupId,
			device_id: signer.deviceId,
			public_key: signer.publicKey,
			fingerprint: signer.fingerprint,
			identity_id: groupId === "group-a" ? null : identityId,
			enabled: 1,
			created_at: "created",
		});
	}
}

async function copyHistoricalRows(
	db: Database.Database,
	historical: Database.Database,
	source: Signer,
	identityId: string,
) {
	const replace: Record<string, unknown> = {
		identity_id: identityId,
		device_id: source.deviceId,
		public_key: source.publicKey,
		fingerprint: source.fingerprint,
		key_id: await ed25519KeyId(source.publicKey),
	};
	for (const table of [
		"coordinator_auth_browser_transactions",
		"coordinator_auth_link_attempts",
		"coordinator_auth_device_claims",
		"coordinator_auth_account_links",
		"coordinator_auth_link_audit_log",
	]) {
		for (const row of historical.prepare(`SELECT * FROM ${table}`).all() as Record<
			string,
			unknown
		>[]) {
			for (const [k, v] of Object.entries(replace)) if (Object.hasOwn(row, k)) row[k] = v;
			insert(db, table, row);
		}
	}
}

export interface SelfBindFixtureOptions {
	accountSchema?: "current" | "v2";
}

export async function selfBindFixture(
	kind: Backend,
	origin: SelfBindLinkOrigin = "own",
	identityId = "local:device-a",
	options: SelfBindFixtureOptions = {},
) {
	const f = await seedSelfBind(kind, origin, identityId, options);
	const { db, own, signer, config, pins } = f;
	const backend = kind === "SQLite" ? nativeBackend(db) : createD1AuthLinkBackend(sqliteD1(db));
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const material = { state: "s".repeat(43), nonce: "n".repeat(43), pkceVerifier: "p".repeat(43) };
	const account = { issuer: config.issuer, subject: pins.account.subject, ok: true };
	const makeCeremony = (backend: AuthLinkBackend) =>
		createDeviceRebindCeremony({
			backend,
			config,
			publicOrigin: ORIGIN,
			csrfKey,
			now: () => SELF_BIND_NOW,
			limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
			client: {
				createAuthorizationRequest: async () => ({
					authorizationUrl: "https://accounts.example.test/authorize",
					material,
				}),
				verifyCallback: async () =>
					account.ok
						? { ok: true, account, profile: {} }
						: { ok: false, error: "invalid_callback" as const },
			},
		});
	const ceremony = makeCeremony(backend);
	const code = Buffer.alloc(32, 7).toString("base64url");
	const input = {
		signer,
		attemptId: "self-bind",
		currentIdentityId: identityId,
		browserStartHash: hash(Buffer.from(code, "base64url")),
		reviewDigest: "e".repeat(64),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const steps = (c = ceremony) => browserSteps(c, input, code, csrfKey, config, material.state);
	const finalizedInput = (row: DeviceRebindAttempt, secret: string) => ({
		attemptId: input.attemptId,
		signer,
		completionSecret: secret,
		signature: own.sign(deviceRebindFinalMessage(row, secret)),
	});
	return {
		...f,
		backend,
		account,
		input,
		steps,
		makeCeremony,
		finalizedInput,
		close: async () => {
			await f.store.close();
			if (db.open) db.close();
		},
	};
}

function browserSteps(
	c: ReturnType<typeof createDeviceRebindCeremony>,
	input: Parameters<ReturnType<typeof createDeviceRebindCeremony>["start"]>[0],
	code: string,
	csrfKey: Awaited<ReturnType<typeof importBrowserCsrfKey>>,
	config: Awaited<ReturnType<typeof seedSelfBind>>["config"],
	state: string,
) {
	const form = (cookie: string, fields: Record<string, string>) =>
		new Request(`${ORIGIN}/auth/rebind`, {
			method: "POST",
			headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields),
		});
	let transaction = "";
	let csrf = "";
	let commitment = "";
	return {
		start: () => c.start(input, "client"),
		claim: async () => {
			const cookie = await issueBrowserCookie("start");
			const result = await c.claimBrowser(
				form(cookie.setCookie.split(";")[0] ?? "", {
					csrf: await issueBrowserCsrfToken(csrfKey, cookie.secret, "start", {
						publicOrigin: ORIGIN,
						store: config,
					}),
					attempt_id: input.attemptId,
					start_code: code,
				}),
				"client",
			);
			if (result?.kind === "browser_claimed")
				transaction = result.setCookies[0]?.split(";")[0] ?? "";
			return result;
		},
		verify: async () => {
			const result = await c.verifyCallback(
				new Request(`${config.redirectUri}?state=${state}&code=test-code`, {
					headers: { cookie: transaction },
				}),
			);
			if (result?.kind === "verified") {
				csrf = result.csrf;
				commitment = result.confirmation.confirmationHash;
			}
			return result;
		},
		confirm: () =>
			c.confirm(form(transaction, { csrf, attempt_id: input.attemptId }), "client", commitment),
	};
}

/** Stores a canonical legacy completion of group-a that assigns device-a to its Identity. */
export function assignLegacyCompletion(f: Awaited<ReturnType<typeof selfBindFixture>>): void {
	const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
		version: 1,
		coordinator_id: f.config.coordinatorId,
		candidate_ref: legacyTeamCandidateId(f.config.coordinatorId, f.signer.groupId),
		candidate_digest: "a".repeat(64),
		team_id: "team-a",
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: f.identityId, role: "member" }],
		device_decisions: [
			{
				device_id: f.signer.deviceId,
				key_fingerprint: f.signer.fingerprint,
				enabled: true,
				identity_id: f.identityId,
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-10-01T00:00:00.000Z",
	});
	insert(f.db, "coordinator_legacy_team_completions", {
		group_id: f.signer.groupId,
		candidate_ref: manifest.candidate_ref,
		manifest_version: 1,
		manifest_json: canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
		completed_at: manifest.completed_at,
		created_at: manifest.completed_at,
	});
}

/**
 * Stores a retained legacy owner resolution for device-a whose original source is the
 * device's own controller review. The self-bind authority then takes the path that
 * reads and classifies ownership evidence, which needs a backend that can read rows.
 */
export async function retainOwnReviewOwnership(
	f: Awaited<ReturnType<typeof selfBindFixture>>,
): Promise<void> {
	f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	const review = f.db
		.prepare("SELECT * FROM coordinator_auth_controller_attestations WHERE device_id=?")
		.get(f.signer.deviceId) as Record<string, string | number | null>;
	insert(f.db, "coordinator_legacy_owner_resolutions", {
		coordinator_id: review.coordinator_id,
		resolution_id: "retained-resolution",
		resolution_version: 1,
		device_id: review.device_id,
		key_id: await ed25519KeyIdForRevocation(f.signer.publicKey),
		owner_identity_id: review.identity_id,
		purpose: "existing_account_owner",
		scope: "historical_included_owner_labels_only",
		source_attestation_id: review.attestation_id,
		source_group_id: review.group_id,
		source_controller_revision: review.revision,
		source_public_key: review.public_key,
		source_fingerprint: review.fingerprint,
		source_enrollment_identity_id: review.enrollment_identity_id,
		source_created_at: review.created_at,
		source_review_receipt_id: review.review_receipt_id,
		source_evidence_digest: review.evidence_digest,
		resolution_evidence_digest: "d".repeat(64),
		reviewed_weak_labels_json: "[]",
		created_at: "2026-09-02T00:00:00.000Z",
	});
}
