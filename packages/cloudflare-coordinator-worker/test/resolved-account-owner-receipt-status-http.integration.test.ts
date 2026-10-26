import { env } from "cloudflare:workers";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "../../core/src/coordinator-api.js";
import type { AuthLinkBackend, AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "../../core/src/coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "../../core/src/coordinator-browser-csrf.js";
import { CoordinatorDeviceOwnershipEvidence } from "../../core/src/coordinator-device-ownership-evidence.js";
import { ed25519KeyIdForRevocation } from "../../core/src/coordinator-ed25519-key-id-compat.js";
import { commitReviewedOwnerResolution } from "../../core/src/coordinator-legacy-owner-resolution-commit.js";
import type { LegacyOwnerResolutionRecord } from "../../core/src/coordinator-legacy-owner-resolution-metadata.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "../../core/src/coordinator-legacy-team-completion.js";
import { oidcFixture } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { ResolvedAccountOwnerStatusOperations } from "../../core/src/coordinator-resolved-account-owner-status.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { legacyTeamCandidateId } from "../../core/src/recipient-policy-identifiers.js";
import { createInMemoryRequestRateLimiter } from "../../core/src/request-rate-limit.js";
import { buildCanonicalRequest, SIGNATURE_VERSION } from "../../core/src/sync-auth.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { verifyCloudflareCoordinatorRequest } from "../src/request-verifier.js";
import { changeFixture, config, NOW, input as origin } from "./account-change-fixture.js";
import { resetCeremony } from "./owner-ceremony-test-fixtures.js";

const db = env.COORDINATOR_DB;
const ROOT = "/v1/auth/resolved-account-owner-receipt-status";
const ORIGIN = "https://coordinator.example.test";
const now = new Date(NOW).toISOString();
const originalIssuer = config.issuer;
const profile = {
	displayName: "Synthetic Receipt Owner A",
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
let nonce = 0;

beforeEach(() => {
	// Request timestamps use the Worker's real clock; account ceremonies use their fixture clock.
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	config.issuer = "https://accounts.google.com";
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		config.issuer = originalIssuer;
		vi.restoreAllMocks();
	}
});

const prepare = ({ sql, values }: AuthLinkStatement) => db.prepare(sql).bind(...values);
const exec = (sql: string, ...values: AuthLinkStatement["values"]) =>
	prepare({ sql, values }).run();
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
		// Recreate only the ephemeral fixture graph, preserving every installed constraint.
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
			.filter(({ type, name }) => type === "table" && name !== "request_nonces")
			.map(async ({ name }) => ({
				table: name,
				rows: (
					await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
				).results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
			})),
	);
	return { catalog, tables };
}
async function nonces() {
	return (await db.prepare("SELECT * FROM request_nonces ORDER BY device_id,nonce").all()).results;
}
function laptop() {
	const pair = generateKeyPairSync("ed25519");
	const raw = Buffer.from(pair.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length, 0);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")} synthetic-current`;
	return {
		privateKey: pair.privateKey,
		signer: {
			groupId: origin.signer.groupId,
			deviceId: "receipt-http-current",
			publicKey,
			fingerprint: fingerprintPublicKey(publicKey),
		},
	};
}
async function setup() {
	await reset();
	const backend: AuthLinkBackend = {
		first: <T>(statement: AuthLinkStatement) => prepare(statement).first<T>(),
		all: async <T>(statement: AuthLinkStatement) => (await prepare(statement).all<T>()).results,
		run: async (statement) => (await prepare(statement).run()).meta.changes,
		batch: async (statements) =>
			(await db.batch(statements.map(prepare))).map((result) => result.meta.changes),
	};
	const store = new D1CoordinatorStore(db, { authClock: () => NOW });
	// Actual account birth and V3 refresh; provider discovery and callbacks stay local.
	const birth = await changeFixture(store, backend);
	await birth.prepare(1, "refresh", profile);
	expect(await birth.operations.finalize(birth.proof(1), config)).toMatchObject({
		intent: "refresh",
	});
	const { signer, privateKey } = laptop();
	await store.enrollDevice(signer.groupId, signer);
	const manifest = normalize({
		version: 1,
		coordinator_id: config.coordinatorId,
		candidate_ref: legacyTeamCandidateId(config.coordinatorId, "receipt-history-c"),
		candidate_digest: "a".repeat(64),
		team_id: "receipt-history-team",
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic historical C",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: "identity-c", role: "member" }],
		device_decisions: [
			{
				device_id: signer.deviceId,
				key_fingerprint: signer.fingerprint,
				enabled: true,
				identity_id: "identity-c",
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: now,
	});
	await exec(
		"INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?,?,1,?,?,?)",
		"receipt-history-c",
		manifest.candidate_ref,
		canonical(manifest),
		now,
		now,
	);
	const source = {
		...signer,
		groupId: "receipt-retained-source",
		publicKey: `${signer.publicKey} alias`,
	};
	await store.createGroup(source.groupId);
	await store.enrollDevice(source.groupId, source);
	const created = await store.createAuthControllerAttestation({
		...source,
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
	async function writeFact(resolutionId: string) {
		const target = await store.readAccountOwnerTarget(
			{ targetIdentityId: origin.identityId, signer: origin.signer },
			config,
		);
		if (target.kind !== "ready") throw new Error("native actual account birth unavailable");
		const controllerReview = {
			...signer,
			coordinatorId: config.coordinatorId,
			identityId: origin.identityId,
			attestationId: "resolution-controller",
			reviewReceiptId: "resolution-review",
			evidenceDigest: "d".repeat(64),
			verifiedSnapshot: {
				enrollmentIdentityId: "identity-c",
				invites: [],
				legacyHistory: await store.captureAuthControllerLegacyHistory({
					coordinatorId: config.coordinatorId,
					...signer,
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
		const collection = await evidence.collect({
			canonicalOwnerId: origin.identityId,
			actualSigner: signer,
			verifiedHistory: controllerReview.verifiedSnapshot.legacyHistory,
		});
		if (collection.kind !== "collected") throw new Error("native writer evidence unavailable");
		const ownershipEvidenceDigest = await evidence.reviewedEvidenceDigest(
			collection.recheckSnapshot,
		);
		if (!ownershipEvidenceDigest) throw new Error("native private evidence digest unavailable");
		const digest = createHash("sha256")
			.update(JSON.stringify({ controllerReview, ownershipEvidenceDigest, resolutionId }))
			.digest("hex");
		const result = await commitReviewedOwnerResolution({
			backend,
			evidence,
			now,
			review: {
				controllerReview,
				ownershipEvidenceDigest,
				existingController: created.attestation,
				existingResolution: null,
				resolutionId,
				consent: {
					purpose: "existing_account_owner",
					scope: "historical_included_owner_labels_only",
					evidenceDigest: digest,
					confirmedDigest: digest,
				},
			},
		});
		expect(Object.keys(result.controller)).toHaveLength(13);
		expect(Object.keys(result.resolution)).toHaveLength(20);
		// Read the actual persisted receipt, not IDs inferred from the writer input.
		const persisted = await db
			.prepare("SELECT * FROM coordinator_legacy_owner_resolutions WHERE resolution_id=?")
			.bind(resolutionId)
			.first<LegacyOwnerResolutionRecord>();
		expect(persisted).toEqual(result.resolution);
		if (!persisted) throw new Error("native persisted resolution missing");
		return persisted;
	}
	const fact = await writeFact("receipt-resolution-a");
	const oidc = oidcFixture({ issuer: config.issuer });
	const captured = captureCoordinatorBrowserAuthOptions({
		config: {
			...config,
			clientId: "synthetic-client",
			clientSecret: "synthetic-secret",
			redirectUri: `${ORIGIN}/auth/callback`,
		},
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
		oidcOptions: { fetch: oidc.fetch },
	});
	const auth = await createCoordinatorBrowserAuth(
		captured,
		store,
		createInMemoryRequestRateLimiter(),
	);
	if (!auth.ok) throw new Error(`native browser setup failed: ${auth.error}`);
	const verifier = vi.fn(verifyCloudflareCoordinatorRequest);
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => null, now: () => new Date().toISOString() },
		requestVerifier: verifier,
		browserAuth: {
			kind: "ready",
			auth: auth.auth,
			storeFactory: () => store,
			clientKey: () => "synthetic-client",
		},
	});
	return { store, backend, signer, privateKey, app, verifier, oidc, fact, writeFact };
}
function params(f: Fixture, row = f.fact) {
	return new URLSearchParams({
		group_id: f.signer.groupId,
		owner_identity_id: origin.identityId,
		coordinator_origin: ORIGIN,
		attestation_id: row.source_attestation_id,
		review_receipt_id: row.source_review_receipt_id,
		review_evidence_digest: row.source_evidence_digest,
		resolution_id: row.resolution_id,
		resolution_evidence_digest: row.resolution_evidence_digest,
	});
}
function path(f: Fixture) {
	return `${ROOT}?${params(f)}`;
}
function headers(f: Fixture, url = path(f), stale = false) {
	const timestamp = String(Math.floor(Date.now() / 1000) - (stale ? 10000 : 0));
	const requestNonce = String(++nonce).padStart(32, "0");
	return {
		"X-Opencode-Device": f.signer.deviceId,
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": requestNonce,
		"X-Opencode-Signature": `${SIGNATURE_VERSION}:${sign(null, buildCanonicalRequest("GET", url, timestamp, requestNonce, Buffer.alloc(0)), f.privateKey).toString("base64")}`,
	};
}
async function get(
	f: Fixture,
	options: { path?: string; headers?: Record<string, string>; host?: string } = {},
) {
	const url = options.path ?? path(f);
	const before = await snapshot();
	const providerCalls = f.oidc.requests.length;
	const response = await f.app.fetch(
		new Request(`${options.host ?? ORIGIN}${url}`, { headers: options.headers ?? headers(f, url) }),
		env,
	);
	expect(await snapshot()).toEqual(before);
	expect(f.oidc.requests).toHaveLength(providerCalls);
	expect(response.status).not.toBe(404);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("set-cookie")).toBeNull();
	expect(await response.clone().text()).not.toMatch(
		/attestation|reviewReceiptId|resolutionId|resolutionEvidenceDigest|public_key|publicKey|account-A|sourceRef|evidenceDigest|authority|canLink|grants|actions|eligibility|synthetic-secret/u,
	);
	return response;
}
function confirmed(f: Fixture) {
	return {
		version: 1,
		coordinatorId: config.coordinatorId,
		groupId: f.signer.groupId,
		deviceId: f.signer.deviceId,
		fingerprint: f.signer.fingerprint,
		state: "owner_confirmed",
		ownerIdentity: origin.identityId,
		profileState: "linked",
		profile: withheldProfile,
	};
}
function unconfirmed(f: Fixture) {
	return {
		...confirmed(f),
		state: "owner_unconfirmed",
		ownerIdentity: null,
		profileState: "unavailable",
		profile: null,
	};
}

it("native eight-selector GET compiles the constrained final SELECT and returns only the nine-field safe profile", async () => {
	// Arrange: ordinary storage IDs remain valid; the weak current label grants no account authority.
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
	const ordinary = await f.store.readAccountLinkStatus(f.signer, config, {
		identityId: origin.identityId,
	});
	const read = vi.spyOn(f.store, "readResolvedAccountOwnerStatus");
	const cleanup = vi.spyOn(f.store, "cleanupNonces");
	const before = await nonces();
	// Act
	const response = await get(f);
	// Assert
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(confirmed(f));
	expect([...params(f)]).toHaveLength(8);
	expect(f.fact.source_attestation_id).toBe("original-controller");
	expect(read).toHaveBeenCalledWith(f.signer, expect.objectContaining(config), {
		ownerIdentityId: origin.identityId,
		expectedReceipt: {
			attestationId: f.fact.source_attestation_id,
			reviewReceiptId: f.fact.source_review_receipt_id,
			reviewEvidenceDigest: f.fact.source_evidence_digest,
			resolutionId: f.fact.resolution_id,
			resolutionEvidenceDigest: f.fact.resolution_evidence_digest,
		},
	});
	expect(f.verifier).toHaveBeenCalledOnce();
	expect(await f.verifier.mock.results[0].value).toBe(true);
	expect(cleanup).toHaveBeenCalledOnce();
	expect(await nonces()).toHaveLength(before.length + 1);
	expect(ordinary.state).not.toBe("linked");
	expect(
		await f.store.readAccountLinkStatus(f.signer, config, { identityId: origin.identityId }),
	).toEqual(ordinary);
});

it("native wrong receipt fields and foreign owner never borrow the valid persisted A fact", async () => {
	// Arrange
	const f = await setup();
	for (const field of [
		"attestation_id",
		"review_receipt_id",
		"review_evidence_digest",
		"resolution_id",
		"resolution_evidence_digest",
		"owner_identity_id",
	]) {
		const query = params(f);
		query.set(field, field.endsWith("digest") ? "0".repeat(64) : "other-valid-reference");
		// Act
		const response = await get(f, { path: `${ROOT}?${query}` });
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(unconfirmed(f));
	}
});

it("native two genuine same-owner receipts succeed separately but mixed resolution ID and digest fail", async () => {
	// Arrange: both facts come from the checked writer, with distinct actual consent digests.
	const f = await setup();
	const second = await f.writeFact("receipt-resolution-second");
	expect(second.resolution_evidence_digest).not.toBe(f.fact.resolution_evidence_digest);
	const mixed = params(f);
	mixed.set("resolution_id", second.resolution_id);
	// Act
	const first = await get(f);
	const next = await get(f, { path: `${ROOT}?${params(f, second)}` });
	const rejected = await get(f, { path: `${ROOT}?${mixed}` });
	// Assert
	for (const response of [first, next]) {
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(confirmed(f));
	}
	expect(rejected.status).toBe(200);
	expect(await rejected.json()).toEqual(unconfirmed(f));
});

it("native stale, revoked and missing original sources deny the otherwise exact receipt", async () => {
	// Arrange
	const f = await setup();
	for (const assignment of [
		"review_receipt_id='stale-review'",
		`review_receipt_id='original-review',revoked_at='${now}'`,
	]) {
		await exec(
			`UPDATE coordinator_auth_controller_attestations SET ${assignment} WHERE attestation_id='original-controller'`,
		);
		// Act
		const response = await get(f);
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(unconfirmed(f));
	}
	// Arrange
	await exec(
		"DELETE FROM coordinator_auth_controller_attestations WHERE attestation_id='original-controller'",
	);
	// Act
	const missing = await get(f);
	// Assert
	expect(missing.status).toBe(200);
	expect(await missing.json()).toEqual(unconfirmed(f));
});

it("native missing or duplicate selectors, extras and malformed hashes fail before owner reads and nonce admission", async () => {
	// Arrange
	const f = await setup();
	const read = vi.spyOn(f.store, "readResolvedAccountOwnerStatus");
	const queries: URLSearchParams[] = [];
	for (const [field, value] of params(f)) {
		const missing = params(f);
		missing.delete(field);
		queries.push(missing);
		const duplicate = params(f);
		duplicate.append(field, value);
		queries.push(duplicate);
	}
	for (const [field, value] of [
		["authority", "controller_attestation"],
		["review_evidence_digest", "E".repeat(64)],
		["resolution_evidence_digest", "bad-hash"],
	]) {
		const query = params(f);
		query.set(field, value);
		queries.push(query);
	}
	const before = await nonces();
	// Act
	const responses = [];
	for (const query of queries) responses.push(await get(f, { path: `${ROOT}?${query}` }));
	// Assert
	for (const response of responses) {
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "auth_link_invalid_input" });
	}
	expect(read).not.toHaveBeenCalled();
	expect(f.verifier).not.toHaveBeenCalled();
	expect(await nonces()).toEqual(before);
});

it("native signatures bind all five receipt query fields and reject stale or missing proof", async () => {
	// Arrange
	const f = await setup();
	const before = await nonces();
	for (const field of [
		"attestation_id",
		"review_receipt_id",
		"review_evidence_digest",
		"resolution_id",
		"resolution_evidence_digest",
		"stale",
		"unsigned",
	]) {
		const signed: Record<string, string> = headers(f, path(f), field === "stale");
		const query = params(f);
		if (field === "unsigned") delete signed["X-Opencode-Signature"];
		else if (field !== "stale")
			query.set(field, field.endsWith("digest") ? "0".repeat(64) : "tampered-reference");
		// Act
		const response = await get(f, { path: `${ROOT}?${query}`, headers: signed });
		// Assert
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "auth_link_unavailable" });
		expect(await nonces()).toEqual(before);
	}
});

