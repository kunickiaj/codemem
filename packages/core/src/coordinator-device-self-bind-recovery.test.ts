import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { review } from "./coordinator-auth-store-test-fixtures.js";
import type { DeviceRebindAttempt } from "./coordinator-device-rebind-proof.js";
import {
	assignLegacyCompletion,
	retainOwnReviewOwnership,
	selfBindFixture,
} from "./coordinator-device-self-bind-test-fixtures.js";
import type { ReviewedWeakLabel } from "./coordinator-legacy-owner-resolution-metadata.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";

type Fixture = Awaited<ReturnType<typeof selfBindFixture>>;
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});

async function fixture(kind: "SQLite" | "D1") {
	const f = await selfBindFixture(kind, "peer");
	close.push(f.close);
	f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	expect(
		await f.store.createAuthControllerAttestation(
			review({
				...f.signer,
				groupId: "group-b",
				identityId: f.identityId,
				attestationId: "second-group-review",
				reviewReceiptId: "second-group-receipt",
			}),
		),
	).toMatchObject({ kind: "created" });
	const backend: AuthLinkBackend =
		kind === "D1"
			? f.backend
			: {
					...f.backend,
					all: async <T>({ sql, values }) => f.db.prepare(sql).all(...values) as T[],
					readBatch: async <T>(statements) =>
						f.db.transaction(() =>
							statements.map(({ sql, values }) => f.db.prepare(sql).all(...values) as T[]),
						)(),
				};
	return { ...f, backend, steps: (ceremony = f.makeCeremony(backend)) => f.steps(ceremony) };
}

function legacyConflict(f: Fixture): ReviewedWeakLabel {
	assignLegacyCompletion({
		...f,
		signer: { ...f.signer, groupId: "group-b" },
		identityId: "old-owner",
	});
	return {
		label: "old-owner",
		kind: "legacy_included_owner_label",
		group_id: "group-b",
		device_id: f.signer.deviceId,
		evidence_ref: "c".repeat(64),
		effect: "account_owner_display_only",
	};
}

async function confirm(f: Fixture, backend: AuthLinkBackend = f.backend) {
	const ceremony = f.makeCeremony(backend);
	const s = f.steps(ceremony);
	expect(await s.start()).toMatchObject({ kind: "started" });
	expect(await s.claim()).toMatchObject({ kind: "browser_claimed" });
	expect(await s.verify()).toMatchObject({ kind: "verified" });
	const confirmed = await s.confirm();
	if (confirmed?.kind !== "confirmed") throw new Error(JSON.stringify(confirmed));
	const row = f.db
		.prepare("SELECT * FROM coordinator_device_rebind_attempts")
		.get() as DeviceRebindAttempt;
	return { ceremony, input: f.finalizedInput(row, confirmed.completionSecret) };
}

function retained(f: Fixture) {
	return [
		"coordinator_auth_controller_attestations",
		"coordinator_auth_account_links",
		"coordinator_identity_group_grants",
		"coordinator_legacy_team_completions",
		"coordinator_legacy_owner_resolutions",
	].map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
}

describe.each(["SQLite", "D1"] as const)("%s multiple-group ownership recovery", (kind) => {
	it("binds the existing key to the same Identity after browser consent without changing reviews or access", async () => {
		const f = await fixture(kind);
		const before = retained(f);
		const { ceremony, input } = await confirm(f);
		expect(await ceremony.finalize(input)).toMatchObject({
			kind: "finalized",
			receipt: {
				previousIdentityId: f.identityId,
				targetIdentityId: f.identityId,
				enrollmentCount: 2,
			},
		});
		expect(await ceremony.finalize(input)).toMatchObject({ kind: "prior_commit" });
		expect(retained(f)).toEqual(before);
		expect(
			f.db
				.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id=? ORDER BY group_id")
				.all(f.signer.deviceId),
		).toEqual([{ identity_id: f.identityId }, { identity_id: f.identityId }]);
	});
});

