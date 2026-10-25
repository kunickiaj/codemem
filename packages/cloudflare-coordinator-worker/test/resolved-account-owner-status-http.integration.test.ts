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
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "../../core/src/coordinator-legacy-team-completion.js";
import { oidcFixture } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { legacyTeamCandidateId } from "../../core/src/recipient-policy-identifiers.js";
import { createInMemoryRequestRateLimiter } from "../../core/src/request-rate-limit.js";
import { buildCanonicalRequest, SIGNATURE_VERSION } from "../../core/src/sync-auth.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { verifyCloudflareCoordinatorRequest } from "../src/request-verifier.js";
import { changeFixture, config, NOW, input as origin } from "./account-change-fixture.js";
import { resetCeremony } from "./owner-ceremony-test-fixtures.js";

const db = env.COORDINATOR_DB;
const ROOT = "/v1/auth/resolved-account-owner-status";
const ORIGIN = "https://coordinator.example.test";
const now = new Date(NOW).toISOString();
const originalIssuer = config.issuer;
const profile = {
	displayName: "Synthetic HTTP Owner A",
	email: "owner-a@example.test",
	emailVerified: true,
	pictureUrl: "https://lh3.googleusercontent.com/synthetic-owner-a",
};
const publicProfile = {
	displayName: profile.displayName,
	email: profile.email,
	pictureUrl: profile.pictureUrl,
};
type Definition = { type: string; name: string; sql: string };
type Fixture = Awaited<ReturnType<typeof setup>>;
let initialDefinitions: Definition[] | undefined;
let nonce = 0;

beforeEach(() => {
	// Worker freshness deliberately uses the real wall clock, not the account fixture clock.
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
		// Rebuild only this test's ephemeral graph; never relax its installed triggers.
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
			deviceId: "resolved-http-current",
			publicKey,
			fingerprint: fingerprintPublicKey(publicKey),
		},
	};
}
async function setup(options: { fact?: boolean } = {}) {
	await reset();
	const backend: AuthLinkBackend = {
		first: <T>(statement: AuthLinkStatement) => prepare(statement).first<T>(),
		all: async <T>(statement: AuthLinkStatement) => (await prepare(statement).all<T>()).results,
		run: async (statement) => (await prepare(statement).run()).meta.changes,
		batch: async (statements) =>
			(await db.batch(statements.map(prepare))).map((result) => result.meta.changes),
	};
	const store = new D1CoordinatorStore(db, { authClock: () => NOW });
	// Actual accepted claim/browser/finalization and V3 refresh; provider results are local fixtures.
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
		candidate_ref: legacyTeamCandidateId(config.coordinatorId, "http-history-c"),
		candidate_digest: "a".repeat(64),
		team_id: "http-history-team",
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
		"http-history-c",
		manifest.candidate_ref,
		canonical(manifest),
		now,
		now,
	);
	const source = {
		...signer,
		groupId: "http-retained-source",
		publicKey: `${signer.publicKey} alias`,
	};
	await store.createGroup(source.groupId);
	await store.enrollDevice(source.groupId, source);
	const created = await store.createAuthControllerAttestation({
		...source,
		coordinatorId: config.coordinatorId,
		identityId: origin.identityId,
		attestationId: "http-original-controller",
		reviewReceiptId: "http-original-review",
		evidenceDigest: "e".repeat(64),
	});
	if (created.kind !== "created") throw new Error("native HTTP retained controller rejected");
	await exec(
		"UPDATE enrolled_devices SET identity_id='identity-c' WHERE group_id=? AND device_id=?",
		signer.groupId,
		signer.deviceId,
	);
	if (options.fact !== false) {
		const target = await store.readAccountOwnerTarget(
			{ targetIdentityId: origin.identityId, signer: origin.signer },
			config,
		);
		if (target.kind !== "ready") throw new Error("native HTTP actual account birth unavailable");
		const controllerReview = {
			...signer,
			coordinatorId: config.coordinatorId,
			identityId: origin.identityId,
			attestationId: "http-resolution-controller",
			reviewReceiptId: "http-resolution-review",
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
		const evidence = new CoordinatorDeviceOwnershipEvidence(backend, config);
		const collection = await evidence.collect({
			canonicalOwnerId: origin.identityId,
			actualSigner: signer,
			verifiedHistory: controllerReview.verifiedSnapshot.legacyHistory,
		});
		if (collection.kind !== "collected") throw new Error("native HTTP writer evidence unavailable");
		const ownershipEvidenceDigest = await evidence.reviewedEvidenceDigest(
			collection.recheckSnapshot,
		);
		if (!ownershipEvidenceDigest)
			throw new Error("native HTTP private evidence digest unavailable");
		const digest = createHash("sha256")
			.update(JSON.stringify({ controllerReview, ownershipEvidenceDigest }))
			.digest("hex");
		await commitReviewedOwnerResolution({
			backend,
			evidence,
			now,
			review: {
				controllerReview,
				ownershipEvidenceDigest,
				existingController: created.attestation,
				existingResolution: null,
				resolutionId: "http-resolution-a",
				consent: {
					purpose: "existing_account_owner",
					scope: "historical_included_owner_labels_only",
					evidenceDigest: digest,
					confirmedDigest: digest,
				},
			},
		});
	}
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
	if (!auth.ok) throw new Error(`native HTTP browser setup failed: ${auth.error}`);
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
	return { store, signer, privateKey, app, verifier, oidc };
}
function path(f: Fixture, owner = origin.identityId, recipient = ORIGIN) {
	return `${ROOT}?${new URLSearchParams({
		group_id: f.signer.groupId,
		owner_identity_id: owner,
		coordinator_origin: recipient,
	})}`;
}
function headers(f: Fixture, url = path(f), options: { stale?: boolean; wrongKey?: boolean } = {}) {
	const timestamp = String(Math.floor(Date.now() / 1000) - (options.stale ? 10000 : 0));
	const requestNonce = String(++nonce).padStart(32, "0");
	const key = options.wrongKey ? generateKeyPairSync("ed25519").privateKey : f.privateKey;
	return {
		"X-Opencode-Device": f.signer.deviceId,
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": requestNonce,
		"X-Opencode-Signature": `${SIGNATURE_VERSION}:${sign(
			null,
			buildCanonicalRequest("GET", url, timestamp, requestNonce, Buffer.alloc(0)),
			key,
		).toString("base64")}`,
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
		new Request(`${options.host ?? ORIGIN}${url}`, {
			headers: options.headers ?? headers(f, url),
		}),
		env,
	);
	expect(await snapshot()).toEqual(before);
	expect(f.oidc.requests).toHaveLength(providerCalls);
	expect(response.status).not.toBe(404);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("set-cookie")).toBeNull();
	expect(await response.clone().text()).not.toMatch(
		/public_key|publicKey|account-A|sourceRef|evidenceDigest|authority|canLink|grants|actions|eligibility|synthetic-secret/u,
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
		profile: publicProfile,
	};
}

