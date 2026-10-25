import { afterEach, expect, vi } from "vitest";
import {
	aliasKey,
	denied,
	eligible,
	input,
	otherKey,
	seedEnrollmentSql,
	seedKeyRevocationSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { browserConfig, materials } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	attempt,
	backendTest,
	completionHash,
	finalize,
	type LinkFixture,
} from "./coordinator-auth-link-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

function seed(f: LinkFixture) {
	f.db.exec(seedEnrollmentSql);
	f.db.exec("UPDATE enrolled_devices SET identity_id='identity-a'");
	const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
		version: 1,
		coordinator_id: f.cfg.coordinatorId,
		candidate_ref: legacyTeamCandidateId(f.cfg.coordinatorId, "group-a"),
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
		memberships: [{ identity_id: input.identityId, role: "member" }],
		device_decisions: [
			{
				device_id: "device-a",
				key_fingerprint: input.signer.fingerprint,
				enabled: true,
				identity_id: input.identityId,
				decision: "included",
			},
			{
				device_id: "unrelated-device",
				key_fingerprint: "b".repeat(64),
				enabled: true,
				identity_id: input.identityId,
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-10-01T00:00:00.000Z",
	});
	f.db
		.prepare(`INSERT INTO coordinator_legacy_team_completions
		(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?,?,?,?,?,?)`)
		.run(
			"group-a",
			manifest.candidate_ref,
			1,
			canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
			manifest.completed_at,
			manifest.completed_at,
		);
	return manifest;
}
const request = () =>
	attempt({
		authority: { kind: "device_claim", identityId: input.identityId },
		signer: input.signer,
		browserStartHash: "e".repeat(64),
	});
const proof = () => finalize({ signer: input.signer, fingerprint: input.signer.fingerprint });
function snapshot(f: LinkFixture, options: { stableOnly?: boolean } = {}) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables
		.filter(({ name }) => !options.stableOnly || !name.startsWith("coordinator_auth_"))
		.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
