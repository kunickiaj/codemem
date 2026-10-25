import { env } from "cloudflare:workers";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CONNECTION_BIRTH_COLUMNS } from "../../core/src/coordinator-account-connection-storage.js";
import { createCoordinatorApp } from "../../core/src/coordinator-api.js";
import type { AuthLinkBackend } from "../../core/src/coordinator-auth-link.js";
import { ed25519KeyIdForRevocation } from "../../core/src/coordinator-ed25519-key-id-compat.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "../../core/src/coordinator-legacy-team-completion.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { legacyTeamCandidateId } from "../../core/src/recipient-policy-identifiers.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { verifyCloudflareCoordinatorRequest } from "../src/request-verifier.js";
import { changeFixture, config, NOW, input as origin } from "./account-change-fixture.js";
import { rows as nativeRows, resetCeremony } from "./owner-ceremony-test-fixtures.js";

const db = env.COORDINATOR_DB;
const secret = "synthetic-native-owner-review-secret";
type Definition = { type: string; name: string; sql: string };
let initialAuthSchema: Definition[] | undefined;
type Fixture = Awaited<ReturnType<typeof setup>>;
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type Reply = {
	state: string;
	evidence_digest: string;
	attestation_id: string;
	purpose: string;
	account_owner_target: { link_id: string; active_review: unknown };
	historical_owner_hints: string[];
	recovery_receipt: { disposition: string; evidence_digest: string; review_receipt_id: string };
};

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

