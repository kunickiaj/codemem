import { describe, expect } from "vitest";
import { readHeadlessLinkProvenance } from "./coordinator-auth-headless-provenance.js";
import { HEADLESS_LINK_PROVENANCE_TABLE } from "./coordinator-auth-headless-schema.js";
import {
	AUTHORITIES,
	attemptRow,
	DESKTOP_ID,
	desktopConfirmed,
	desktopFinalize,
	HEADLESS_ID,
	headlessConfirmed,
	headlessFinalize,
	SUBJECT,
} from "./coordinator-auth-link-headless-test-fixtures.js";
import { backendTest, type LinkFixture, status } from "./coordinator-auth-link-test-fixtures.js";

function provenanceRows(f: LinkFixture) {
	return f.db.prepare(`SELECT * FROM ${HEADLESS_LINK_PROVENANCE_TABLE}`).all();
}

function links(f: LinkFixture) {
	return f.db
		.prepare(
			"SELECT link_id, identity_id, issuer, subject, attempt_id, created_at_ms FROM coordinator_auth_account_links",
		)
		.all() as {
		link_id: string;
		identity_id: string;
		issuer: string;
		subject: string;
		attempt_id: string;
		created_at_ms: number;
	}[];
}

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} headless link provenance`, () => {
		const test = backendTest(backend);

		test.for(AUTHORITIES)(
			"records one provenance row with the headless link for %s",
			async (kind, { fixture: f }) => {
				// Arrange
				await headlessConfirmed(f, kind);
				// Act
				const result = await f.store.finalizeHeadlessAuthLinkAttempt(
					headlessFinalize(f, kind),
					f.cfg,
				);
				const retry = await f.store.finalizeHeadlessAuthLinkAttempt(
					headlessFinalize(f, kind),
					f.cfg,
				);
				// Assert
				expect(result).toEqual({ kind: "applied", status: status("finalized", HEADLESS_ID) });
				expect(retry).toEqual({ kind: "existing", status: status("finalized", HEADLESS_ID) });
				const [link] = links(f);
				expect(provenanceRows(f)).toEqual([
					{
						coordinator_id: f.cfg.coordinatorId,
						link_id: link?.link_id,
						identity_id: link?.identity_id,
						issuer: f.cfg.issuer,
						subject: SUBJECT,
						attempt_id: HEADLESS_ID,
						created_at_ms: link?.created_at_ms,
					},
				]);
			},
		);

		test("reads provenance by link ID and by account and Identity", async ({ fixture: f }) => {
			// Arrange
			await headlessConfirmed(f);
			await f.store.finalizeHeadlessAuthLinkAttempt(headlessFinalize(f), f.cfg);
			const [link] = links(f);
			if (!link) throw new Error("fixture_link_missing");
			const backend = await f.store.readHeadlessLinkBackend();
			if (!backend) throw new Error("fixture_headless_capability_missing");
			const account = { identityId: link.identity_id, issuer: f.cfg.issuer, subject: SUBJECT };
			// Act
			const byLink = await readHeadlessLinkProvenance(backend, f.cfg.coordinatorId, link.link_id);
			const byAccount = await readHeadlessLinkProvenance(backend, f.cfg.coordinatorId, account);
			const otherSubject = await readHeadlessLinkProvenance(backend, f.cfg.coordinatorId, {
				...account,
				subject: "someone-else",
			});
			// Assert
			expect(byLink).toEqual({
				coordinatorId: f.cfg.coordinatorId,
				linkId: link.link_id,
				identityId: link.identity_id,
				issuer: f.cfg.issuer,
				subject: SUBJECT,
				attemptId: HEADLESS_ID,
				createdAtMs: link.created_at_ms,
			});
			expect(byAccount).toEqual(byLink);
			expect(otherSubject).toBeNull();
		});

		test("keeps a recorded row through delete, replace and duplicate insert", async ({
			fixture: f,
		}) => {
			// Arrange
			await headlessConfirmed(f);
			await f.store.finalizeHeadlessAuthLinkAttempt(headlessFinalize(f), f.cfg);
			const before = provenanceRows(f);
			const columns =
				"coordinator_id, link_id, identity_id, issuer, subject, attempt_id, created_at_ms";
			const copy = `SELECT ${columns} FROM ${HEADLESS_LINK_PROVENANCE_TABLE}`;
			// Act and assert
			expect(() => f.db.exec(`DELETE FROM ${HEADLESS_LINK_PROVENANCE_TABLE}`)).toThrow(
				"headless_link_provenance_retained",
			);
			expect(() =>
				f.db.exec(`INSERT OR REPLACE INTO ${HEADLESS_LINK_PROVENANCE_TABLE} (${columns}) ${copy}`),
			).toThrow("headless_link_provenance_retained");
			expect(() =>
				f.db.exec(`INSERT INTO ${HEADLESS_LINK_PROVENANCE_TABLE} (${columns}) ${copy}`),
			).toThrow("headless_link_provenance_retained");
			expect(provenanceRows(f)).toEqual(before);
		});

		test.for(AUTHORITIES)(
			"records no provenance for a desktop link with %s",
			async (kind, { fixture: f }) => {
				// Arrange
				await desktopConfirmed(f, kind);
				// Act
				const result = await f.store.finalizeAuthLinkAttempt(desktopFinalize(f, kind), f.cfg);
				// Assert
				expect(result).toEqual({ kind: "applied", status: status("finalized", DESKTOP_ID) });
				expect(links(f)).toHaveLength(1);
				expect(provenanceRows(f)).toEqual([]);
			},
		);

		test.for(AUTHORITIES)(
			"refuses to link without the provenance table for %s",
			async (kind, { fixture: f }) => {
				// Arrange
				await headlessConfirmed(f, kind);
				f.db.exec(`DROP TABLE ${HEADLESS_LINK_PROVENANCE_TABLE}`);
				// Act
				const result = await f.store.finalizeHeadlessAuthLinkAttempt(
					headlessFinalize(f, kind),
					f.cfg,
				);
				// Assert
				expect(result).toEqual({ kind: "rejected", error: "attempt_unavailable" });
				expect(links(f)).toEqual([]);
				expect(attemptRow(f, HEADLESS_ID)).toMatchObject({ state: "confirmed", link_id: null });
				expect(await f.store.readHeadlessLinkBackend()).toBeNull();
			},
		);
	});
}