it("native nonce admission accepts a receipt once then rejects replay without another cleanup", async () => {
	// Arrange
	const f = await setup();
	const signed = headers(f);
	const cleanup = vi.spyOn(f.store, "cleanupNonces");
	const before = await nonces();
	// Act
	const first = await get(f, { headers: signed });
	const admitted = await nonces();
	const replay = await get(f, { headers: signed });
	// Assert
	expect(first.status).toBe(200);
	expect(await first.json()).toEqual(confirmed(f));
	expect(replay.status).toBe(401);
	expect(await replay.json()).toEqual({ error: "auth_link_unavailable" });
	expect(admitted).toHaveLength(before.length + 1);
	expect(await nonces()).toEqual(admitted);
	expect(cleanup).toHaveBeenCalledOnce();
});

it("native host and signed recipient binding reject foreign origins before nonce admission", async () => {
	// Arrange
	const f = await setup();
	const query = params(f);
	query.set("coordinator_origin", "https://foreign.example.test");
	const before = await nonces();
	// Act
	const host = await get(f, { host: "https://foreign.example.test" });
	const recipient = await get(f, { path: `${ROOT}?${query}` });
	// Assert
	for (const response of [host, recipient]) {
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "auth_link_unavailable" });
	}
	expect(f.verifier).not.toHaveBeenCalled();
	expect(await nonces()).toEqual(before);
});

