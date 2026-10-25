import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "../../core/src/coordinator-api.js";
import type { AuthLinkBackend, AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
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
const path = "/v1/admin/auth-controller-reviews";
const secret = "synthetic-native-review-admin";
const scope = "historical_included_owner_labels_only";
const controllerTable = "coordinator_auth_controller_attestations";
const resolutionTable = "coordinator_legacy_owner_resolutions";
const receipts = [controllerTable, resolutionTable];
type Definition = { type: string; name: string; sql: string };
let initialDefinitions: Definition[] | undefined;

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

const prepare = ({ sql, values }: AuthLinkStatement) => db.prepare(sql).bind(...values);
const exec = (sql: string, ...values: AuthLinkStatement["values"]) =>
	prepare({ sql, values }).run();
async function rows(table: string) {
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
	const current = await definitions();
	if (!initialDefinitions) initialDefinitions = current;
	else {
		// Ephemeral reset between cases only; retain the complete installed graph and guards.
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
		deviceId: "http-review-current",
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
	const backend: AuthLinkBackend = {
		first: <T>(statement: AuthLinkStatement) => prepare(statement).first<T>(),
		run: async (statement) => (await prepare(statement).run()).meta.changes,
		batch: async (statements) => {
			await db.batch(statements.map(prepare));
		},
	};
	const store = new D1CoordinatorStore(db, { authClock: () => NOW });
	// Genuine claim/browser/finalization provenance; verified provider claims are local fixtures.
	await changeFixture(store, backend);
	const signer = laptop();
	await store.enrollDevice(signer.groupId, signer);
	await history(signer);
	if (options.weakCurrent !== false)
		await exec(
			"UPDATE enrolled_devices SET identity_id='identity-c' WHERE device_id=?",
			signer.deviceId,
		);
	const input = {
		purpose: "existing_account_owner",
		resolution_scope: scope,
		group_id: signer.groupId,
		device_id: signer.deviceId,
		identity_id: origin.identityId,
		fingerprint: signer.fingerprint,
	};
	const factory = vi.fn(() => store);
	const app = createCoordinatorApp({
		storeFactory: factory,
		requestVerifier: async () => false,
		runtime: { adminSecret: () => secret, now: () => now },
		authLink: {
			config: { ...config, redirectUri: "https://coordinator.example.test/auth/callback" },
			storeFactory: factory,
		},
	});
	const request = (body: unknown = input, admin: string | null = secret) =>
		app.fetch(
			new Request(`https://coordinator.example.test${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(admin === null ? {} : { "X-Codemem-Coordinator-Admin": admin }),
					Cookie: "synthetic-private-cookie",
					"X-Codemem-Admin-Actor": "identity-a",
				},
				body: JSON.stringify(body),
			}),
			env,
		);
	return { store, signer, input, factory, request };
}
function secure(response: Response) {
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
function safe(dto: unknown) {
	expect(JSON.stringify(dto)).not.toMatch(
		/public_key|publicKey|providerSubject|email|issuer|token|ownershipEvidenceDigest|recheckSnapshot|authority|account-A|synthetic-native-review-admin|synthetic-private-cookie/u,
	);
}

it("native HTTP preview proves A despite historical weak C and writes nothing", async () => {
	// Arrange
	const f = await setup();
	const before = await snapshot();
	// Act
	const response = await f.request();
	const dto = await response.json();
	// Assert
	expect(response.status).toBe(200);
	secure(response);
	safe(dto);
	expect(dto).toMatchObject({
		...f.input,
		state: "ready",
		account_owner_target: { identity_id: origin.identityId },
		reviewed_weak_labels: expect.arrayContaining([
			expect.objectContaining({ label: "identity-c" }),
		]),
		owner_resolution_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
	});
	expect(Object.keys(dto.account_owner_target).sort()).toEqual([
		"auth_config_revision",
		"created_at_ms",
		"identity_id",
		"link_id",
	]);
	for (const table of receipts) expect(await rows(table)).toEqual([]);
	expect(await snapshot()).toEqual(before);
});

it("native HTTP fresh confirmation creates exactly two linked checked receipts", async () => {
	// Arrange
	const f = await setup();
	const preview = await (await f.request()).json();
	const digest = preview.owner_resolution_digest;
	const before = await snapshot(receipts);
	// Act
	const response = await f.request({ ...f.input, confirm_owner_resolution_digest: digest });
	const dto = await response.json();
	// Assert
	expect(response.status).toBe(201);
	secure(response);
	safe(dto);
	expect(dto).toMatchObject({
		...f.input,
		state: "ready",
		recovery_receipt: { disposition: "created", evidence_digest: digest },
		owner_resolution: { disposition: "created", evidence_digest: digest },
	});
	expect(await rows(controllerTable)).toEqual([
		expect.objectContaining({
			attestation_id: dto.attestation_id,
			identity_id: origin.identityId,
			enrollment_identity_id: "identity-c",
			public_key: f.signer.publicKey,
			review_receipt_id: dto.recovery_receipt.review_receipt_id,
			evidence_digest: digest,
		}),
	]);
	expect(await rows(resolutionTable)).toEqual([
		expect.objectContaining({
			resolution_id: dto.owner_resolution.resolution_id,
			source_attestation_id: dto.attestation_id,
			source_review_receipt_id: dto.recovery_receipt.review_receipt_id,
			resolution_evidence_digest: digest,
		}),
	]);
	expect(await snapshot(receipts)).toEqual(before);
});

it("native HTTP wrong admin and missing admin never open the store even with invalid input", async () => {
	// Arrange
	const f = await setup();
	const before = await snapshot();
	// Act
	const responses = [await f.request(null, "wrong-admin"), await f.request(null, null)];
	// Assert
	expect(responses.map(({ status }) => status)).toEqual([401, 401]);
	for (const response of responses) {
		secure(response);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	}
	expect(f.factory).not.toHaveBeenCalled();
	expect(await snapshot()).toEqual(before);
});

it("native HTTP strict scoped parsing rejects wrong scope, purpose and unknown fields before store", async () => {
	// Arrange
	const f = await setup();
	const before = await snapshot();
	const patches = [
		{ resolution_scope: "all_owners" },
		{ resolution_scope: null },
		{ purpose: undefined },
		{ raw_record: {} },
		{ ownershipEvidenceDigest: "a".repeat(64) },
		{ group_id: " " },
		{ device_id: "\n" },
		{ fingerprint: `${"a".repeat(64)}\n` },
	];
	// Act
	const responses = [];
	for (const patch of patches) responses.push(await f.request({ ...f.input, ...patch }));
	// Assert
	expect(responses.map(({ status }) => status)).toEqual(patches.map(() => 400));
	for (const response of responses) {
		secure(response);
		expect(await response.json()).toEqual({ error: "review_invalid_input" });
	}
	expect(f.factory).not.toHaveBeenCalled();
	expect(await snapshot()).toEqual(before);
});

it("native HTTP scoped mode rejects ordinary and malformed confirmation instead of approving", async () => {
	// Arrange
	const f = await setup();
	const before = await snapshot();
	const patches = [
		{ confirm_evidence_digest: "a".repeat(64) },
		{ confirm_owner_resolution_digest: null },
		{ confirm_owner_resolution_digest: "" },
		{ confirm_owner_resolution_digest: `${"a".repeat(64)}\n` },
	];
	// Act
	const responses = [];
	for (const patch of patches) responses.push(await f.request({ ...f.input, ...patch }));
	// Assert
	expect(responses.map(({ status }) => status)).toEqual(patches.map(() => 400));
	expect(f.factory).not.toHaveBeenCalled();
	expect(await snapshot()).toEqual(before);
});

it("native HTTP well-formed wrong digest returns stale without writes", async () => {
	// Arrange
	const f = await setup();
	await f.request();
	const before = await snapshot();
	// Act
	const response = await f.request({ ...f.input, confirm_owner_resolution_digest: "0".repeat(64) });
	// Assert
	expect(response.status).toBe(409);
	secure(response);
	expect(await response.json()).toEqual({ error: "review_stale" });
	expect(await snapshot()).toEqual(before);
});

it("native HTTP changed history invalidates the API digest without receipt writes", async () => {
	// Arrange
	const f = await setup();
	const old = await (await f.request()).json();
	await history(f.signer, "history-d", "identity-d");
	const before = await snapshot();
	// Act
	const fresh = await (await f.request()).json();
	const response = await f.request({
		...f.input,
		confirm_owner_resolution_digest: old.owner_resolution_digest,
	});
	// Assert
	expect(fresh.state).toBe("ready");
	expect(fresh.owner_resolution_digest).not.toBe(old.owner_resolution_digest);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "review_stale" });
	expect(await snapshot()).toEqual(before);
});

it("native HTTP lost response restores actual receipts read-only and rejects the old confirmation", async () => {
	// Arrange
	const f = await setup();
	const initial = await (await f.request()).json();
	const body = { ...f.input, confirm_owner_resolution_digest: initial.owner_resolution_digest };
	const applied = await (await f.request(body)).json();
	const before = await snapshot();
	// Act
	const stale = await f.request(body);
	const response = await f.request();
	const restored = await response.json();
	const reused = await f.request({
		...f.input,
		confirm_owner_resolution_digest: restored.owner_resolution_digest,
	});
	// Assert
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({ error: "review_stale" });
	expect(response.status).toBe(200);
	secure(response);
	safe(restored);
	expect(restored).toMatchObject({
		state: "restored",
		attestation_id: applied.attestation_id,
		recovery_receipt: { ...applied.recovery_receipt, disposition: "reused" },
		owner_resolution: { ...applied.owner_resolution, disposition: "reused" },
	});
	expect(reused.status).toBe(200);
	expect(await reused.json()).toMatchObject({
		state: "ready",
		attestation_id: applied.attestation_id,
		recovery_receipt: { ...applied.recovery_receipt, disposition: "reused" },
		owner_resolution: { ...applied.owner_resolution, disposition: "reused" },
	});
	for (const table of receipts) expect(await rows(table)).toHaveLength(1);
	expect(await snapshot()).toEqual(before);
});

it("native HTTP disabled requester previews needs-review and cannot confirm", async () => {
	// Arrange
	const f = await setup();
	const initial = await (await f.request()).json();
	await exec("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?", f.signer.deviceId);
	const before = await snapshot();
	// Act
	const response = await f.request();
	const dto = await response.json();
	const confirm = await f.request({
		...f.input,
		confirm_owner_resolution_digest: initial.owner_resolution_digest,
	});
	// Assert
	expect(response.status).toBe(200);
	secure(response);
	safe(dto);
	expect(dto).toMatchObject({ ...f.input, state: "needs_review", reasons: expect.any(Array) });
	expect(dto.reasons.length).toBeGreaterThan(0);
	expect(dto).not.toHaveProperty("owner_resolution_digest");
	expect(confirm.status).toBe(409);
	expect(await snapshot()).toEqual(before);
});

it("native HTTP unknown postcommit reply is safe and status reads the real committed receipts", async () => {
	// Arrange: real native checked writer succeeds before the simulated reply loss.
	const f = await setup();
	const confirm = f.store.confirmOwnerResolutionReview.bind(f.store);
	vi.spyOn(f.store, "confirmOwnerResolutionReview").mockImplementationOnce(async (...args) => {
		await confirm(...args);
		throw new Error("synthetic SQL private reply lost");
	});
	const preview = await (await f.request()).json();
	const unaffected = await snapshot(receipts);
	// Act
	const response = await f.request({
		...f.input,
		confirm_owner_resolution_digest: preview.owner_resolution_digest,
	});
	const dto = await response.json();
	const before = await snapshot();
	const restored = await (await f.request()).json();
	// Assert
	expect(response.status).toBe(503);
	secure(response);
	safe(dto);
	expect(dto).toEqual({
		error: "owner_resolution_outcome_unknown",
		action: "Preview status before confirming again",
	});
	expect(restored).toMatchObject({
		state: "restored",
		recovery_receipt: { disposition: "reused" },
		owner_resolution: { disposition: "reused" },
	});
	for (const table of receipts) expect(await rows(table)).toHaveLength(1);
	expect(await snapshot(receipts)).toEqual(unaffected);
	expect(await snapshot()).toEqual(before);
});

it("native HTTP absent scope keeps ordinary owner review controller-only and rejects scoped digest", async () => {
	// Arrange: ordinary path uses NULL enrollment, not the correctly denied weak-C path.
	const f = await setup({ weakCurrent: false });
	const { resolution_scope: _scope, ...ordinary } = f.input;
	const before = await snapshot([controllerTable, "coordinator_auth_link_audit_log"]);
	const preview = await (await f.request(ordinary)).json();
	// Act
	const invalid = await f.request({ ...ordinary, confirm_owner_resolution_digest: "a".repeat(64) });
	const response = await f.request({
		...ordinary,
		confirm_evidence_digest: preview.evidence_digest,
	});
	const dto = await response.json();
	// Assert
	expect(invalid.status).toBe(400);
	expect(preview.state).toBe("ready");
	expect(response.status).toBe(201);
	secure(response);
	safe(dto);
	expect(dto).toMatchObject({ purpose: "existing_account_owner", state: "created" });
	expect(dto).not.toHaveProperty("resolution_scope");
	expect(await rows(controllerTable)).toHaveLength(1);
	expect(await rows(resolutionTable)).toEqual([]);
	expect(await snapshot([controllerTable, "coordinator_auth_link_audit_log"])).toEqual(before);
});
