// The negative owner read set on its own: what it allows, and that each of its guards
// aborts a write when its fact changes after the reads and before that write.
import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { writeGuarded } from "./coordinator-auth-read-set.js";
import {
	retainOwnReviewOwnership,
	selfBindFixture,
} from "./coordinator-device-self-bind-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	NEGATIVE_OWNER_CHANGES,
	type RaceSubject,
} from "./coordinator-owner-negative-race-test-fixtures.js";
import { readNegativeOwnerConsistency } from "./coordinator-owner-negative-read-set.js";

type Fixture = Awaited<ReturnType<typeof selfBindFixture>>;
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});

async function fixture() {
	const f = await selfBindFixture("D1", "peer");
	close.push(f.close);
	const subject: RaceSubject = {
		coordinatorId: f.config.coordinatorId,
		...f.signer,
		ownerIdentityId: f.input.currentIdentityId,
	};
	return { f, subject };
}

const read = (f: Fixture, subject: RaceSubject, owner = subject.ownerIdentityId) =>
	readNegativeOwnerConsistency(f.backend, {
		coordinatorId: subject.coordinatorId,
		deviceId: subject.deviceId,
		publicKey: subject.publicKey,
		fingerprint: subject.fingerprint,
		ownerIdentityId: owner,
		enrollment: { groupId: subject.groupId },
	});

/** A write the guards protect: it records a marker row only if every guard holds. */
async function guardedWrite(f: Fixture, guards: AuthLinkStatement[]) {
	f.db.exec("CREATE TABLE IF NOT EXISTS raced_write (n INTEGER)");
	const result = await writeGuarded(f.backend, guards, [
		{ sql: "INSERT INTO raced_write (n) VALUES (1)", values: [] },
	]);
	const written = (f.db.prepare("SELECT count(*) AS n FROM raced_write").get() as { n: number }).n;
	return { result, written };
}

describe("negative owner read set with retained ownership", () => {
	it("allows the retained owner and commits while nothing changes", async () => {
		// Arrange
		const { f, subject } = await fixture();
		await retainOwnReviewOwnership(f);
		// Act
		const negative = await read(f, subject);
		// Assert
		expect(negative).not.toBeNull();
		expect(await guardedWrite(f, negative?.guards ?? [])).toEqual({
			result: "committed",
			written: 1,
		});
	});

	it("refuses another owner", async () => {
		// Arrange
		const { f, subject } = await fixture();
		await retainOwnReviewOwnership(f);
		// Act
		const negative = await read(f, subject, "another-identity");
		// Assert
		expect(negative).toBeNull();
	});

	it("refuses when the resolution's original source no longer matches", async () => {
		// Arrange: the review the resolution names is revoked before the reads.
		const { f, subject } = await fixture();
		await retainOwnReviewOwnership(f);
		f.db
			.prepare("UPDATE coordinator_auth_controller_attestations SET revoked_at=? WHERE device_id=?")
			.run("2026-10-20T00:00:00.000Z", subject.deviceId);
		// Act
		const negative = await read(f, subject);
		// Assert
		expect(negative).toBeNull();
	});

	it.each(NEGATIVE_OWNER_CHANGES)("aborts the write when $fact ($reads)", async (race) => {
		// Arrange
		const { f, subject } = await fixture();
		await retainOwnReviewOwnership(f);
		race.arrange?.(f.db, subject);
		const negative = await read(f, subject);
		if (!negative) throw new Error("expected the retained owner to be allowed");
		// Act
		race.change(f.db, subject);
		const outcome = await guardedWrite(f, negative.guards);
		// Assert
		expect(outcome).toEqual({ result: "changed", written: 0 });
	});

	it("keeps the retained guards to facts a producer's own writes never change", async () => {
		// Arrange
		const { f, subject } = await fixture();
		await retainOwnReviewOwnership(f);
		const negative = await read(f, subject);
		if (!negative) throw new Error("expected the retained owner to be allowed");
		const [claim, resolution] = ["claims", "retained resolutions"].map((reads) =>
			NEGATIVE_OWNER_CHANGES.find((race) => race.reads.startsWith(reads)),
		);
		// Act: the device's own new claim, then a new retained resolution.
		claim?.change(f.db, subject);
		const afterClaim = await guardedWrite(f, negative.retainedGuards);
		resolution?.change(f.db, subject);
		const afterResolution = await guardedWrite(f, negative.retainedGuards);
		// Assert
		expect(afterClaim).toEqual({ result: "committed", written: 1 });
		expect(afterResolution).toEqual({ result: "changed", written: 1 });
	});
});

describe("negative owner read set without retained ownership", () => {
	it("allows a device when the resolution table is missing, until the table appears", async () => {
		// Arrange
		const { f, subject } = await fixture();
		f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
		const negative = await read(f, subject);
		if (!negative) throw new Error("expected a missing table to allow the device");
		// Act
		f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
		const outcome = await guardedWrite(f, negative.guards);
		// Assert
		expect(outcome).toEqual({ result: "changed", written: 0 });
	});

	it("allows a device with no retained resolution, until one is stored", async () => {
		// Arrange
		const { f, subject } = await fixture();
		f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
		const negative = await read(f, subject);
		if (!negative) throw new Error("expected no retained fact to allow the device");
		const unchanged = await guardedWrite(f, negative.guards);
		// Act
		await retainOwnReviewOwnership(f);
		const outcome = await guardedWrite(f, negative.guards);
		// Assert
		expect(unchanged).toEqual({ result: "committed", written: 1 });
		expect(outcome).toEqual({ result: "changed", written: 1 });
	});

	it("refuses a resolution table it does not recognize", async () => {
		// Arrange
		const { f, subject } = await fixture();
		f.db.exec(
			"DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions; CREATE TABLE coordinator_legacy_owner_resolutions (device_id TEXT)",
		);
		// Act
		const negative = await read(f, subject);
		// Assert
		expect(negative).toBeNull();
	});
});