async function confirmed(f: LinkFixture) {
	expect(await f.store.createAuthLinkAttempt(request(), f.cfg)).toMatchObject({ kind: "created" });
	const start = {
		...materials(),
		purpose: "link" as const,
		attemptId: "attempt-a",
		browserStartHash: request().browserStartHash,
	};
	expect(await f.store.startAuthBrowserTransaction(start, browserConfig)).toMatchObject({
		kind: "started",
	});
	const bound = await f.store.resolveAuthLinkBrowserTransaction(
		{ attemptId: start.attemptId, binderHash: start.binderHash },
		browserConfig,
	);
	if (!bound) throw new Error("shared Identity browser not bound");
	expect(
		await f.store.consumeAuthBrowserTransaction(
			{ stateHash: start.stateHash, binderHash: start.binderHash },
			browserConfig,
		),
	).toMatchObject({ kind: "consumed" });
	const browser = { attemptId: start.attemptId, ...bound };
	expect(
		await f.store.recordAuthLinkOidcVerified(
			{ ...browser, account: { issuer: f.cfg.issuer, subject: "synthetic-shared-subject" } },
			f.cfg,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await f.store.confirmAuthLinkAttempt(
			{ ...browser, completionSecretHash: completionHash },
			f.cfg,
		),
	).toMatchObject({ kind: "applied" });
}
const invalidEvidence = [
	["no current assignment", "DELETE FROM coordinator_legacy_team_completions"],
	[
		"peer decision only",
		"UPDATE coordinator_legacy_team_completions SET manifest_json=json_remove(manifest_json,'$.device_decisions[0]')",
	],
	["disabled enrollment", "UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'"],
	[
		"disabled peer enrollment",
		"UPDATE enrolled_devices SET enabled=0 WHERE device_id='unrelated-device'",
	],
	[
		"matching peer enrolled in another group",
		`INSERT INTO groups (group_id,created_at) VALUES ('other-group','created');
		INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,created_at)
		VALUES ('other-group','unrelated-device','${otherKey}','${"b".repeat(64)}','identity-a','created')`,
	],
	[
		"another completion retains a different included device for the same Identity",
		(f: LinkFixture) => {
			const row = f.db
				.prepare(
					"SELECT manifest_json FROM coordinator_legacy_team_completions WHERE group_id='group-a'",
				)
				.get() as { manifest_json: string };
			const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
				...JSON.parse(row.manifest_json),
				candidate_ref: legacyTeamCandidateId(f.cfg.coordinatorId, "other-group"),
				device_decisions: [
					{
						device_id: "third-device",
						key_fingerprint: "c".repeat(64),
						enabled: true,
						identity_id: input.identityId,
						decision: "included",
					},
				],
			});
			// Retained history only: no enrollment that could independently cause denial.
			f.db.exec("INSERT INTO groups (group_id,created_at) VALUES ('other-group','created')");
			f.db
				.prepare(`INSERT INTO coordinator_legacy_team_completions
			(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?,?,?,?,?,?)`)
				.run(
					"other-group",
					manifest.candidate_ref,
					1,
					canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
					manifest.completed_at,
					manifest.completed_at,
				);
		},
	],
	["revoked key", seedKeyRevocationSql],
	[
		"excluded current device",
		"UPDATE coordinator_legacy_team_completions SET manifest_json=json_set(manifest_json,'$.device_decisions[0].decision','excluded','$.device_decisions[0].identity_id',NULL)",
	],
	[
		"disabled decision",
		"UPDATE coordinator_legacy_team_completions SET manifest_json=json_set(manifest_json,'$.device_decisions[0].enabled',json('false'))",
	],
	[
		"wrong fingerprint",
		`UPDATE coordinator_legacy_team_completions SET manifest_json=json_set(manifest_json,'$.device_decisions[0].key_fingerprint','${"f".repeat(64)}')`,
	],
	[
		"changed enrollment Identity",
		"UPDATE enrolled_devices SET identity_id='other' WHERE device_id='device-a'",
	],
	["malformed JSON", "UPDATE coordinator_legacy_team_completions SET manifest_json='{'"],
	[
		"noncanonical manifest bytes",
		"UPDATE coordinator_legacy_team_completions SET manifest_json=' ' || manifest_json",
	],
	[
		"duplicate JSON member with otherwise matching values",
		`UPDATE coordinator_legacy_team_completions SET manifest_json='{"version":1,' || substr(manifest_json,2)`,
	],
	[
		"incomplete manifest",
		"UPDATE coordinator_legacy_team_completions SET manifest_json=json_remove(manifest_json,'$.finish_digest')",
	],
	[
		"different row candidate",
		"UPDATE coordinator_legacy_team_completions SET candidate_ref='legacy-team-candidate:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
	],
	[
		"different manifest version",
		"UPDATE coordinator_legacy_team_completions SET manifest_json=json_set(manifest_json,'$.version',2)",
	],
	[
		"different row completion time",
		"UPDATE coordinator_legacy_team_completions SET completed_at='2026-10-02T00:00:00.000Z'",
	],
	[
		"same key under another device",
		`UPDATE enrolled_devices SET public_key='${aliasKey}' WHERE device_id='unrelated-device'`,
	],
	[
		"same key under another Identity",
		`UPDATE enrolled_devices SET public_key='${aliasKey}',identity_id='other' WHERE device_id='unrelated-device'`,
	],
] as const;