it("native signed weak C displays proven A read-only, without ordinary authority", async () => {
	// Arrange
	const f = await setup();
	const ordinary = await f.store.readAccountLinkStatus(f.signer, config, {
		identityId: origin.identityId,
	});
	const before = await nonces();
	const cleanup = vi.spyOn(f.store, "cleanupNonces");
	// Act
	const response = await get(f);
	// Assert
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(confirmed(f));
	expect(f.verifier).toHaveBeenCalledOnce();
	expect(await f.verifier.mock.results[0].value).toBe(true);
	expect(cleanup).toHaveBeenCalledOnce();
	expect(await nonces()).toHaveLength(before.length + 1);
	expect(ordinary.state).not.toBe("linked");
	expect(
		await f.store.readAccountLinkStatus(f.signer, config, { identityId: origin.identityId }),
	).toEqual(ordinary);
});

it.each(["missing signature", "wrong key", "expired timestamp", "owner tamper", "group tamper"])(
	"native signed authentication rejects %s without nonce admission or disclosure",
	async (mode) => {
		// Arrange
		const f = await setup();
		let url = path(f);
		const signed: Record<string, string> = headers(f, url, {
			wrongKey: mode === "wrong key",
			stale: mode === "expired timestamp",
		});
		if (mode === "missing signature") delete signed["X-Opencode-Signature"];
		if (mode === "owner tamper") url = path(f, "other-owner");
		if (mode === "group tamper") {
			// An actual enrollment in the other group ensures rejection tests signed query bytes.
			await f.store.createGroup("other-group");
			await f.store.enrollDevice("other-group", f.signer);
			url = url.replace("group_id=group-a", "group_id=other-group");
		}
		const before = await nonces();
		// Act
		const response = await get(f, { path: url, headers: signed });
		// Assert
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "auth_link_unavailable" });
		expect(await nonces()).toEqual(before);
		if (mode !== "missing signature") {
			expect(f.verifier).toHaveBeenCalledOnce();
			expect(await f.verifier.mock.results[0].value).toBe(false);
		}
	},
);