async function rows(table: string) {
	return nativeRows(table);
}
async function snapshot(except: string[] = []) {
	const tables = (
		await db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all<{ name: string }>()
	).results;
	return Promise.all(
		tables
			.filter(({ name }) => !name.startsWith("_cf_") && !except.includes(name))
			.map(async ({ name }) => ({ table: name, rows: await rows(name) })),
	);
}
function laptop() {
	const { publicKey: pub } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(pub.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length, 0);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")} laptop.user@example.test 雪`;
	return {
		groupId: origin.signer.groupId,
		deviceId: randomUUID(),
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
	};
}
async function resetAuthSchema() {
	// Follow the native query-budget fixture: cases share storage, including immutable V3 receipts.
	const definitions = (
		await db
			.prepare(`SELECT type,name,sql FROM sqlite_master
	WHERE (tbl_name GLOB 'coordinator_auth_*' OR tbl_name='coordinator_account_change_attempts')
	AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name`)
			.all<Definition>()
	).results;
	if (!initialAuthSchema) initialAuthSchema = definitions;
	else {
		await resetCeremony();
		await db.batch([
			...definitions
				.filter(({ type }) => type === "table")
				.map(({ name }) => db.prepare(`DROP TABLE "${name}"`)),
			...initialAuthSchema.map(({ sql }) => db.prepare(sql)),
			db.prepare("DELETE FROM coordinator_legacy_team_completions"),
		]);
	}
}
async function setup() {
	await resetAuthSchema();
	let beforeWinning: (() => Promise<void>) | undefined;
	let winningFragment = "";
	const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement =>
		new Proxy(statement, {
			get(statement, property) {
				if (property === "bind")
					return (...values: unknown[]) => wrap(statement.bind(...values), query);
				if (property === "run" || property === "first")
					return async (...args: unknown[]) => {
						if (
							beforeWinning &&
							query.includes("controller_owner_connection AS MATERIALIZED (") &&
							query.includes(winningFragment)
						) {
							expect(query).toContain("$.accountOwnerTarget.linkId");
							const action = beforeWinning;
							beforeWinning = undefined;
							await action();
						}
						return Reflect.apply(statement[property], statement, args);
					};
				const value = Reflect.get(statement, property);
				return typeof value === "function" ? value.bind(statement) : value;
			},
		});
	const database = new Proxy(db, {
		get(database, property) {
			if (property === "prepare") return (query: string) => wrap(database.prepare(query), query);
			const value = Reflect.get(database, property);
			return typeof value === "function" ? value.bind(database) : value;
		},
	});
	const backend: AuthLinkBackend = {
		first: ({ sql, values }) =>
			db
				.prepare(sql)
				.bind(...values)
				.first(),
		run: async ({ sql, values }) =>
			(
				await db
					.prepare(sql)
					.bind(...values)
					.run()
			).meta.changes,
		batch: (statements) =>
			db.batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values))),
	};
	const store = new D1CoordinatorStore(database, { authClock: () => NOW });
	// Existing native helper produces a DEVICE_CLAIM birth and installs the real V3 connection schema.
	await changeFixture(store, backend);
	const birthLinkId = (await rows("coordinator_auth_account_links"))[0]?.link_id;
	const signer = laptop();
	await store.enrollDevice(signer.groupId, signer);
	const secondGroup = randomUUID();
	await store.createGroup(secondGroup);
	await store.enrollDevice(secondGroup, signer);
	const app = createCoordinatorApp({
		storeFactory: () => store,
		requestVerifier: verifyCloudflareCoordinatorRequest,
		runtime: { adminSecret: () => secret, now: () => new Date(NOW).toISOString() },
		authLink: {
			config: { ...config, redirectUri: "https://coordinator.example.test/auth/callback" },
			storeFactory: () => store,
		},
	});
	const input = {
		purpose: "existing_account_owner",
		group_id: signer.groupId,
		device_id: signer.deviceId,
		identity_id: origin.identityId,
		fingerprint: signer.fingerprint,
	};
	const f = {
		store,
		signer,
		secondGroup,
		app,
		input,
		birthLinkId,
		arm(reuse: boolean, action: () => Promise<void>) {
			winningFragment = reuse
				? "SELECT a.* FROM coordinator_auth_controller_attestations a"
				: "INSERT INTO coordinator_auth_controller_attestations";
			beforeWinning = action;
		},
	};
	await history(f, signer.groupId, "historical-owner-a");
	await history(f, secondGroup, "historical-owner-b");
	return f;
}
async function history(f: Pick<Fixture, "signer">, group: string, identity: string) {
	const record = normalize({
		version: 1,
		coordinator_id: config.coordinatorId,
		candidate_ref: legacyTeamCandidateId(config.coordinatorId, group),
		candidate_digest: "a".repeat(64),
		team_id: `team-${group}`,
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Pre-upgrade history",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: identity, role: "member" }],
		device_decisions: [
			{
				device_id: f.signer.deviceId,
				key_fingerprint: f.signer.fingerprint,
				enabled: true,
				identity_id: identity,
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: new Date(NOW).toISOString(),
	});
	// Direct historical bytes model contradictory assignments that today's producer refuses.
	await db
		.prepare(
			"INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?,?,1,?,?,?)",
		)
		.bind(group, record.candidate_ref, canonical(record), record.completed_at, record.completed_at)
		.run();
}
function request(f: Fixture, changes: Record<string, unknown> = {}, admin: string | null = secret) {
	return f.app.request("/v1/admin/auth-controller-reviews", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(admin === null ? {} : { "X-Codemem-Coordinator-Admin": admin }),
		},
		body: JSON.stringify({ ...f.input, ...changes }),
	});
}
async function preview(f: Fixture) {
	const response = await request(f);
	expect(response.status).toBe(200);
	const result = await response.json<Reply>();
	expect(result.state).toBe("ready");
	return result;
}
async function confirm(f: Fixture, initial: Reply) {
	return request(f, { confirm_evidence_digest: initial.evidence_digest });
}
async function reviewFor(f: Fixture, reuse: boolean) {
	const initial = await preview(f);
	if (reuse) expect((await confirm(f, initial)).status).toBe(201);
	return preview(f);
}
async function tombstone(signer: typeof origin.signer, kind: "device_id" | "ed25519_key") {
	await db
		.prepare(
			"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?)",
		)
		.bind(
			kind,
			kind === "device_id" ? signer.deviceId : await ed25519KeyIdForRevocation(signer.publicKey),
			randomUUID(),
			signer.groupId,
			signer.deviceId,
			signer.publicKey,
			signer.fingerprint,
			"retired",
		)
		.run();
}
async function reconnect() {
	// Same validated continuation as the core contract, executed against native D1 tables/triggers.
	const tables = [
		"coordinator_auth_account_links",
		"coordinator_auth_link_attempts",
		"coordinator_auth_link_audit_log",
	];
	const originals = await Promise.all(tables.map(async (table) => (await rows(table))[0]));
	const columns = CONNECTION_BIRTH_COLUMNS.join(",");
	await db
		.prepare(`INSERT INTO coordinator_auth_account_connection_unlinks
	(coordinator_id,attempt_id,target_link_id,identity_id,issuer,target_subject,group_id,device_id,public_key,fingerprint,enrollment_identity_id,auth_config_revision,request_hash,state,created_at_ms)
	SELECT coordinator_id,'end-attempt',link_id,identity_id,issuer,subject,?,?,?, ?,NULL,auth_config_revision,?,'committing',? FROM coordinator_auth_account_links`)
		.bind(
			origin.signer.groupId,
			origin.signer.deviceId,
			origin.signer.publicKey,
			origin.signer.fingerprint,
			"e".repeat(64),
			NOW + 1,
		)
		.run();
	await db
		.prepare(
			`INSERT INTO coordinator_auth_account_connection_history (${columns},original_rowid,ended_at_ms,end_attempt_id,signin_floor) SELECT ${columns},rowid,?,'end-attempt',signin_floor FROM coordinator_auth_account_links`,
		)
		.bind(NOW + 1)
		.run();
	await db.prepare("DELETE FROM coordinator_auth_account_links").run();
	await db
		.prepare(
			"UPDATE coordinator_auth_account_connection_unlinks SET state='completed',completed_at_ms=?",
		)
		.bind(NOW + 1)
		.run();
	for (const [index, table] of tables.entries()) {
		const original = originals[index];
		if (!original) throw new Error("missing native fixture genesis");
		const row = { ...original, link_id: "successor-link", attempt_id: "successor-attempt" };
		if (table === "coordinator_auth_link_attempts")
			Object.assign(row, {
				prior_link_id: originals[0]?.link_id,
				browser_start_hash: "1".repeat(64),
				browser_transaction_hash: "2".repeat(64),
				runtime_verifier_hash: "3".repeat(64),
				completion_secret_hash: "4".repeat(64),
			});
		const entries = Object.entries(row);
		await db
			.prepare(
				`INSERT INTO ${table} (${entries.map(([name]) => name).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
			)
			.bind(...entries.map(([, value]) => value))
			.run();
	}
	await db
		.prepare(
			"UPDATE coordinator_auth_account_connection_history SET successor_link_id='successor-link'",
		)
		.run();
}

it("native existing-owner review creates only controller A and restores its original immutable receipt", async () => {
	// Arrange: persisted provider birth is trusted fixture evidence; no live Google verification occurs.
	const f = await setup();
	const before = await snapshot();
	// Act
	const initial = await preview(f);
	const afterPreview = await snapshot();
	const response = await confirm(f, initial);
	const created = await response.json<Reply>();
	const status = await f.store.readAccountLinkStatus(f.signer, config, {
		identityId: origin.identityId,
	});
	const after = await snapshot(["coordinator_auth_controller_attestations"]);
	await history(f, randomUUID(), "historical-owner-c");
	const fresh = await preview(f);
	const beforeReuse = await snapshot();
	const create = vi.spyOn(f.store, "createAuthControllerAttestation");
	const restoredResponse = await confirm(f, fresh);
	const restored = await restoredResponse.json<Reply>();
	// Assert: history, local actor labels, old link and its original audit are not reassigned.
	expect(initial).toMatchObject({
		purpose: "existing_account_owner",
		account_owner_target: { link_id: f.birthLinkId, active_review: null },
		historical_owner_hints: ["historical-owner-a", "historical-owner-b"],
	});
	expect(afterPreview).toEqual(before);
	expect(response.status).toBe(201);
	expect(created.recovery_receipt).toMatchObject({
		disposition: "created",
		evidence_digest: initial.evidence_digest,
		review_receipt_id: expect.any(String),
	});
	expect(await rows("coordinator_auth_controller_attestations")).toMatchObject([
		{
			identity_id: origin.identityId,
			device_id: f.signer.deviceId,
			public_key: f.signer.publicKey,
			fingerprint: f.signer.fingerprint,
			enrollment_identity_id: null,
			evidence_digest: initial.evidence_digest,
			review_receipt_id: created.recovery_receipt.review_receipt_id,
			revision: 1,
		},
	]);
	expect(status).toMatchObject({
		state: "linked",
		identityId: origin.identityId,
		authority: "controller_attestation",
	});
	expect(after).toEqual(
		before.filter(({ table }) => table !== "coordinator_auth_controller_attestations"),
	);
	expect(fresh.evidence_digest).not.toBe(initial.evidence_digest);
	expect(restoredResponse.status).toBe(200);
	expect(restored.attestation_id).toBe(created.attestation_id);
	expect(restored.recovery_receipt).toEqual({ ...created.recovery_receipt, disposition: "reused" });
	expect(create).not.toHaveBeenCalled();
	expect(await snapshot()).toEqual(beforeReuse);
});

it("native admin/purpose/unknown/unlinked target checks refuse without controller writes", async () => {
	// Arrange
	const f = await setup();
	const before = await snapshot();
	const lookup = vi.spyOn(f.store, "readAccountOwnerTarget");
	const create = vi.spyOn(f.store, "createAuthControllerAttestation");
	// Act
	const noAdmin = await request(f, {}, null);
	const wrongAdmin = await request(f, {}, "wrong");
	const beforeAuthenticatedLookup = lookup.mock.calls.length;
	const wrongPurpose = await request(f, { purpose: "unsupported-purpose" });
	const unknown = await request(f, {
		identity_id: "unknown-owner",
		confirm_evidence_digest: "a".repeat(64),
	});
	const normal = await (await request(f, { purpose: undefined })).json<Reply>();
	const crossPurpose = await request(f, { confirm_evidence_digest: normal.evidence_digest });
	const afterDenied = await snapshot();
	await db.prepare("DELETE FROM coordinator_auth_account_links").run();
	const unlinkedBefore = await snapshot();
	const unlinked = await request(f, { confirm_evidence_digest: "a".repeat(64) });
	// Assert
	expect([noAdmin.status, wrongAdmin.status]).toEqual([401, 401]);
	expect(beforeAuthenticatedLookup).toBe(0);
	expect(wrongPurpose.status).toBe(400);
	expect([unknown.status, crossPurpose.status, unlinked.status]).toEqual([409, 409, 409]);
	expect(normal).not.toHaveProperty("purpose");
	expect(normal).not.toHaveProperty("account_owner_target");
	expect(create).not.toHaveBeenCalled();
	expect(afterDenied).toEqual(before);
	expect(await snapshot()).toEqual(unlinkedBefore);
});

it("native origin device/key retirement still permits creation and read-only reuse for another current laptop", async () => {
	// Arrange: retiring the personal birth key is not account revocation.
	const f = await setup();
	const initial = await preview(f);
	let injected: Snapshot | undefined;
	f.arm(false, async () => {
		await tombstone(origin.signer, "device_id");
		await tombstone(origin.signer, "ed25519_key");
		injected = await snapshot(["coordinator_auth_controller_attestations"]);
	});
	// Act
	const response = await confirm(f, initial);
	const fresh = await preview(f);
	const beforeReuse = await snapshot();
	const reused = await confirm(f, fresh);
	// Assert
	expect(injected).toBeDefined();
	expect(response.status).toBe(201);
	expect(reused.status).toBe(200);
	expect((await reused.json<Reply>()).recovery_receipt.disposition).toBe("reused");
	expect(await snapshot(["coordinator_auth_controller_attestations"])).toEqual(injected);
	expect(await snapshot()).toEqual(beforeReuse);
	expect(
		await f.store.readAccountOwnerTarget(
			{ targetIdentityId: origin.identityId, signer: f.signer },
			config,
		),
	).toMatchObject({ kind: "ready", linkId: f.birthLinkId });
});

for (const kind of ["device_id", "ed25519_key"] as const) {
	for (const reuse of [false, true]) {
		it(`native current laptop ${kind} revocation denies the winning ${reuse ? "reuse" : "INSERT"}`, async () => {
			// Arrange: the hook runs immediately before native statement execution, after preflight.
			const f = await setup();
			const initial = await reviewFor(f, reuse);
			let injected: Snapshot | undefined;
			f.arm(reuse, async () => {
				await tombstone(f.signer, kind);
				injected = await snapshot();
			});
			// Act
			const response = await confirm(f, initial);
			// Assert
			expect(injected).toBeDefined();
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "review_stale" });
			expect(await snapshot()).toEqual(injected);
		});
	}
}

it.each([false, true])(
	"native current ACCOUNT revocation denies winning authority creation/reuse, reuse=%s",
	async (reuse) => {
		// Arrange: this revokes the account connection itself, not its origin signing device.
		const f = await setup();
		const initial = await reviewFor(f, reuse);
		let injected: Snapshot | undefined;
		f.arm(reuse, async () => {
			await db
				.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms=?")
				.bind(NOW + 1)
				.run();
			injected = await snapshot();
		});
		// Act
		const response = await confirm(f, initial);
		// Assert
		expect(injected).toBeDefined();
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "review_stale" });
		expect(await snapshot()).toEqual(injected);
	},
);

it("native valid reconnect after preview cannot satisfy the old connection generation at INSERT", async () => {
	// Arrange
	const f = await setup();
	const initial = await preview(f);
	let injected: Snapshot | undefined;
	f.arm(false, async () => {
		await reconnect();
		injected = await snapshot();
	});
	// Act
	const response = await confirm(f, initial);
	const current = await f.store.readAccountOwnerTarget(
		{ targetIdentityId: origin.identityId, signer: f.signer },
		config,
	);
	// Assert: the successor is valid independently; only the stale review is refused.
	expect(injected).toBeDefined();
	expect(current).toMatchObject({ kind: "ready", linkId: "successor-link" });
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "review_stale" });
	expect(await snapshot()).toEqual(injected);
});

it("native retained ACCOUNT generation revocation denies read-only reuse on the valid successor", async () => {
	// Arrange
	const f = await setup();
	await reconnect();
	const initial = await reviewFor(f, true);
	let injected: Snapshot | undefined;
	expect(initial.account_owner_target.link_id).toBe("successor-link");
	f.arm(true, async () => {
		await db
			.prepare("UPDATE coordinator_auth_account_connection_history SET revoked_at_ms=?")
			.bind(NOW + 2)
			.run();
		injected = await snapshot();
	});
	// Act
	const response = await confirm(f, initial);
	// Assert
	expect(injected).toBeDefined();
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "review_stale" });
	expect(await snapshot()).toEqual(injected);
	expect(
		await f.store.readAccountOwnerTarget(
			{ targetIdentityId: origin.identityId, signer: f.signer },
			config,
		),
	).toEqual({ kind: "unavailable" });
});

it("native new-purpose SQL still rejects late canonical key-alias enrollment", async () => {
	// Arrange
	const f = await setup();
	const initial = await preview(f);
	let injected: Snapshot | undefined;
	f.arm(false, async () => {
		const aliasKey = `${f.signer.publicKey} known-alias`;
		await f.store.enrollDevice(f.secondGroup, {
			deviceId: randomUUID(),
			publicKey: aliasKey,
			fingerprint: fingerprintPublicKey(aliasKey),
		});
		injected = await snapshot();
	});
	// Act
	const response = await confirm(f, initial);
	// Assert
	expect(injected).toBeDefined();
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "review_stale" });
	expect(await snapshot()).toEqual(injected);
});

it("native revoked controller discovered at final reuse cannot be replaced or renewed", async () => {
	// Arrange
	const f = await setup();
	const initial = await reviewFor(f, true);
	let injected: Snapshot | undefined;
	const create = vi.spyOn(f.store, "createAuthControllerAttestation");
	f.arm(true, async () => {
		await db
			.prepare("UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked'")
			.run();
		injected = await snapshot();
	});
	// Act
	const response = await confirm(f, initial);
	// Assert
	expect(injected).toBeDefined();
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ error: "review_stale" });
	expect(create).not.toHaveBeenCalled();
	expect(await snapshot()).toEqual(injected);
});
