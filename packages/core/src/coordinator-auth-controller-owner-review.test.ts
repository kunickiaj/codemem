import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
	deviceClaimEvidenceSql,
	otherKey,
	seedClaimSql,
	seedEnrollmentSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { applyAccountConnectionSchema } from "./coordinator-account-connection-schema.js";
import { CONNECTION_BIRTH_COLUMNS } from "./coordinator-account-connection-storage.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import {
	AUTH_CONTROLLER_INSERT_SQL,
	AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL,
	authControllerReviewSql,
} from "./coordinator-auth-controller.js";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { review, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

const secret = "synthetic-owner-review-secret";
const signer = {
	groupId: "group-a",
	deviceId: "current-laptop",
	publicKey: otherKey,
	fingerprint: "c".repeat(64),
};
const input = {
	purpose: "existing_account_owner",
	group_id: signer.groupId,
	device_id: signer.deviceId,
	identity_id: "identity-a",
	fingerprint: signer.fingerprint,
} as const;

function snapshot(f: LinkFixture, except: string[] = []) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables
		.filter(({ name }) => !except.includes(name))
		.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}

function isOwnerReviewWinner(query: string, { reuse }: { reuse: boolean }): boolean {
	if (!query.includes("controller_owner_connection AS MATERIALIZED (")) return false;
	if (!reuse) return /\bINSERT INTO coordinator_auth_controller_attestations\s*\(/.test(query);
	return (
		/\bSELECT 1 AS eligible FROM enrolled_devices e\b/.test(query) ||
		/\bSELECT a\.\* FROM coordinator_auth_controller_attestations a\s+JOIN enrolled_devices e\b/.test(
			query,
		)
	);
}

async function otherGroupController(
	f: LinkFixture,
	{
		subject,
		identityId,
	}: {
		subject: "same-device" | "key-alias" | "unrelated-key";
		identityId: "identity-a" | "identity-b";
	},
) {
	let device = { ...signer };
	if (subject === "key-alias") {
		device = {
			...device,
			deviceId: "verified-alias",
			publicKey: `${signer.publicKey} synthetic-alias`,
			fingerprint: "e".repeat(64),
		};
	} else if (subject === "unrelated-key") {
		const wire = Buffer.from(signer.publicKey.split(" ")[1] ?? "", "base64");
		wire[wire.length - 1] = (wire[wire.length - 1] ?? 0) ^ 1;
		device = {
			...device,
			deviceId: "unrelated-controller-device",
			publicKey: `ssh-ed25519 ${wire.toString("base64")}`,
			fingerprint: "7".repeat(64),
		};
		await f.store.enrollDevice("group-b", device);
	}
	const result = await f.store.createAuthControllerAttestation(
		review({
			...device,
			groupId: "group-b",
			identityId,
			attestationId: "other-group-controller",
			reviewReceiptId: "other-group-receipt",
		}),
	);
	expect(result.kind).toBe("created");
	if (result.kind === "rejected") throw new Error("synthetic other-group controller rejected");
	return result.attestation;
}

async function retainedAliasController(
	f: LinkFixture,
	{
		variant,
		identityId,
	}: { variant: "comment" | "alternate-wire"; identityId: "identity-a" | "identity-b" },
) {
	let publicKey = `${signer.publicKey} retained-only-alias`;
	if (variant === "alternate-wire") {
		// Existing verifier compatibility accepts a different SSH inner type with the same raw key.
		const original = Buffer.from(signer.publicKey.split(" ")[1] ?? "", "base64");
		const inner = Buffer.from("ssh-rsa");
		const wire = Buffer.alloc(4 + inner.length + 4 + 32);
		wire.writeUInt32BE(inner.length, 0);
		inner.copy(wire, 4);
		wire.writeUInt32BE(32, 4 + inner.length);
		original.subarray(original.length - 32).copy(wire, 8 + inner.length);
		publicKey = `ssh-ed25519 ${wire.toString("base64")} retained-only-alias`;
	}
	expect(await ed25519KeyIdForRevocation(publicKey)).toBe(
		await ed25519KeyIdForRevocation(signer.publicKey),
	);
	const device = { deviceId: "retained-only-device", publicKey, fingerprint: "6".repeat(64) };
	await f.store.enrollDevice("group-b", device);
	const created = await f.store.createAuthControllerAttestation(
		review({
			...device,
			groupId: "group-b",
			identityId,
			attestationId: "retained-only-controller",
			reviewReceiptId: "retained-only-receipt",
		}),
	);
	expect(created.kind).toBe("created");
	if (created.kind === "rejected") throw new Error("synthetic retained controller rejected");
	// Its public key is now present only in the trusted immutable controller receipt.
	f.db
		.prepare("DELETE FROM enrolled_devices WHERE group_id=? AND device_id=?")
		.run("group-b", device.deviceId);
	return created.attestation;
}

function history(f: LinkFixture, group: string, identity: string | null, alias = false) {
	const manifest = normalize({
		version: 1,
		coordinator_id: f.cfg.coordinatorId,
		candidate_ref: legacyTeamCandidateId(f.cfg.coordinatorId, group),
		candidate_digest: "a".repeat(64),
		team_id: `team-${group}`,
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic history",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [
			{ identity_id: "other-person", role: "member" },
			...(identity ? [{ identity_id: identity, role: "member" }] : []),
		],
		device_decisions: [
			{
				device_id: alias ? "verified-alias" : signer.deviceId,
				key_fingerprint: alias ? "e".repeat(64) : signer.fingerprint,
				enabled: true,
				identity_id: identity,
				decision: identity ? "included" : "excluded",
			},
			{
				device_id: "other-person-device",
				key_fingerprint: "9".repeat(64),
				enabled: true,
				identity_id: "other-person",
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-10-01T00:00:00.000Z",
	});
	f.db
		.prepare(`INSERT INTO coordinator_legacy_team_completions
		(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
		VALUES (?,?,1,?,?,?)`)
		.run(
			group,
			manifest.candidate_ref,
			canonical(manifest),
			manifest.completed_at,
			manifest.completed_at,
		);
}

async function seed(f: LinkFixture) {
	// Persisted DEVICE_CLAIM genesis is trusted fixture proof, not a Google/OIDC ceremony.
	f.db.exec(seedEnrollmentSql);
	f.db.exec("DELETE FROM enrolled_devices WHERE device_id='unrelated-device'");
	f.db.exec(seedClaimSql);
	f.db.exec(`INSERT INTO coordinator_auth_account_links
		(coordinator_id,link_id,issuer,subject,identity_id,attempt_id,auth_config_revision,
		created_at_ms,authority_kind,device_claim_id)
		SELECT coordinator_id,claim_id,issuer,'private-claim-subject',identity_id,attempt_id,
		auth_config_revision,created_at_ms,'device_claim',claim_id FROM coordinator_auth_device_claims;
		INSERT INTO coordinator_auth_link_audit_log
		(coordinator_id,link_id,attempt_id,identity_id,group_id,device_id,fingerprint,
		auth_config_revision,created_at_ms,action,authority_kind,device_claim_id)
		SELECT coordinator_id,link_id,attempt_id,identity_id,group_id,device_id,fingerprint,
		auth_config_revision,finalized_at_ms,'link_created','device_claim',link_id
		FROM coordinator_auth_link_attempts;`);
	const d1 = sqliteD1(f.db);
	await applyAccountConnectionSchema({
		first: ({ sql, values }) =>
			d1
				.prepare(sql)
				.bind(...values)
				.first(),
		run: async ({ sql, values }) => f.db.prepare(sql).run(...values).changes,
		batch: async (statements) =>
			f.db.transaction(() =>
				statements.map(({ sql, values }) => f.db.prepare(sql).run(...values).changes),
			)(),
	});
	await f.store.enrollDevice(signer.groupId, signer);
	await f.store.createGroup("group-b");
	await f.store.enrollDevice("group-b", signer);
	await f.store.enrollDevice("group-b", {
		deviceId: "verified-alias",
		publicKey: `${signer.publicKey} synthetic-alias`,
		fingerprint: "e".repeat(64),
	});
	history(f, "group-a", "identity-a");
	history(f, "group-b", "identity-b");
	history(f, "alias-history", "alias-identity", true);
	f.db
		.prepare(`INSERT INTO coordinator_invites
		(invite_id,group_id,token,policy,expires_at,created_at,consumed_at,
		bound_device_id,bound_public_key,bound_fingerprint,invite_kind,
		recipient_actor_id,target_identity_id,reviewed_preview_digest)
		VALUES ('owner-invite',?,'synthetic-token','auto','2030','created','consumed',?,?,?,
		'add_device','identity-a','identity-a',?)`)
		.run(signer.groupId, signer.deviceId, signer.publicKey, signer.fingerprint, "d".repeat(64));
	vi.spyOn(f.store, "close").mockResolvedValue(undefined);
}

function appFor(f: LinkFixture) {
	return createCoordinatorApp({
		storeFactory: () => f.store,
		requestVerifier: async () => false,
		runtime: { adminSecret: () => secret, now: () => new Date(NOW).toISOString() },
		authLink: {
			config: { ...f.cfg, redirectUri: "https://coordinator.example.test/auth/callback" },
			storeFactory: () => f.store,
		},
	});
}

function request(
	app: ReturnType<typeof appFor>,
	body: unknown = input,
	admin: string | null = secret,
) {
	return app.request("/v1/admin/auth-controller-reviews", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(admin === null ? {} : { "X-Codemem-Coordinator-Admin": admin }),
		},
		body: JSON.stringify(body),
	});
}

