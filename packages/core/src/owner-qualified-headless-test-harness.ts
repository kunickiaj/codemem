import { expect } from "vitest";
import {
	HEADLESS_CODE_LIMITS_TABLE,
	HEADLESS_LINK_PROVENANCE_TABLE,
} from "./coordinator-auth-headless-schema.js";
import type { QualifiedFixture, qualifiedTest } from "./owner-qualified-consumer-test-harness.js";

/** Marks a link as written by headless finalize, as its finalize batch would. */
async function markHeadless(f: QualifiedFixture, linkId: string) {
	await f.exec(
		`INSERT INTO ${HEADLESS_LINK_PROVENANCE_TABLE} (coordinator_id, link_id, identity_id, issuer, subject,
		 attempt_id, created_at_ms) VALUES ('coordinator-a', ?, 'identity-a', 'https://accounts.google.com', 'fixture-subject', ?, 1)`,
		linkId,
		`headless-${linkId}`,
	);
}

const headlessLinked = {
	kind: "rejected",
	error: "owner_enrollment_unavailable",
	detail: "target_headless_linked",
};

/** Owner enrollment of a fresh device into a qualified device-claim account with a headless link. */
export function registerQualifiedHeadlessTests(test: ReturnType<typeof qualifiedTest>) {
	test("refuses at the Google callback when the active link is headless", async ({
		fixture: f,
	}) => {
		// Arrange
		await f.qualify();
		await f.grant();
		await markHeadless(f, String(f.link.link_id));
		const claim = await f.claim();
		// Act
		const result = await f.api.verifyCallback(claim.request());
		// Assert
		expect(result).toEqual(headlessLinked);
		expect(await f.attempt()).toMatchObject({ state: "browser_claimed", link_id: null });
	});

	test("refuses inside the commit when the link became headless after confirmation", async ({
		fixture: f,
	}) => {
		// Arrange
		await f.qualify();
		await f.grant();
		const final = await f.confirmed();
		await markHeadless(f, String(f.link.link_id));
		// Act
		const result = await f.api.finalize(final);
		// Assert
		expect(result).toEqual(headlessLinked);
		expect(await f.rows("coordinator_device_ownership_bindings")).toEqual([]);
		expect(await f.attempt()).toMatchObject({ state: "confirmed" });
	});

	test("enrolls normally when only another link is headless", async ({ fixture: f }) => {
		// Arrange
		await f.qualify();
		await f.grant();
		await markHeadless(f, "link-other");
		// Act
		const result = await f.api.finalize(await f.confirmed());
		// Assert
		expect(result).toMatchObject({ kind: "finalized", identityId: "identity-a" });
	});

	test("enrolls as before without the headless tables", async ({ fixture: f }) => {
		// Arrange
		await f.qualify();
		await f.grant();
		await f.exec(`DROP TABLE ${HEADLESS_CODE_LIMITS_TABLE}`);
		await f.exec(`DROP TABLE ${HEADLESS_LINK_PROVENANCE_TABLE}`);
		// Act
		const result = await f.api.finalize(await f.confirmed());
		// Assert
		expect(result).toMatchObject({ kind: "finalized", identityId: "identity-a" });
	});
}