function seedHistoricalPeerLink(f: LinkFixture) {
	// Imported committed history can retain a link after its controller source is absent.
	f.db.exec("UPDATE enrolled_devices SET identity_id=NULL WHERE device_id='unrelated-device'");
	const overrides: Record<string, string | number | null> = {
		attempt_id: "historical-peer-attempt",
		link_id: "historical-peer-link",
		identity_id: "other",
		device_id: "unrelated-device",
		public_key: otherKey,
		fingerprint: "b".repeat(64),
		authority_kind: "controller_attestation",
		controller_attestation_id: "historical-peer-controller",
		controller_review_receipt_id: "historical-peer-receipt",
		controller_revision: 1,
		device_claim_id: null,
		runtime_verifier_hash: "1".repeat(64),
		browser_transaction_hash: "2".repeat(64),
		completion_secret_hash: "3".repeat(64),
		browser_start_hash: "4".repeat(64),
		subject: "historical-peer-subject",
		account_subject: "historical-peer-subject",
	};
	for (const table of ["link_attempts", "account_links", "link_audit_log"]) {
		const row = f.db.prepare(`SELECT * FROM coordinator_auth_${table}`).get() as Record<
			string,
			string | number | null
		>;
		const columns = Object.keys(row);
		const values = columns.map((key) =>
			Object.hasOwn(overrides, key) ? overrides[key] : row[key],
		);
		f.db
			.prepare(`INSERT INTO coordinator_auth_${table} (${columns.join(",")})
			VALUES (${columns.map(() => "?").join(",")})`)
			.run(...values);
	}
}

