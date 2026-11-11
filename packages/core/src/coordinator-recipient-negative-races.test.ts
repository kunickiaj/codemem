// Each test changes one retained-ownership fact after a recipient invite's reads and just
// before its first write batch. The negative owner guards that lead it must refuse it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fixture, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { NEGATIVE_OWNER_CHANGES } from "./coordinator-owner-negative-race-test-fixtures.js";
import { producerSnapshot } from "./coordinator-producer-negative-owner-test-fixtures.js";
import {
	afterRetainedRead,
	retainedRecipientFixture,
	sameOwnerResolution,
} from "./coordinator-recipient-negative-race-test-fixtures.js";
import type { CoordinatorConsumeRecipientInviteInput } from "./coordinator-store-contract.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
	vi.restoreAllMocks();
});

const TOKEN_WRITE = /UPDATE coordinator_invites SET token\s*=/;
type Kind = "SQLite" | "D1";

const retainedRecipient = (backend: Kind, kind: "team_member" | "add_device") =>
	retainedRecipientFixture(backend, kind, cleanup);

/**
 * Consumes the invite, running `change` after the reads and before the first write batch.
 * D1 writes in batches the test can see; the SQLite store writes in one transaction.
 */
async function consumeWith(
	backend: Kind,
	f: Fixture,
	input: CoordinatorConsumeRecipientInviteInput,
	change: () => void,
) {
	if (backend === "SQLite") {
		// The store's write transaction is its only immediate one; its reads come before it.
		let ran = false;
		const transaction = f.db.transaction.bind(f.db);
		type Tx = ReturnType<typeof transaction>;
		const hook = vi.spyOn(f.db, "transaction").mockImplementation((fn) => {
			const tx = transaction(fn);
			const immediate = (...args: unknown[]) => {
				if (!ran) {
					ran = true;
					change();
				}
				return tx.immediate(...(args as []));
			};
			return Object.assign((...args: unknown[]) => tx(...(args as [])), {
				default: tx.default,
				deferred: tx.deferred,
				immediate,
				exclusive: tx.exclusive,
			}) as unknown as Tx;
		});
		try {
			const outcome = await f.store.consumeRecipientInvite(input).catch((e: unknown) => e);
			return { outcome, ran };
		} finally {
			hook.mockRestore();
		}
	}
	let ran = false;
	const store = new D1CoordinatorStore(
		sqliteD1(f.db, {
			beforeBatch: (statements) => {
				if (ran || !statements.some(({ query }) => TOKEN_WRITE.test(query))) return;
				ran = true;
				change();
			},
		}),
	);
	return { outcome: await store.consumeRecipientInvite(input).catch((e: unknown) => e), ran };
}

// The recipient names no enrollment, so the enrollment read selects no group's row.
const races = NEGATIVE_OWNER_CHANGES.filter((race) => race.reads !== "enrollment");

describe.each(["SQLite", "D1"] as const)(
	"%s recipient invite with retained ownership",
	(backend) => {
		it.each(["team_member", "add_device"] as const)(
			"accepts a %s invite while nothing changes",
			async (kind) => {
				// Arrange
				const { f, input } = await retainedRecipient(backend, kind);
				// Act
				const { outcome, ran } = await consumeWith(backend, f, input, () => undefined);
				// Assert
				expect(ran).toBe(true);
				expect(outcome).toMatchObject({ status: "accepted" });
			},
		);

		it.each(races)("refuses and writes nothing when $fact ($reads)", async (race) => {
			// Arrange
			const { f, input, subject } = await retainedRecipient(backend, "add_device");
			race.arrange?.(f.db, subject);
			let atWrite: ReturnType<typeof producerSnapshot> | undefined;
			// Act
			const { outcome, ran } = await consumeWith(backend, f, input, () => {
				race.change(f.db, subject);
				atWrite = producerSnapshot(f.db);
			});
			// Assert
			expect(ran).toBe(true);
			expect(outcome).toBeInstanceOf(Error);
			expect(producerSnapshot(f.db)).toEqual(atWrite);
		});
	},
);

describe.each(["SQLite", "D1"] as const)(
	"%s recipient invite when a same-owner resolution lands between the retained and evidence reads",
	(backend) => {
		it("accepts, rather than reporting failure after its writes committed", async () => {
			// Arrange
			const { f, input } = await retainedRecipient(backend, "add_device");
			const hook = afterRetainedRead(f, () => sameOwnerResolution(f));
			// Act
			const { outcome } = await consumeWith(backend, f, input, () => undefined);
			hook.restore();
			// Assert: like main, it accepts this compatible owner and its writes stand.
			expect(hook.ran()).toBe(true);
			expect(outcome).toMatchObject({ status: "accepted" });
			expect(
				f.db
					.prepare("SELECT count(*) AS n FROM enrolled_devices WHERE device_id=?")
					.get(input.deviceId),
			).toEqual({ n: 1 });
		});
	},
);
