// Each test changes one retained-ownership fact after owner enrollment's reads and just
// before its write batch. The negative owner guards that lead that batch must refuse it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { commitOwnerEnrollment } from "./coordinator-owner-enrollment-commit.js";
import { commitWriterFixture } from "./coordinator-owner-enrollment-historical-test-fixture.js";
import {
	NEGATIVE_OWNER_CHANGES,
	type RaceSubject,
} from "./coordinator-owner-negative-race-test-fixtures.js";
import {
	producerSnapshot,
	retainProducerOwner,
} from "./coordinator-producer-negative-owner-test-fixtures.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	vi.restoreAllMocks();
});

type Fixture = Awaited<ReturnType<typeof commitWriterFixture>>;
const close: Fixture[] = [];
afterEach(() => {
	for (const f of close.splice(0)) f.close();
});

/** A retained resolution by the attempt's own owner, whose original source still exists. */
async function retainedOwnerFixture() {
	const f = await commitWriterFixture();
	close.push(f);
	if (!f.row.identity_id) throw new Error("confirmed fixture identity missing");
	const subject: RaceSubject = {
		coordinatorId: f.row.coordinator_id,
		groupId: "group-a",
		deviceId: f.row.device_id,
		publicKey: f.row.public_key,
		fingerprint: f.row.fingerprint,
		ownerIdentityId: f.row.identity_id,
	};
	await retainProducerOwner(f.db, subject);
	return { f, subject };
}

/** Runs `change` once, after the producer's reads and just before its write batch. */
function beforeWrite(f: Fixture, change: () => void) {
	const original = f.backend;
	let ran = false;
	f.backend = {
		...original,
		all: async <T>(s: AuthLinkStatement) => f.db.prepare(s.sql).all(...s.values) as T[],
		batch: async (statements) => {
			if (!ran) {
				ran = true;
				change();
			}
			return original.batch(statements);
		},
	};
	return { ran: () => ran };
}

// The producer names no enrollment, so the enrollment read selects no group's row.
const races = NEGATIVE_OWNER_CHANGES.filter((race) => race.reads !== "enrollment");

describe("owner enrollment with retained ownership", () => {
	it("commits while nothing changes", async () => {
		// Arrange
		const { f } = await retainedOwnerFixture();
		const hook = beforeWrite(f, () => undefined);
		// Act
		const result = await commitOwnerEnrollment({ ...f.input(), backend: f.backend });
		// Assert
		expect(hook.ran()).toBe(true);
		expect(result).toBe(true);
	});

	it.each(races)("writes nothing when $fact ($reads)", async (race) => {
		// Arrange
		const { f, subject } = await retainedOwnerFixture();
		race.arrange?.(f.db, subject);
		let atWrite: ReturnType<typeof producerSnapshot> | undefined;
		const hook = beforeWrite(f, () => {
			race.change(f.db, subject);
			atWrite = producerSnapshot(f.db);
		});
		// Act
		const result = await commitOwnerEnrollment({ ...f.input(), backend: f.backend });
		// Assert
		expect(hook.ran()).toBe(true);
		expect(result).toBe(false);
		expect(producerSnapshot(f.db)).toEqual(atWrite);
	});
});
