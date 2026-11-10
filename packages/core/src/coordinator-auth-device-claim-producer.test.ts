import { expect, vi } from "vitest";
import {
	aliasKey,
	input,
	otherKey,
	seedBindingSql,
	seedClaimSql,
	seedEnrollmentSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import {
	authorizeFor,
	desktopConfirmed,
	desktopCreate,
	desktopFinalize,
	headlessConfirmed,
	headlessCreate,
	headlessFinalize,
} from "./coordinator-auth-link-headless-test-fixtures.js";
import { backendTest, finalize, type LinkFixture } from "./coordinator-auth-link-test-fixtures.js";

function snapshot(f: LinkFixture) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
const rows = (f: LinkFixture, table: string) => f.db.prepare(`SELECT * FROM ${table}`).all();

for (const backend of ["SQLite", "D1"] as const) {
	const test = backendTest(backend);
	test(`${backend} retained pre-binding claim retry preserves its historical account receipt`, async ({
		fixture: f,
	}) => {
		// Arrange: historical claims remain legacy seeds until explicit completion.
		f.db.exec(seedEnrollmentSql + seedClaimSql);
		f.db.exec(`INSERT INTO coordinator_auth_account_links
 (coordinator_id,link_id,issuer,subject,identity_id,attempt_id,device_claim_id,auth_config_revision,created_at_ms,authority_kind)
 SELECT coordinator_id,link_id,issuer,account_subject,identity_id,attempt_id,link_id,auth_config_revision,finalized_at_ms,authority_kind
 FROM coordinator_auth_link_attempts;
 INSERT INTO coordinator_auth_link_audit_log
 (coordinator_id,link_id,action,attempt_id,identity_id,group_id,device_id,fingerprint,device_claim_id,auth_config_revision,created_at_ms,authority_kind)
 SELECT coordinator_id,link_id,'link_created',attempt_id,identity_id,group_id,device_id,fingerprint,link_id,auth_config_revision,finalized_at_ms,authority_kind
 FROM coordinator_auth_link_attempts;`);
		const old = f.db
			.prepare("SELECT * FROM coordinator_auth_link_attempts WHERE authority_kind='device_claim'")
			.get() as Record<string, string>;
		const before = snapshot(f);
		// Act
		const result = await f.store.finalizeAuthLinkAttempt(
			finalize({
				attemptId: old.attempt_id,
				runtimeVerifierHash: old.runtime_verifier_hash,
				completionSecretHash: old.completion_secret_hash,
				signer: input.signer,
				fingerprint: input.signer.fingerprint,
			}),
			f.cfg,
		);
		// Assert: retry reads the old receipt without turning a read into migration.
		expect(result.kind).toBe("existing");
		expect(
			await f.store.finalizeAuthLinkAttempt(
				finalize({
					attemptId: old.attempt_id,
					runtimeVerifierHash: "f".repeat(64),
					completionSecretHash: old.completion_secret_hash,
					signer: input.signer,
					fingerprint: input.signer.fingerprint,
				}),
				f.cfg,
			),
		).toMatchObject({ kind: "rejected" });
		expect(snapshot(f)).toEqual(before);
		expect(rows(f, "coordinator_device_ownership_bindings")).toEqual([]);
	});
	for (const mode of ["desktop", "headless"] as const) {
		const confirm = mode === "desktop" ? desktopConfirmed : headlessConfirmed;
		const complete = (f: LinkFixture) =>
			mode === "desktop"
				? f.store.finalizeAuthLinkAttempt(desktopFinalize(f, "device_claim"), f.cfg)
				: f.store.finalizeHeadlessAuthLinkAttempt(headlessFinalize(f, "device_claim"), f.cfg);
		test(`${backend} ${mode} existing same-Identity ownership permits readiness and start`, async ({
			fixture: f,
		}) => {
			// Arrange: an independently owned healthy device may link its account.
			await authorizeFor(f, "device_claim");
			f.db.exec(seedBindingSql);
			const binding = rows(f, "coordinator_device_ownership_bindings");
			// Act
			const readiness = await f.store.readAuthDeviceClaimReadiness(input, f.cfg);
			const started =
				mode === "desktop"
					? await f.store.createAuthLinkAttempt(desktopCreate("device_claim"), f.cfg)
					: await f.store.createHeadlessAuthLinkAttempt(
							await headlessCreate("device_claim"),
							f.cfg,
						);
			// Assert: its immutable ownership source remains intact.
			expect(readiness).toMatchObject({ kind: "eligible" });
			expect(started.kind).toBe("created");
			expect(rows(f, "coordinator_device_ownership_bindings")).toEqual(binding);
		});
		test.for([
			`INSERT INTO groups(group_id,created_at) VALUES('group-b','created'); INSERT INTO enrolled_devices(group_id,device_id,public_key,fingerprint,created_at) VALUES('group-b','device-a','${otherKey}','${"b".repeat(64)}','created');`,
			`INSERT INTO enrolled_devices(group_id,device_id,public_key,fingerprint,created_at) VALUES('group-a','alias-device','${aliasKey}','${"a".repeat(64)}','created');`,
		])(
			`${backend} ${mode} inconsistent binding structure denies readiness and start before OIDC: %s`,
			async (conflict, { fixture: f }) => {
				// Arrange: both shapes passed the historical account-only first-claim rule.
				await authorizeFor(f, "device_claim");
				f.db.exec(conflict);
				const before = snapshot(f);
				// Act
				const readiness = await f.store.readAuthDeviceClaimReadiness(input, f.cfg);
				const started =
					mode === "desktop"
						? await f.store.createAuthLinkAttempt(desktopCreate("device_claim"), f.cfg)
						: await f.store.createHeadlessAuthLinkAttempt(
								await headlessCreate("device_claim"),
								f.cfg,
							);
				// Assert: no browser/OIDC transaction or pending account attempt is created.
				expect(readiness).toEqual({ kind: "unavailable" });
				expect(started).toMatchObject({ kind: "rejected", error: "attempt_unavailable" });
				expect(snapshot(f)).toEqual(before);
			},
		);
		test(`${backend} ${mode} enrollment drift at the winning claim returns a structured rejection`, async ({
			fixture: f,
		}) => {
			// Arrange: initial readiness was valid and consent completed before drift.
			await confirm(f, "device_claim");
			const before = snapshot(f);
			const prepare = f.db.prepare.bind(f.db);
			let injected = false;
			let executionHook: { mockRestore(): void } | undefined;
			const hook = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
				const statement = prepare(sql);
				if (
					!executionHook &&
					/UPDATE coordinator_auth_link_attempts SET state = 'finalized', link_id =/.test(sql)
				) {
					const run = statement.run.bind(statement);
					executionHook = vi.spyOn(statement, "run").mockImplementationOnce((...values) => {
						// Inject only at execution, after schema checks and preflight captures.
						injected = true;
						f.db.exec(
							"CREATE TRIGGER enrollment_drift AFTER INSERT ON coordinator_auth_device_claims BEGIN INSERT INTO groups(group_id,created_at) VALUES('group-b','created'); INSERT INTO enrolled_devices(group_id,device_id,public_key,fingerprint,created_at) SELECT 'group-b',device_id,public_key,fingerprint,'created' FROM enrolled_devices WHERE device_id='device-a'; END",
						);
						return run(...values);
					});
				}
				return statement;
			});
			// Act
			const result = await complete(f).finally(() => {
				executionHook?.mockRestore();
				hook.mockRestore();
			});
			// Assert: a live eligibility conflict is not an unknown storage outcome.
			expect(injected).toBe(true);
			expect(result).toMatchObject({ kind: "rejected", error: "attempt_unavailable" });
			expect(snapshot(f)).toEqual(before);
		});
		test(`${backend} ${mode} healthy same-Identity ownership is preserved by first linking`, async ({
			fixture: f,
		}) => {
			// Arrange: consent has the original same-owner binding eligibility.
			await confirm(f, "device_claim");
			f.db.exec(seedBindingSql);
			const binding = rows(f, "coordinator_device_ownership_bindings");
			const ownershipAudit = rows(f, "coordinator_device_rebind_audit_log");
			// Act
			const result = await complete(f);
			const committed = snapshot(f);
			const retry = await complete(f);
			// Assert: completion neither replaces provenance nor mints a duplicate binding.
			expect(result.kind).toBe("applied");
			expect(retry.kind).toBe("existing");
			expect(rows(f, "coordinator_device_ownership_bindings")).toEqual(binding);
			expect(rows(f, "coordinator_device_rebind_audit_log")).toEqual(ownershipAudit);
			expect(rows(f, "enrolled_devices")).toEqual([
				expect.objectContaining({ identity_id: "identity-a" }),
			]);
			expect(snapshot(f)).toEqual(committed);
		});
		test(`${backend} ${mode} first claim completes ownership once`, async ({ fixture: f }) => {
			// Arrange: the browser and verified provider claims are local fixtures.
			await confirm(f, "device_claim");
			// Act
			const result = await complete(f);
			const committed = snapshot(f);
			const retry = await complete(f);
			// Assert: account success includes durable sharing ownership.
			expect(result.kind).toBe("applied");
			expect(rows(f, "coordinator_device_ownership_bindings")).toEqual([
				expect.objectContaining({
					device_id: "device-a",
					identity_id: "identity-a",
					provenance: "owner_enrollment",
					source_ref: expect.stringMatching(/^device_claim:/),
				}),
			]);
			expect(rows(f, "enrolled_devices")).toEqual([
				expect.objectContaining({ identity_id: "identity-a" }),
			]);
			expect(rows(f, "coordinator_device_rebind_audit_log")).toEqual([
				expect.objectContaining({
					previous_identity_id: "identity-a",
					target_identity_id: "identity-a",
					enrollment_count: 1,
				}),
			]);
			expect(retry.kind).toBe("existing");
			expect(snapshot(f)).toEqual(committed);
		});
		test.for([
			"CREATE TRIGGER binding_fault BEFORE INSERT ON coordinator_device_ownership_bindings BEGIN SELECT RAISE(IGNORE); END",
			"CREATE TRIGGER binding_fault BEFORE INSERT ON coordinator_device_rebind_audit_log BEGIN SELECT RAISE(ABORT,'audit_fault'); END",
			"CREATE TRIGGER binding_fault BEFORE UPDATE OF identity_id ON enrolled_devices BEGIN SELECT RAISE(IGNORE); END",
			"CREATE TRIGGER binding_fault AFTER INSERT ON coordinator_auth_device_claims BEGIN UPDATE enrolled_devices SET fingerprint='drift' WHERE device_id='device-a'; END",
		])(
			`${backend} ${mode} binding failure rolls back the winning claim: %s`,
			async (fault, { fixture: f }) => {
				// Arrange: inject after eligibility and before binding, inside the real transaction.
				await confirm(f, "device_claim");
				f.db.exec(fault);
				const before = snapshot(f);
				// Act
				const failed = await complete(f).catch(() => ({ kind: "storage_failure" }));
				// Assert: even claim/link/profile/provenance writes must roll back.
				expect(["storage_failure", "rejected"]).toContain(failed.kind);
				expect(snapshot(f)).toEqual(before);
				f.db.exec("DROP TRIGGER binding_fault");
				expect((await complete(f)).kind).toBe("applied");
			},
		);
		test(`${backend} ${mode} controller links remain account-only`, async ({ fixture: f }) => {
			// Arrange
			await confirm(f, "controller_attestation");
			const before = rows(f, "enrolled_devices");
			// Act
			const result =
				mode === "desktop"
					? await f.store.finalizeAuthLinkAttempt(desktopFinalize(f), f.cfg)
					: await f.store.finalizeHeadlessAuthLinkAttempt(headlessFinalize(f), f.cfg);
			// Assert
			expect(result.kind).toBe("applied");
			expect(rows(f, "coordinator_device_ownership_bindings")).toEqual([]);
			expect(rows(f, "coordinator_device_rebind_audit_log")).toEqual([]);
			expect(rows(f, "enrolled_devices")).toEqual(before);
		});
	}
}