it("native nonce writer admits once and rejects replay without another cleanup or owner write", async () => {
	// Arrange
	const f = await setup();
	const signed = headers(f);
	const cleanup = vi.spyOn(f.store, "cleanupNonces");
	const before = await nonces();
	// Act
	const accepted = await get(f, { headers: signed });
	const after = await nonces();
	const replay = await get(f, { headers: signed });
	// Assert
	expect(accepted.status).toBe(200);
	expect(await accepted.json()).toEqual(confirmed(f));
	expect(replay.status).toBe(401);
	expect(await replay.json()).toEqual({ error: "auth_link_unavailable" });
	expect(await nonces()).toEqual(after);
	expect(after).toHaveLength(before.length + 1);
	expect(cleanup).toHaveBeenCalledOnce();
});

it("native recipient binding rejects changed host and valid signatures for the wrong origin", async () => {
	// Arrange: v2 excludes host, so both host and signed recipient must match trusted config.
	const f = await setup();
	const wrong = path(f, origin.identityId, "https://other.example.test");
	const before = await nonces();
	// Act
	const wrongHost = await get(f, { host: "https://other.example.test" });
	const wrongRecipient = await get(f, { path: wrong, headers: headers(f, wrong) });
	// Assert
	for (const response of [wrongHost, wrongRecipient]) {
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "auth_link_unavailable" });
	}
	expect(f.verifier).not.toHaveBeenCalled();
	expect(await nonces()).toEqual(before);
});

it("native exact query rejects duplicates and caller overrides before verification", async () => {
	// Arrange
	const f = await setup();
	const before = await nonces();
	const suffixes = [
		"&owner_identity_id=identity-a",
		"&group_id=group-a",
		`&coordinator_origin=${encodeURIComponent(ORIGIN)}`,
		"&authority=device_claim",
		"&coordinator_id=caller",
	];
	// Act
	const responses = [];
	for (const suffix of suffixes) responses.push(await get(f, { path: path(f) + suffix }));
	// Assert
	for (const response of responses) {
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "auth_link_invalid_input" });
	}
	expect(f.verifier).not.toHaveBeenCalled();
	expect(await nonces()).toEqual(before);
});

it("native valid signatures cannot disclose after global current device or key revocation", async () => {
	// Arrange
	const f = await setup();
	const before = await nonces();
	for (const kind of ["device_id", "ed25519_key"] as const) {
		const signed = headers(f);
		// Prove these exact bytes pass the native verifier independently of the revocation gate.
		expect(
			await verifyCloudflareCoordinatorRequest({
				method: "GET",
				pathWithQuery: path(f),
				bodyBytes: new Uint8Array(),
				publicKey: f.signer.publicKey,
				deviceId: f.signer.deviceId,
				timestamp: signed["X-Opencode-Timestamp"],
				nonce: signed["X-Opencode-Nonce"],
				signature: signed["X-Opencode-Signature"],
			}),
		).toBe(true);
		await exec("DELETE FROM coordinator_device_revocations");
		await exec(
			"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?)",
			kind,
			kind === "device_id"
				? f.signer.deviceId
				: await ed25519KeyIdForRevocation(f.signer.publicKey),
			`http-revocation-${kind}`,
			f.signer.groupId,
			f.signer.deviceId,
			f.signer.publicKey,
			f.signer.fingerprint,
			now,
		);
		// Act
		const response = await get(f, { headers: signed });
		// Assert
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "auth_link_unavailable" });
		expect(await nonces()).toEqual(before);
	}
});

it.each(["missing source", "missing fact"])(
	"native %s never discloses A's profile",
	async (mode) => {
		// Arrange
		const f = await setup({ fact: mode !== "missing fact" });
		if (mode === "missing source")
			await exec(
				"DELETE FROM coordinator_auth_controller_attestations WHERE attestation_id='http-original-controller'",
			);
		// Act
		const response = await get(f);
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			...confirmed(f),
			state: "owner_unconfirmed",
			ownerIdentity: null,
			profileState: "unavailable",
			profile: null,
		});
	},
);

it("native original OTHER-key retirement preserves A without granting weak C authority", async () => {
	// Arrange
	const f = await setup();
	await exec(
		"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES ('ed25519_key',?,?,?,?,?,?,?)",
		await ed25519KeyIdForRevocation(origin.signer.publicKey),
		"http-other-key-retired",
		origin.signer.groupId,
		origin.signer.deviceId,
		origin.signer.publicKey,
		origin.signer.fingerprint,
		now,
	);
	// Act
	const response = await get(f);
	// Assert
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(confirmed(f));
	expect(
		(await f.store.readAccountLinkStatus(f.signer, config, { identityId: origin.identityId }))
			.state,
	).not.toBe("linked");
});

it("native missing schema capability returns safe unavailable without DDL or owner writes", async () => {
	// Arrange: genuine native schema failure, not a successful projection stub.
	const f = await setup();
	await exec("DROP INDEX idx_legacy_owner_resolutions_key");
	// Act
	const response = await get(f);
	// Assert
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: "auth_link_unavailable" });
});