afterEach(() => vi.restoreAllMocks());
for (const backend of ["SQLite", "D1"] as const) {
	const test = backendTest(backend);
	test(`${backend} links an exactly assigned shared Identity without changing enrollment or grants`, async ({
		fixture: f,
	}) => {
		// Arrange: both different-key devices already belong to the same reviewed Identity.
		const manifest = seed(f);
		// A newer completion in another coordinator namespace must not shadow this assignment.
		const foreignManifest = {
			...manifest,
			coordinator_id: "coordinator-b",
			candidate_ref: legacyTeamCandidateId("coordinator-b", "group-a"),
			completed_at: "2026-10-02T00:00:00.000Z",
		};
		f.db
			.prepare(`INSERT INTO coordinator_legacy_team_completions
		(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?,?,?,?,?,?)`)
			.run(
				"group-a",
				foreignManifest.candidate_ref,
				1,
				canonicalCoordinatorLegacyTeamCompletionManifestJson(foreignManifest),
				foreignManifest.completed_at,
				foreignManifest.completed_at,
			);
		const before = snapshot(f);
		const stable = snapshot(f, { stableOnly: true });
		// Act / Assert: readiness and status are read-only, then use the browser-start proof path.
		expect(await f.store.readAuthDeviceClaimReadiness(input, f.cfg)).toEqual(eligible);
		expect(
			await f.store.readAccountLinkStatus(input.signer, f.cfg, { identityId: input.identityId }),
		).toMatchObject({ state: "unlinked", authority: "device_claim", identityId: input.identityId });
		expect(snapshot(f)).toEqual(before);
		await confirmed(f);
		expect(await f.store.finalizeAuthLinkAttempt(proof(), f.cfg)).toMatchObject({
			kind: "applied",
			status: { state: "finalized" },
		});
		const claims = f.db.prepare("SELECT * FROM coordinator_auth_device_claims").all();
		expect(claims).toEqual([
			expect.objectContaining({
				identity_id: input.identityId,
				device_id: input.signer.deviceId,
				fingerprint: input.signer.fingerprint,
			}),
		]);
		const source = {
			authority_kind: "device_claim",
			controller_attestation_id: null,
			device_claim_id: (claims[0] as { claim_id: string }).claim_id,
		};
		expect(f.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([
			expect.objectContaining({
				...source,
				identity_id: input.identityId,
				subject: "synthetic-shared-subject",
			}),
		]);
		expect(f.db.prepare("SELECT * FROM coordinator_auth_link_audit_log").all()).toEqual([
			expect.objectContaining({ ...source, action: "link_created" }),
		]);
		expect(snapshot(f, { stableOnly: true })).toEqual(stable);
	});
	test.for(invalidEvidence)(
		`${backend} rejects %s without writes or account disclosure`,
		async ([, sql], { fixture: f }) => {
			// Arrange
			seed(f);
			if (typeof sql === "string") f.db.exec(sql);
			else sql(f);
			const before = snapshot(f);
			// Act
			const readiness = await f.store.readAuthDeviceClaimReadiness(input, f.cfg);
			const status = await f.store.readAccountLinkStatus(input.signer, f.cfg, {
				identityId: input.identityId,
			});
			const created = await f.store.createAuthLinkAttempt(request(), f.cfg);
			// Assert
			expect(readiness).toEqual(denied);
			expect(status).toMatchObject({ account: null, authority: null, identityId: null });
			expect(created).toMatchObject({ kind: "rejected" });
			expect(snapshot(f)).toEqual(before);
		},
	);
	test.for([
		["create", "bound"],
		["finalize", "bound"],
		["create", "legacy NULL"],
		["finalize", "legacy NULL"],
	] as const)(
		`${backend} rechecks the positive assignment inside the winning %s SQL with %s enrollments`,
		async ([stage, enrollment], { fixture: f }) => {
			// Arrange: inject only after eligibility capture, when the winning write executes.
			seed(f);
			if (enrollment === "legacy NULL") {
				f.db.exec("UPDATE enrolled_devices SET identity_id=NULL");
			}
			expect(await f.store.readAuthDeviceClaimReadiness(input, f.cfg)).toEqual(eligible);
			if (stage === "finalize") await confirmed(f);
			const before = snapshot(f).filter(([name]) => name !== "coordinator_legacy_team_completions");
			const prepare = f.db.prepare.bind(f.db);
			let injected = false;
			let executionHook: { mockRestore(): void } | undefined;
			const hook = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
				const statement = prepare(sql);
				// Match the mutation after any consistency CTE, never a preflight SELECT.
				const winning =
					stage === "create"
						? sql.includes("INSERT INTO coordinator_auth_link_attempts")
						: sql.includes(
								"UPDATE coordinator_auth_link_attempts SET state = 'finalized', link_id = ?, finalized_at_ms = ?",
							);
				if (winning && !executionHook) {
					const run = statement.run.bind(statement);
					executionHook = vi.spyOn(statement, "run").mockImplementationOnce((...values) => {
						injected = true;
						f.db.exec("DELETE FROM coordinator_legacy_team_completions");
						// The consistency CTE precedes the write and prepends its own bindings.
						return run(...values);
					});
				}
				return statement;
			});
			// Act
			const result =
				stage === "create"
					? await f.store.createAuthLinkAttempt(request(), f.cfg)
					: await f.store.finalizeAuthLinkAttempt(proof(), f.cfg);
			executionHook?.mockRestore();
			hook.mockRestore();
			// Assert: no attempt consumption, proof, link, audit, enrollment or grant changes.
			expect(injected).toBe(true);
			expect(result).toMatchObject({ kind: "rejected" });
			expect(
				snapshot(f).filter(([name]) => name !== "coordinator_legacy_team_completions"),
			).toEqual(before);
		},
	);
	test(`${backend} assigned peer reads historical linked/revoked state but an unassigned peer cannot guess it`, async ({
		fixture: f,
	}) => {
		// Arrange
		seed(f);
		await confirmed(f);
		expect(await f.store.finalizeAuthLinkAttempt(proof(), f.cfg)).toMatchObject({
			kind: "applied",
		});
		const peer = {
			groupId: "group-a",
			deviceId: "unrelated-device",
			publicKey: otherKey,
			fingerprint: "b".repeat(64),
		};
		f.db.exec(`INSERT INTO coordinator_auth_account_profiles
		(coordinator_id,link_id,display_name,email,email_verified,source_session_id,source_signed_in_at_ms)
		SELECT coordinator_id,link_id,'Synthetic Person','synthetic@example.test',1,'synthetic-session',${f.now}
		FROM coordinator_auth_account_links`);
		f.db.exec("UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'");
		const before = snapshot(f);
		// Act / Assert: the origin enrollment is not current Google ownership authority.
		expect(
			await f.store.readAccountLinkStatus(peer, f.cfg, { identityId: input.identityId }),
		).toMatchObject({
			state: "linked",
			identityId: input.identityId,
			authority: "device_claim",
			account: { displayName: "Synthetic Person", email: "synthetic@example.test" },
		});
		expect(snapshot(f)).toEqual(before);
		for (const contradiction of [
			`INSERT INTO coordinator_device_ownership_bindings
			(device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
			VALUES ('unrelated-device','${"b".repeat(64)}','other','coordinator-a','binding-peer','reviewed_legacy_migration','source-peer','bound')`,
			`INSERT INTO groups (group_id,created_at) VALUES ('other-group','created');
			INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,created_at)
			VALUES ('other-group','unrelated-device','${otherKey}','${"b".repeat(64)}','other','created')`,
			() => seedHistoricalPeerLink(f),
			...["NULL", "'2026-03-01T00:00:00.000Z'"].map(
				(revokedAt) => `
			UPDATE enrolled_devices SET identity_id=NULL WHERE device_id='unrelated-device';
			INSERT INTO coordinator_invites
			(invite_id,group_id,token,policy,expires_at,created_at,assigned_identity_id,consumed_at,bound_device_id,bound_public_key,bound_fingerprint,revoked_at)
			VALUES ('invite-peer','group-a','token-peer','open','2027-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','other','2026-02-01T00:00:00.000Z','unrelated-device','${otherKey}','${"b".repeat(64)}',${revokedAt})`,
			),
			...[
				["other", "group-a", "'revoked'"],
				["other", "other-group", "NULL"],
				[input.identityId, "group-a", "'revoked'"],
			].map(
				([identityId, groupId, revokedAt]) => `
			UPDATE enrolled_devices SET identity_id=NULL WHERE device_id='unrelated-device';
			INSERT INTO groups (group_id,created_at) VALUES ('other-group','created');
			INSERT INTO coordinator_auth_controller_attestations
			(attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,created_at,revoked_at)
			VALUES ('att-peer','coordinator-a','${identityId}','${groupId}','unrelated-device','${otherKey}','${"b".repeat(64)}','receipt-peer','${"a".repeat(64)}','created',${revokedAt})`,
			),
		]) {
			// Arrange: current peer contradictions cannot inherit the origin's historical proof.
			f.db.exec("SAVEPOINT peer_contradiction");
			if (typeof contradiction === "string") f.db.exec(contradiction);
			else contradiction();
			const contradictory = snapshot(f);
			// Act
			const status = await f.store.readAccountLinkStatus(peer, f.cfg, {
				identityId: input.identityId,
			});
			// Assert
			expect(status).toMatchObject({ account: null, identityId: null, authority: null });
			expect(snapshot(f)).toEqual(contradictory);
			f.db.exec("ROLLBACK TO peer_contradiction; RELEASE peer_contradiction");
		}
		f.db.exec("UPDATE enrolled_devices SET enabled=0 WHERE device_id='unrelated-device'");
		expect(
			await f.store.readAccountLinkStatus(peer, f.cfg, { identityId: input.identityId }),
		).toMatchObject({ account: null, identityId: null, authority: null });
		f.db.exec("UPDATE enrolled_devices SET enabled=1 WHERE device_id='unrelated-device'");
		f.db.exec(
			`${seedKeyRevocationSql} UPDATE coordinator_device_revocations SET subject_kind='device_id',subject_value='unrelated-device'`,
		);
		expect(
			await f.store.readAccountLinkStatus(peer, f.cfg, { identityId: input.identityId }),
		).toMatchObject({ account: null, identityId: null, authority: null });
		f.db.exec("DELETE FROM coordinator_device_revocations");
		f.db.exec("UPDATE coordinator_auth_account_links SET revoked_at_ms=1");
		expect(
			await f.store.readAccountLinkStatus(peer, f.cfg, { identityId: input.identityId }),
		).toMatchObject({ state: "revoked", account: null });
		f.db.exec(
			"UPDATE coordinator_legacy_team_completions SET manifest_json=json_remove(manifest_json,'$.device_decisions[1]')",
		);
		const deniedBefore = snapshot(f);
		expect(
			await f.store.readAccountLinkStatus(peer, f.cfg, { identityId: input.identityId }),
		).toMatchObject({ account: null, identityId: null, authority: null });
		expect(snapshot(f)).toEqual(deniedBefore);
	});
}