it("native current device and canonical key revocations deny even correctly signed exact receipts", async () => {
	// Arrange
	const f = await setup();
	const before = await nonces();
	for (const kind of ["device_id", "ed25519_key"] as const) {
		await exec("DELETE FROM coordinator_device_revocations");
		await exec(
			"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?)",
			kind,
			kind === "device_id"
				? f.signer.deviceId
				: await ed25519KeyIdForRevocation(f.signer.publicKey),
			`receipt-revocation-${kind}`,
			f.signer.groupId,
			f.signer.deviceId,
			f.signer.publicKey,
			f.signer.fingerprint,
			now,
		);
		// Act
		const response = await get(f);
		// Assert
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "auth_link_unavailable" });
		expect(await nonces()).toEqual(before);
	}
});

it("native constrained final SELECT rechecks the original source after candidate and evidence reads", async () => {
	// Arrange: inject only at the real native final SELECT, never replace its result or SQL.
	const f = await setup();
	const query = params(f);
	let finalReads = 0;
	let afterMutation: Awaited<ReturnType<typeof snapshot>> | undefined;
	const backend = {
		...f.backend,
		async first<T>(statement: AuthLinkStatement) {
			if (
				statement.sql.includes("coordinator_legacy_owner_resolutions") &&
				/coordinator_auth_(?:account|link)_profiles/u.test(statement.sql)
			) {
				finalReads++;
				await exec(
					"UPDATE coordinator_auth_controller_attestations SET revoked_at=? WHERE attestation_id='original-controller'",
					now,
				);
				afterMutation = await snapshot();
			}
			return prepare(statement).first<T>();
		},
		all: async <T>(statement: AuthLinkStatement) => (await prepare(statement).all<T>()).results,
	};
	// Act
	const result = await new ResolvedAccountOwnerStatusOperations(
		backend,
	).readResolvedAccountOwnerStatus(f.signer, config, {
		ownerIdentityId: origin.identityId,
		expectedReceipt: {
			attestationId: query.get("attestation_id"),
			reviewReceiptId: query.get("review_receipt_id"),
			reviewEvidenceDigest: query.get("review_evidence_digest"),
			resolutionId: query.get("resolution_id"),
			resolutionEvidenceDigest: query.get("resolution_evidence_digest"),
		},
	});
	// Assert
	expect(finalReads).toBe(1);
	expect(afterMutation).toBeDefined();
	expect(result).toEqual(unconfirmed(f));
	expect(await snapshot()).toEqual(afterMutation);
});

it("native original three-selector route remains unconstrained while the receipt route rejects a wrong reference", async () => {
	// Arrange
	const f = await setup();
	const ordinary = new URLSearchParams({
		group_id: f.signer.groupId,
		owner_identity_id: origin.identityId,
		coordinator_origin: ORIGIN,
	});
	const wrong = params(f);
	wrong.set("resolution_id", "missing-resolution");
	// Act
	const accepted = await get(f, { path: `/v1/auth/resolved-account-owner-status?${ordinary}` });
	const rejected = await get(f, { path: `${ROOT}?${wrong}` });
	// Assert
	expect(accepted.status).toBe(200);
	expect(await accepted.json()).toEqual(confirmed(f));
	expect(rejected.status).toBe(200);
	expect(await rejected.json()).toEqual(unconfirmed(f));
});