function reconnect(f: LinkFixture) {
	// Same validated continuation fixture as the target-reader contract: preserve genesis and retire its row.
	const tables = [
		"coordinator_auth_account_links",
		"coordinator_auth_link_attempts",
		"coordinator_auth_link_audit_log",
	];
	const originals = tables.map(
		(table) => f.db.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>,
	);
	const columns = CONNECTION_BIRTH_COLUMNS.join(",");
	f.db.exec(`INSERT INTO coordinator_auth_account_connection_unlinks
		(coordinator_id,attempt_id,target_link_id,identity_id,issuer,target_subject,group_id,
		device_id,public_key,fingerprint,enrollment_identity_id,auth_config_revision,
		request_hash,state,created_at_ms)
		SELECT coordinator_id,'end-attempt',link_id,identity_id,issuer,subject,'group-a',
		'device-a','${CANONICAL_PUBLIC_KEY}','${"a".repeat(64)}',NULL,auth_config_revision,
		'${"e".repeat(64)}','committing',${NOW + 1} FROM coordinator_auth_account_links;
		INSERT INTO coordinator_auth_account_connection_history
		(${columns},original_rowid,ended_at_ms,end_attempt_id,signin_floor)
		SELECT ${columns},rowid,${NOW + 1},'end-attempt',signin_floor FROM coordinator_auth_account_links;
		DELETE FROM coordinator_auth_account_links;
		UPDATE coordinator_auth_account_connection_unlinks SET state='completed',completed_at_ms=${NOW + 1};`);
	for (const [index, table] of tables.entries()) {
		const original = originals[index];
		if (!original) throw new Error("missing synthetic genesis");
		const row = { ...original, link_id: "successor-link", attempt_id: "successor-attempt" };
		if (table === "coordinator_auth_link_attempts")
			Object.assign(row, {
				prior_link_id: "claim-a",
				browser_start_hash: "1".repeat(64),
				browser_transaction_hash: "2".repeat(64),
				runtime_verifier_hash: "3".repeat(64),
				completion_secret_hash: "4".repeat(64),
			});
		const entries = Object.entries(row);
		f.db
			.prepare(
				`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
			)
			.run(...entries.map(([, value]) => value));
	}
	f.db.exec(
		"UPDATE coordinator_auth_account_connection_history SET successor_link_id='successor-link'",
	);
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
	for (const variant of ["comment", "alternate-wire"] as const) {
		test(`${kind} rejects retained B ${variant} key alias after its sole enrollment is removed`, async ({
			fixture: f,
		}) => {
			// Arrange: neither the device ID nor textual key matches a surviving enrollment.
			await seed(f);
			await retainedAliasController(f, { variant, identityId: "identity-b" });
			const before = snapshot(f);
			const create = vi.spyOn(f.store, "createAuthControllerAttestation");
			const app = appFor(f);
			// Act
			const preview = await (await request(app)).json();
			const response = await request(app, {
				...input,
				confirm_evidence_digest: preview.evidence_digest ?? "a".repeat(64),
			});
			// Assert: removing enrollment cannot downgrade retained B authority to a weak history hint.
			expect.soft(preview.state).toBe("needs_review");
			expect.soft(preview.reasons).toContain("account_owner_conflict");
			expect.soft(preview.evidence_digest).toBeUndefined();
			expect.soft(response.status).toBe(409);
			expect.soft(create).not.toHaveBeenCalled();
			expect.soft(snapshot(f)).toEqual(before);
		});

		for (const reuse of [false, true]) {
			test(`${kind} rejects late retained B ${variant} alias without enrollment at winning ${reuse ? "reuse" : "creation"}`, async ({
				fixture: f,
			}) => {
				// Arrange: build a genuine receipt through the store, then introduce it only at final SQL execution.
				await seed(f);
				const b = await retainedAliasController(f, { variant, identityId: "identity-b" });
				f.db
					.prepare("DELETE FROM coordinator_auth_controller_attestations WHERE attestation_id=?")
					.run(b.attestation_id);
				const app = appFor(f);
				if (reuse) {
					const first = await (await request(app)).json();
					expect(
						(await request(app, { ...input, confirm_evidence_digest: first.evidence_digest }))
							.status,
					).toBe(201);
				}
				const preview = await (await request(app)).json();
				expect(preview.state).toBe("ready");
				const aBefore = f.db
					.prepare(
						"SELECT * FROM coordinator_auth_controller_attestations WHERE group_id='group-a'",
					)
					.all();
				const prepare = f.db.prepare.bind(f.db);
				let injected: ReturnType<typeof snapshot> | undefined;
				let winnerCalls = 0;
				vi.spyOn(f.db, "prepare").mockImplementation((query: string) => {
					const winner = isOwnerReviewWinner(query, { reuse });
					if (winner) winnerCalls++;
					if (!injected && winner) {
						injected = [];
						const entries = Object.entries(b);
						prepare(
							`INSERT INTO coordinator_auth_controller_attestations (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
						).run(...entries.map(([, value]) => value));
						injected = snapshot(f);
					}
					return prepare(query);
				});
				// Act
				const response = await request(app, {
					...input,
					confirm_evidence_digest: preview.evidence_digest,
				});
				// Assert: the final family-discovery check must include trusted retained controller keys.
				expect(winnerCalls).toBe(1);
				expect(injected).toBeDefined();
				expect.soft(response.status).toBe(409);
				expect.soft(await response.json()).toEqual({ error: "review_stale" });
				expect
					.soft(
						f.db
							.prepare(
								"SELECT * FROM coordinator_auth_controller_attestations WHERE group_id='group-a'",
							)
							.all(),
					)
					.toEqual(aBefore);
				expect.soft(snapshot(f)).toEqual(injected);
			});
		}

		test(`${kind} permits retained same-owner A ${variant} alias without enrollment`, async ({
			fixture: f,
		}) => {
			// Arrange: retained authority for the same owner is not a transfer or conflict.
			await seed(f);
			const retained = await retainedAliasController(f, { variant, identityId: "identity-a" });
			const before = snapshot(f, ["coordinator_auth_controller_attestations"]);
			const app = appFor(f);
			// Act
			const preview = await (await request(app)).json();
			const response = await request(app, {
				...input,
				confirm_evidence_digest: preview.evidence_digest,
			});
			// Assert
			expect(preview.state).toBe("ready");
			expect(preview.reasons).toEqual([]);
			expect(response.status).toBe(201);
			expect(snapshot(f, ["coordinator_auth_controller_attestations"])).toEqual(before);
			expect(
				f.db
					.prepare("SELECT * FROM coordinator_auth_controller_attestations WHERE attestation_id=?")
					.get(retained.attestation_id),
			).toEqual(retained);
		});
	}

	test(`${kind} permits retained unrelated-key B proof after its sole enrollment is removed`, async ({
		fixture: f,
	}) => {
		// Arrange: a different raw key and device do not belong to the laptop family.
		await seed(f);
		const retained = await otherGroupController(f, {
			subject: "unrelated-key",
			identityId: "identity-b",
		});
		f.db
			.prepare("DELETE FROM enrolled_devices WHERE group_id=? AND device_id=?")
			.run(retained.group_id, retained.device_id);
		const before = snapshot(f, ["coordinator_auth_controller_attestations"]);
		const app = appFor(f);
		// Act
		const preview = await (await request(app)).json();
		const response = await request(app, {
			...input,
			confirm_evidence_digest: preview.evidence_digest,
		});
		// Assert
		expect(preview.state).toBe("ready");
		expect(response.status).toBe(201);
		expect(snapshot(f, ["coordinator_auth_controller_attestations"])).toEqual(before);
		expect(
			f.db
				.prepare("SELECT * FROM coordinator_auth_controller_attestations WHERE attestation_id=?")
				.get(retained.attestation_id),
		).toEqual(retained);
	});
	for (const subject of ["same-device", "key-alias"] as const) {
		test(`${kind} owner recovery rejects live other-group B controller for ${subject} without tightening ordinary preview`, async ({
			fixture: f,
		}) => {
			// Arrange: strong B authority is created through the ordinary store API, not an enrollment label.
			await seed(f);
			await otherGroupController(f, { subject, identityId: "identity-b" });
			const before = snapshot(f);
			const create = vi.spyOn(f.store, "createAuthControllerAttestation");
			const app = appFor(f);
			const { purpose: _purpose, ...ordinary } = input;
			// Act
			const ordinaryPreview = await (await request(app, ordinary)).json();
			const preview = await (await request(app)).json();
			const confirmed = await request(app, {
				...input,
				confirm_evidence_digest: preview.evidence_digest ?? "a".repeat(64),
			});
			// Assert: historical A/B hints alone were allowed; live contradictory ownership is not.
			expect.soft(ordinaryPreview.state).toBe("ready");
			expect.soft(ordinaryPreview).not.toHaveProperty("purpose");
			expect.soft(preview.state).toBe("needs_review");
			expect.soft(preview.reasons).toContain("account_owner_conflict");
			expect.soft(preview.evidence_digest).toBeUndefined();
			expect.soft(confirmed.status).toBe(409);
			expect.soft(create).not.toHaveBeenCalled();
			expect.soft(snapshot(f)).toEqual(before);
		});

		for (const reuse of [false, true]) {
			test(`${kind} owner recovery rechecks late other-group B ${subject} at winning ${reuse ? "reuse" : "creation"}`, async ({
				fixture: f,
			}) => {
				// Arrange: retain a legitimate store-created B row, then publish it only at the final SQL boundary.
				await seed(f);
				const b = await otherGroupController(f, { subject, identityId: "identity-b" });
				f.db
					.prepare("DELETE FROM coordinator_auth_controller_attestations WHERE attestation_id=?")
					.run(b.attestation_id);
				const app = appFor(f);
				if (reuse) {
					const initial = await (await request(app)).json();
					expect(
						(await request(app, { ...input, confirm_evidence_digest: initial.evidence_digest }))
							.status,
					).toBe(201);
				}
				const preview = await (await request(app)).json();
				expect(preview.state).toBe("ready");
				const aBefore = f.db
					.prepare(
						"SELECT * FROM coordinator_auth_controller_attestations WHERE group_id='group-a'",
					)
					.all();
				const prepare = f.db.prepare.bind(f.db);
				let injected: ReturnType<typeof snapshot> | undefined;
				let winnerCalls = 0;
				vi.spyOn(f.db, "prepare").mockImplementation((query: string) => {
					const winner = isOwnerReviewWinner(query, { reuse });
					if (winner) winnerCalls++;
					if (!injected && winner) {
						injected = [];
						const entries = Object.entries(b);
						prepare(
							`INSERT INTO coordinator_auth_controller_attestations (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
						).run(...entries.map(([, value]) => value));
						injected = snapshot(f);
					}
					return prepare(query);
				});
				// Act
				const response = await request(app, {
					...input,
					confirm_evidence_digest: preview.evidence_digest,
				});
				// Assert: no new A row or reused approval may silently contradict the committed B proof.
				expect(winnerCalls).toBe(1);
				expect(injected).toBeDefined();
				expect.soft(response.status).toBe(409);
				expect.soft(await response.json()).toEqual({ error: "review_stale" });
				expect
					.soft(
						f.db
							.prepare(
								"SELECT * FROM coordinator_auth_controller_attestations WHERE group_id='group-a'",
							)
							.all(),
					)
					.toEqual(aBefore);
				expect.soft(snapshot(f)).toEqual(injected);
			});
		}
	}

	for (const other of [
		{ subject: "same-device", identityId: "identity-a" },
		{ subject: "key-alias", identityId: "identity-a" },
		{ subject: "unrelated-key", identityId: "identity-b" },
	] as const) {
		test(`${kind} owner recovery permits other-group ${other.identityId} proof for ${other.subject}`, async ({
			fixture: f,
		}) => {
			// Arrange: agreeing authority and unrelated key families are not ownership contradictions.
			await seed(f);
			const b = await otherGroupController(f, other);
			const unaffected = snapshot(f, ["coordinator_auth_controller_attestations"]);
			const app = appFor(f);
			// Act
			const preview = await (await request(app)).json();
			const response = await request(app, {
				...input,
				confirm_evidence_digest: preview.evidence_digest,
			});
			// Assert: only the A approval is new; the existing other-group proof and access remain untouched.
			expect(preview.state).toBe("ready");
			expect(preview.reasons).toEqual([]);
			expect(response.status).toBe(201);
			expect(snapshot(f, ["coordinator_auth_controller_attestations"])).toEqual(unaffected);
			expect(
				f.db
					.prepare("SELECT * FROM coordinator_auth_controller_attestations WHERE attestation_id=?")
					.get(b.attestation_id),
			).toEqual(b);
			expect(
				f.db
					.prepare(
						"SELECT identity_id FROM coordinator_auth_controller_attestations WHERE group_id='group-a'",
					)
					.all(),
			).toEqual([{ identity_id: "identity-a" }]);
		});
	}
	test(`${kind} previews only existing A and subject-related historical hints without writes`, async ({
		fixture: f,
	}) => {
		// Arrange: laptop has null identity in two groups, disagreeing A/B history and a verified alias.
		await seed(f);
		const before = snapshot(f);
		// Act
		const response = await request(appFor(f));
		const text = await response.text();
		const result = JSON.parse(text);
		// Assert: full manifests retain other people, but advisory hints do not imply their ownership.
		expect(response.status).toBe(200);
		expect(result).toMatchObject({
			state: "ready",
			purpose: input.purpose,
			reasons: [],
			account_owner_target: {
				identity_id: "identity-a",
				link_id: "claim-a",
				auth_config_revision: f.cfg.revision,
				created_at_ms: NOW,
				active_review: null,
			},
			historical_owner_hints: ["alias-identity", "identity-a", "identity-b"],
		});
		expect(text).not.toMatch(
			/private-claim-subject|public_key|email|token|synthetic-owner-review-secret/,
		);
		expect(text).not.toContain(signer.publicKey);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(snapshot(f)).toEqual(before);
	});

	test(`${kind} confirms only controller A and retained review receipt, then restores original receipt read-only`, async ({
		fixture: f,
	}) => {
		// Arrange: no source or local memory actor C is reassigned by this ceremony.
		await seed(f);
		const app = appFor(f);
		const unaffected = snapshot(f, ["coordinator_auth_controller_attestations"]);
		const originalLinkAudit = f.db.prepare("SELECT * FROM coordinator_auth_link_audit_log").all();
		const preview = await (await request(app)).json();
		// Act
		const created = await request(app, {
			...input,
			confirm_evidence_digest: preview.evidence_digest,
		});
		const applied = await created.json();
		const status = await f.store.readAccountLinkStatus(signer, f.cfg, { identityId: "identity-a" });
		const row = f.db.prepare("SELECT * FROM coordinator_auth_controller_attestations").get();
		const afterCreation = snapshot(f, ["coordinator_auth_controller_attestations"]);
		// Related subject history changes the human preview, not the original immutable remote review.
		history(f, "new-related-history", "identity-a");
		const fresh = await (await request(app)).json();
		const beforeReuse = snapshot(f);
		const create = vi.spyOn(f.store, "createAuthControllerAttestation");
		const reused = await request(app, { ...input, confirm_evidence_digest: fresh.evidence_digest });
		const restored = await reused.json();
		// Assert
		expect(created.status).toBe(201);
		expect(applied).toMatchObject({
			identity_id: "identity-a",
			purpose: input.purpose,
			recovery_receipt: {
				disposition: "created",
				evidence_digest: preview.evidence_digest,
				review_receipt_id: expect.any(String),
			},
		});
		expect(row).toEqual({
			attestation_id: applied.attestation_id,
			coordinator_id: f.cfg.coordinatorId,
			identity_id: input.identity_id,
			group_id: signer.groupId,
			device_id: signer.deviceId,
			public_key: signer.publicKey,
			fingerprint: signer.fingerprint,
			review_receipt_id: applied.recovery_receipt.review_receipt_id,
			evidence_digest: applied.recovery_receipt.evidence_digest,
			enrollment_identity_id: null,
			revision: 1,
			created_at: applied.created_at,
			revoked_at: null,
		});
		expect(afterCreation).toEqual(unaffected);
		expect(status).toMatchObject({
			state: "linked",
			identityId: "identity-a",
			authority: "controller_attestation",
		});
		expect(
			snapshot(f, [
				"coordinator_auth_controller_attestations",
				"coordinator_legacy_team_completions",
			]),
		).toEqual(unaffected.filter(([table]) => table !== "coordinator_legacy_team_completions"));
		expect(fresh.evidence_digest).not.toBe(preview.evidence_digest);
		expect(reused.status).toBe(200);
		expect(restored.recovery_receipt).toEqual({
			...applied.recovery_receipt,
			disposition: "reused",
		});
		expect(create).not.toHaveBeenCalled();
		expect(f.db.prepare("SELECT * FROM coordinator_auth_controller_attestations").get()).toEqual(
			row,
		);
		expect(snapshot(f)).toEqual(beforeReuse);
		expect(
			f.db.prepare("SELECT COUNT(*) AS n FROM coordinator_auth_controller_attestations").get(),
		).toEqual({ n: 1 });
		expect(originalLinkAudit).toHaveLength(1);
		expect(f.db.prepare("SELECT * FROM coordinator_auth_link_audit_log").all()).toEqual(
			originalLinkAudit,
		);
	});

	test(`${kind} keeps absent-purpose preview and SQL unchanged and rejects its digest for recovery`, async ({
		fixture: f,
	}) => {
		// Arrange
		await seed(f);
		const app = appFor(f);
		const { purpose: _purpose, ...ordinary } = input;
		const before = snapshot(f);
		// Act
		const normal = await (await request(app, ordinary)).json();
		const owner = await (await request(app)).json();
		const denied = await request(app, {
			...input,
			confirm_evidence_digest: normal.evidence_digest,
		});
		// Assert
		expect(normal.state).toBe("ready");
		expect(normal).not.toHaveProperty("purpose");
		expect(normal).not.toHaveProperty("account_owner_target");
		expect(normal).not.toHaveProperty("historical_owner_hints");
		expect(owner.evidence_digest).not.toBe(normal.evidence_digest);
		for (const sql of [AUTH_CONTROLLER_INSERT_SQL, AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL]) {
			expect(authControllerReviewSql(sql, review())).toBe(sql);
			expect(sql).not.toMatch(/coordinator_auth_account_connection|coordinator_auth_account_links/);
		}
		expect(denied.status).toBe(409);
		expect(await denied.json()).toEqual({ error: "review_stale" });
		expect(snapshot(f)).toEqual(before);
	});

	for (const admin of [null, "wrong-secret"]) {
		test(`${kind} requires admin authentication (${admin}) before target lookup`, async ({
			fixture: f,
		}) => {
			// Arrange
			await seed(f);
			const lookup = vi.spyOn(f.store, "readAccountOwnerTarget");
			const before = snapshot(f);
			// Act
			const response = await request(appFor(f), input, admin);
			// Assert
			expect(response.status).toBe(401);
			expect(lookup).not.toHaveBeenCalled();
			expect(snapshot(f)).toEqual(before);
		});
	}

	for (const [label, change] of [
		["unlinked", "DELETE FROM coordinator_auth_account_links"],
		["revoked link", `UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW + 1}`],
		[
			"wrong issuer",
			"UPDATE coordinator_auth_account_links SET issuer='https://other.example.test'",
		],
		[
			"malformed genesis",
			"UPDATE coordinator_auth_link_attempts SET account_subject='wrong-subject'",
		],
		["disabled laptop", "UPDATE enrolled_devices SET enabled=0 WHERE device_id='current-laptop'"],
		[
			"malformed key",
			"UPDATE enrolled_devices SET public_key='bad-key' WHERE device_id='current-laptop'",
		],
		[
			"foreign enrollment",
			"UPDATE enrolled_devices SET identity_id='identity-c' WHERE device_id='current-laptop'",
		],
	] as const) {
		test(`${kind} ${label} stops before any controller authority write`, async ({ fixture: f }) => {
			// Arrange
			await seed(f);
			f.db.exec(change);
			const before = snapshot(f);
			const create = vi.spyOn(f.store, "createAuthControllerAttestation");
			const app = appFor(f);
			// Act
			const preview = await (await request(app)).json();
			const commit = await request(app, { ...input, confirm_evidence_digest: "a".repeat(64) });
			// Assert
			expect(preview.state).toBe("needs_review");
			expect(preview.evidence_digest).toBeUndefined();
			expect(commit.status).toBe(409);
			expect(create).not.toHaveBeenCalled();
			expect(snapshot(f)).toEqual(before);
		});
	}

	for (const identity of ["identity-c", "identity-typo"]) {
		test(`${kind} cannot use owner mode to create arbitrary ${identity}`, async ({
			fixture: f,
		}) => {
			// Arrange
			await seed(f);
			const before = snapshot(f);
			const create = vi.spyOn(f.store, "createAuthControllerAttestation");
			// Act
			const response = await request(appFor(f), {
				...input,
				identity_id: identity,
				confirm_evidence_digest: "a".repeat(64),
			});
			// Assert
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				reasons: ["invite_identity_mismatch", "account_owner_target_unavailable"],
			});
			expect(create).not.toHaveBeenCalled();
			expect(snapshot(f)).toEqual(before);
		});
	}

	test(`${kind} unsupported connection schema refuses before target lookup or authority write`, async ({
		fixture: f,
	}) => {
		// Arrange: a missing V3 proof trigger must reject the HTTP entry point itself.
		await seed(f);
		f.db.exec("DROP TRIGGER account_change_birth");
		const before = snapshot(f);
		const target = vi.spyOn(f.store, "readAccountOwnerTarget");
		const create = vi.spyOn(f.store, "createAuthControllerAttestation");
		const app = appFor(f);
		// Act
		const preview = await request(app);
		const confirmed = await request(app, { ...input, confirm_evidence_digest: "a".repeat(64) });
		// Assert
		expect([preview.status, confirmed.status]).toEqual([503, 503]);
		expect(await preview.json()).toMatchObject({
			error: "coordinator_auth_schema_upgrade_required",
		});
		expect(target).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(snapshot(f)).toEqual(before);
	});

	for (const mode of ["foreign claim", "wrong controller", "revoked controller"] as const) {
		test(`${kind} ${mode} cannot be repaired by selecting existing A`, async ({ fixture: f }) => {
			// Arrange
			await seed(f);
			if (mode === "foreign claim") {
				let sql = deviceClaimEvidenceSql({ identityId: "identity-c", deviceId: signer.deviceId })
					.replaceAll("completed-attempt", "foreign-attempt")
					.replaceAll("claim-a", "foreign-claim")
					.replaceAll(CANONICAL_PUBLIC_KEY, signer.publicKey)
					.replaceAll(
						EXPECTED_KEY_ID,
						(await ed25519KeyIdForRevocation(signer.publicKey)) as string,
					);
				const digest = (value: string) => createHash("sha256").update(value).digest("hex");
				const browser = digest("device-claim-fixture:completed-attempt");
				for (const hash of [
					browser,
					...["runtime", "completion", "start", "state", "binder", "claim"].map((suffix) =>
						digest(`${browser}:${suffix}`),
					),
				]) {
					sql = sql.replaceAll(hash, digest(`foreign:${hash}`));
				}
				f.db.exec(sql);
			} else {
				expect(
					await f.store.createAuthControllerAttestation(
						review({
							...signer,
							identityId: mode === "wrong controller" ? "identity-c" : "identity-a",
						}),
					),
				).toMatchObject({ kind: "created" });
				if (mode === "revoked controller")
					f.db.exec("UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked'");
			}
			const before = snapshot(f);
			const create = vi.spyOn(f.store, "createAuthControllerAttestation");
			// Act
			const response = await request(appFor(f), {
				...input,
				confirm_evidence_digest: "a".repeat(64),
			});
			// Assert
			expect(response.status).toBe(409);
			expect(create).not.toHaveBeenCalled();
			expect(snapshot(f)).toEqual(before);
		});
	}

	for (const mutation of [
		"DELETE FROM coordinator_auth_account_links",
		"UPDATE coordinator_auth_account_links SET link_id='reconnected-link'",
		`UPDATE coordinator_auth_account_links SET auth_config_revision='${"f".repeat(64)}'`,
		"UPDATE coordinator_auth_account_links SET created_at_ms=created_at_ms+1",
		"UPDATE coordinator_auth_account_links SET issuer='https://changed.example.test'",
		`UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW + 1}`,
		"UPDATE coordinator_legacy_team_completions SET created_at='changed' WHERE group_id='group-a'",
		"UPDATE coordinator_invites SET reviewed_preview_digest='changed' WHERE invite_id='owner-invite'",
		"DELETE FROM coordinator_invites WHERE invite_id='owner-invite'",
		`INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,enabled,created_at)
		VALUES ('group-b','late-alias','${signer.publicKey} late-alias','${"8".repeat(64)}',1,'created')`,
		`INSERT INTO coordinator_device_revocations
		(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,
		evidence_public_key,evidence_fingerprint,created_at)
		VALUES ('device_id','${signer.deviceId}','late-revocation','group-a','${signer.deviceId}',
		'${signer.publicKey}','${signer.fingerprint}','created')`,
		`INSERT INTO coordinator_device_revocations
		(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,
		evidence_public_key,evidence_fingerprint,created_at)
		VALUES ('ed25519_key','CURRENT_KEY_ID','late-current-key-revocation','group-a','${signer.deviceId}',
		'${signer.publicKey}','${signer.fingerprint}','created')`,
	] as const) {
		for (const reuse of [false, true]) {
			test(`${kind} rechecks ${mutation} at ${reuse ? "read-only reuse" : "creation"}`, async ({
				fixture: f,
			}) => {
				// Arrange: the real SQLite/D1-adapter execution reaches its final INSERT/active SELECT.
				await seed(f);
				const currentKeyId = await ed25519KeyIdForRevocation(signer.publicKey);
				if (!currentKeyId) throw new Error("invalid synthetic requester key");
				const app = appFor(f);
				if (reuse) {
					const first = await (await request(app)).json();
					expect(
						(await request(app, { ...input, confirm_evidence_digest: first.evidence_digest }))
							.status,
					).toBe(201);
				}
				const preview = await (await request(app)).json();
				let injected: ReturnType<typeof snapshot> | undefined;
				let winnerCalls = 0;
				const prepare = f.db.prepare.bind(f.db);
				vi.spyOn(f.db, "prepare").mockImplementation((query: string) => {
					const winner = isOwnerReviewWinner(query, { reuse });
					if (winner) winnerCalls++;
					if (!injected && winner) {
						expect(query).toContain("$.accountOwnerTarget.linkId");
						// Set the sentinel before snapshot reads reenter prepare.
						injected = [];
						f.db.exec(mutation.replaceAll("CURRENT_KEY_ID", currentKeyId));
						injected = snapshot(f);
					}
					return prepare(query);
				});
				// Act
				const denied = await request(app, {
					...input,
					confirm_evidence_digest: preview.evidence_digest,
				});
				// Assert
				expect(denied.status).toBe(409);
				expect(await denied.json()).toEqual({ error: "review_stale" });
				expect(injected).toBeDefined();
				expect(winnerCalls).toBe(1);
				expect(snapshot(f)).toEqual(injected);
			});
		}
	}

	for (const subject of ["device_id", "ed25519_key"] as const) {
		for (const reuse of [false, true]) {
			test(`${kind} retains existing owner link after origin ${subject} revocation at final ${reuse ? "reuse" : "creation"} statement`, async ({
				fixture: f,
			}) => {
				// Arrange: retiring the original personal device does not revoke account A.
				await seed(f);
				const app = appFor(f);
				if (reuse) {
					const first = await (await request(app)).json();
					expect(
						(await request(app, { ...input, confirm_evidence_digest: first.evidence_digest }))
							.status,
					).toBe(201);
				}
				const preview = await (await request(app)).json();
				const rowBefore = f.db
					.prepare("SELECT * FROM coordinator_auth_controller_attestations")
					.all();
				const prepare = f.db.prepare.bind(f.db);
				let injected: ReturnType<typeof snapshot> | undefined;
				let winnerCalls = 0;
				vi.spyOn(f.db, "prepare").mockImplementation((query: string) => {
					const winner = isOwnerReviewWinner(query, { reuse });
					if (winner) winnerCalls++;
					if (!injected && winner) {
						injected = [];
						f.db
							.prepare(`INSERT INTO coordinator_device_revocations
							(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,
							evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,'retired-origin',
							'group-a','device-a',?,?,'created')`)
							.run(
								subject,
								subject === "device_id" ? "device-a" : EXPECTED_KEY_ID,
								CANONICAL_PUBLIC_KEY,
								"a".repeat(64),
							);
						injected = snapshot(f, reuse ? [] : ["coordinator_auth_controller_attestations"]);
					}
					return prepare(query);
				});
				// Act
				const response = await request(app, {
					...input,
					confirm_evidence_digest: preview.evidence_digest,
				});
				const result = await response.json();
				// Assert: account, link audit, grants and history are byte-identical; no laptop tombstone exists.
				expect(injected).toBeDefined();
				expect(winnerCalls).toBe(1);
				expect(response.status).toBe(reuse ? 200 : 201);
				expect(result.recovery_receipt.disposition).toBe(reuse ? "reused" : "created");
				expect(snapshot(f, reuse ? [] : ["coordinator_auth_controller_attestations"])).toEqual(
					injected,
				);
				expect(
					f.db
						.prepare(
							"SELECT revocation_id,subject_kind,subject_value FROM coordinator_device_revocations",
						)
						.all(),
				).toEqual([
					{
						revocation_id: "retired-origin",
						subject_kind: subject,
						subject_value: subject === "device_id" ? "device-a" : EXPECTED_KEY_ID,
					},
				]);
				if (reuse)
					expect(
						f.db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all(),
					).toEqual(rowBefore);
			});
		}
	}

	for (const mutation of [
		"UPDATE coordinator_auth_controller_attestations SET revoked_at='late-revoked'",
		"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='different-receipt'",
		"DELETE FROM coordinator_auth_controller_attestations",
	]) {
		test(`${kind} requires the same active receipt during awaited reuse: ${mutation}`, async ({
			fixture: f,
		}) => {
			// Arrange: the route saw an active review, but the atomic read must still prove it.
			await seed(f);
			const app = appFor(f);
			const first = await (await request(app)).json();
			expect(
				(await request(app, { ...input, confirm_evidence_digest: first.evidence_digest })).status,
			).toBe(201);
			const fresh = await (await request(app)).json();
			const create = vi.spyOn(f.store, "createAuthControllerAttestation");
			const original = f.store.readAuthControllerAttestationForSnapshot.bind(f.store);
			let afterMutation: ReturnType<typeof snapshot> | undefined;
			vi.spyOn(f.store, "readAuthControllerAttestationForSnapshot").mockImplementationOnce(
				async (value) => {
					await Promise.resolve();
					f.db.exec(mutation);
					afterMutation = snapshot(f);
					return original(value);
				},
			);
			// Act
			const denied = await request(app, {
				...input,
				confirm_evidence_digest: fresh.evidence_digest,
			});
			// Assert: never replace or revive a missing/revoked review, nor return a different receipt.
			expect(denied.status).toBe(409);
			expect(await denied.json()).toEqual({ error: "review_stale" });
			expect(create).not.toHaveBeenCalled();
			expect(afterMutation).toBeDefined();
			expect(snapshot(f)).toEqual(afterMutation);
		});
	}

	for (const change of ["valid reconnect", "retained connection revocation"] as const) {
		for (const reuse of [false, true]) {
			test(`${kind} pins connection generation against ${change} at final ${reuse ? "reuse" : "creation"}`, async ({
				fixture: f,
			}) => {
				// Arrange: a valid successor is distinct from corruption of a current link ID.
				await seed(f);
				if (change === "retained connection revocation") reconnect(f);
				const app = appFor(f);
				if (reuse) {
					const initial = await (await request(app)).json();
					expect(
						(await request(app, { ...input, confirm_evidence_digest: initial.evidence_digest }))
							.status,
					).toBe(201);
				}
				const preview = await (await request(app)).json();
				expect(preview.state).toBe("ready");
				expect(preview.account_owner_target.link_id).toBe(
					change === "valid reconnect" ? "claim-a" : "successor-link",
				);
				const prepare = f.db.prepare.bind(f.db);
				let injected: ReturnType<typeof snapshot> | undefined;
				let winnerCalls = 0;
				vi.spyOn(f.db, "prepare").mockImplementation((query: string) => {
					const winner = isOwnerReviewWinner(query, { reuse });
					if (winner) winnerCalls++;
					if (!injected && winner) {
						injected = [];
						if (change === "valid reconnect") reconnect(f);
						else
							f.db.exec(
								`UPDATE coordinator_auth_account_connection_history SET revoked_at_ms=${NOW + 2}`,
							);
						injected = snapshot(f);
					}
					return prepare(query);
				});
				// Act
				const response = await request(app, {
					...input,
					confirm_evidence_digest: preview.evidence_digest,
				});
				const currentTarget = await f.store.readAccountOwnerTarget(
					{ targetIdentityId: input.identity_id, signer },
					f.cfg,
				);
				// Assert: successor proof is valid, but never satisfies confirmation of the old generation.
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({ error: "review_stale" });
				expect(injected).toBeDefined();
				expect(winnerCalls).toBe(1);
				expect(snapshot(f)).toEqual(injected);
				if (change === "valid reconnect")
					expect(currentTarget).toMatchObject({ kind: "ready", linkId: "successor-link" });
				else expect(currentTarget).toEqual({ kind: "unavailable" });
			});
		}
	}

	test(`${kind} exact trusted snapshot retry returns one unchanged controller and immutable receipt`, async ({
		fixture: f,
	}) => {
		// Arrange: capture precisely the server-derived review used by the HTTP creation.
		await seed(f);
		const app = appFor(f);
		const preview = await (await request(app)).json();
		const create = vi.spyOn(f.store, "createAuthControllerAttestation");
		const response = await request(app, {
			...input,
			confirm_evidence_digest: preview.evidence_digest,
		});
		const submitted = create.mock.calls[0]?.[0];
		if (!submitted) throw new Error("missing server-derived fixture review");
		const before = snapshot(f);
		// Act
		const retry = await f.store.createAuthControllerAttestation(submitted);
		// Assert
		expect(response.status).toBe(201);
		expect(retry).toMatchObject({
			kind: "existing",
			attestation: {
				review_receipt_id: submitted.reviewReceiptId,
				evidence_digest: submitted.evidenceDigest,
			},
		});
		expect(
			f.db.prepare("SELECT COUNT(*) AS n FROM coordinator_auth_controller_attestations").get(),
		).toEqual({ n: 1 });
		expect(snapshot(f)).toEqual(before);
	});

	test(`${kind} global laptop revocation denies while Team exclusion alone permits account recovery`, async ({
		fixture: f,
	}) => {
		// Arrange
		await seed(f);
		history(f, "excluded-team", null);
		const app = appFor(f);
		const keyId = await ed25519KeyIdForRevocation(signer.publicKey);
		// Act
		const allowed = await (await request(app)).json();
		f.db
			.prepare(`INSERT INTO coordinator_device_revocations
			(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,
			evidence_public_key,evidence_fingerprint,created_at) VALUES ('ed25519_key',?,'revoked',?,?,?,?, 'created')`)
			.run(keyId, signer.groupId, signer.deviceId, signer.publicKey, signer.fingerprint);
		const before = snapshot(f);
		const denied = await request(app, {
			...input,
			confirm_evidence_digest: allowed.evidence_digest,
		});
		// Assert
		expect(allowed.state).toBe("ready");
		expect(denied.status).toBe(409);
		expect(snapshot(f)).toEqual(before);
	});
}