describe.each(["SQLite", "D1"] as const)("%s reviewed historical-label recovery", (kind) => {
	it.each([
		["an explicitly self-attested owner", "'$.device_decisions[0].identity_evidence','self'"],
		["another key", `'$.device_decisions[0].key_fingerprint','${"f".repeat(64)}'`],
		["another source digest", `'$.source_digest','${"f".repeat(64)}'`],
	])("does not override %s with a historical-label review", async (_kind, change) => {
		const f = await fixture(kind);
		await retainOwnReviewOwnership(f, { reviewedWeakLabels: [legacyConflict(f)] });
		f.db.exec(
			`UPDATE coordinator_legacy_team_completions SET manifest_json=json_set(manifest_json,${change})`,
		);
		expect(await f.steps().start()).toMatchObject({ kind: "refused" });
	});

	it.each([
		{ label: "unreviewed-owner" },
		{ group_id: "another-group" },
		{ device_id: "another-device" },
		{ evidence_ref: "e".repeat(64) },
		{ kind: "consumed_project_actor_label" as const },
	])("refuses a resolution that does not cover this exact label: %j", async (change) => {
		const f = await fixture(kind);
		const label = legacyConflict(f);
		await retainOwnReviewOwnership(f, { reviewedWeakLabels: [{ ...label, ...change }] });
		const before = retained(f);
		expect(await f.steps().start()).toMatchObject({ kind: "refused" });
		expect(f.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all()).toEqual([]);
		expect(retained(f)).toEqual(before);
	});

	it("does not use a label review to override an explicit exclusion", async () => {
		const f = await fixture(kind);
		const label = legacyConflict(f);
		f.db.exec(`UPDATE coordinator_legacy_team_completions SET manifest_json=json_set(manifest_json,
		 '$.device_decisions[0].decision','excluded','$.device_decisions[0].enabled',json('false'))`);
		await retainOwnReviewOwnership(f, { reviewedWeakLabels: [label] });
		expect(await f.steps().start()).toMatchObject({ kind: "refused" });
	});

	it.each(["revoked_at", "review_receipt_id", "evidence_digest", "created_at"])(
		"refuses when the receipt's original source has changed %s",
		async (column) => {
			const f = await fixture(kind);
			await retainOwnReviewOwnership(f, { reviewedWeakLabels: [legacyConflict(f)] });
			f.db
				.prepare(
					`UPDATE coordinator_auth_controller_attestations SET ${column}=? WHERE attestation_id='own-controller'`,
				)
				.run(column === "evidence_digest" ? "f".repeat(64) : "changed");
			expect(await f.steps().start()).toMatchObject({ kind: "refused" });
		},
	);

	it("rejects a changed resolution source in the final binding batch", async () => {
		const f = await fixture(kind);
		await retainOwnReviewOwnership(f, { reviewedWeakLabels: [legacyConflict(f)] });
		const { input } = await confirm(f);
		const ceremony = f.makeCeremony({
			...f.backend,
			batch: async (statements) => {
				f.db.exec(
					"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed' WHERE attestation_id='own-controller'",
				);
				return f.backend.batch(statements);
			},
		});
		expect(await ceremony.finalize(input)).toMatchObject({ kind: "refused" });
		expect(f.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all()).toEqual([]);
		expect(f.db.prepare("SELECT * FROM coordinator_device_rebind_audit_log").all()).toEqual([]);
	});

	it("pins a second group's review throughout browser consent", async () => {
		const f = await fixture(kind);
		const { ceremony, input } = await confirm(f);
		f.db.exec(
			"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed' WHERE attestation_id='second-group-review'",
		);
		expect(await ceremony.finalize(input)).toMatchObject({ kind: "refused" });
		expect(f.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all()).toEqual([]);
	});

	it("requires an exact reviewed label before the browser ceremony can bind the device", async () => {
		const f = await fixture(kind);
		const label = legacyConflict(f);
		expect(await f.steps().start()).toMatchObject({ kind: "refused" });
		await retainOwnReviewOwnership(f, { reviewedWeakLabels: [label] });
		const before = retained(f);
		const { ceremony, input } = await confirm(f);
		expect(await ceremony.finalize(input)).toMatchObject({
			kind: "finalized",
			receipt: {
				previousIdentityId: f.identityId,
				targetIdentityId: f.identityId,
			},
		});
		expect(retained(f)).toEqual(before);
	});
});
