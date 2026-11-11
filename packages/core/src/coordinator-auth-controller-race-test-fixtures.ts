import type { Database } from "better-sqlite3";
import { vi } from "vitest";

// Every read-set guard aborts through this JSON path, and guards lead their batch.
const GUARD_MARKER = "auth_snapshot_changed";
const RESTART = Symbol("restart the batch after the change");
type Transaction = ((...args: unknown[]) => unknown) &
	Record<"deferred" | "immediate" | "exclusive", (...args: unknown[]) => unknown>;

/**
 * Runs `mutate` once, just before the `nth` transaction that runs read-set guards: after a
 * controller review's reads, before the batch or transaction that writes or answers, and
 * outside it, so the change survives that transaction's own rollback. The transaction is
 * stopped at its first guard, before any of its statements ran, and then run from its start.
 * A list of positions runs `mutate` before each, with the position it reached.
 */
export function beforeGuardedTransaction(
	db: Database,
	mutate: (nth: number) => void,
	nth: number | number[] = 1,
) {
	const positions = new Set(Array.isArray(nth) ? nth : [nth]);
	const prepare = db.prepare.bind(db);
	const transaction = db.transaction.bind(db);
	let seen = 0;
	let counted = false;
	const fired = new Set<number>();
	const prepared = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		if (db.inTransaction && sql.includes(GUARD_MARKER) && !counted) {
			counted = true;
			seen += 1;
			if (positions.has(seen) && !fired.has(seen)) {
				fired.add(seen);
				throw RESTART;
			}
		}
		return prepare(sql);
	});
	const restartable =
		(run: (...args: unknown[]) => unknown) =>
		(...args: unknown[]) => {
			counted = false;
			try {
				return run(...args);
			} catch (error) {
				if (error !== RESTART) throw error;
				mutate(seen);
				counted = true;
				return run(...args);
			}
		};
	const transactions = vi.spyOn(db, "transaction").mockImplementation((fn) => {
		const tx = transaction(fn) as unknown as Transaction;
		return Object.assign(restartable(tx), {
			deferred: restartable(tx.deferred),
			immediate: restartable(tx.immediate),
			exclusive: restartable(tx.exclusive),
		}) as unknown as ReturnType<typeof transaction>;
	});
	return {
		observed: () => fired.size === positions.size,
		/** The positions reached, in order. */
		reached: () => [...fired],
		restore() {
			prepared.mockRestore();
			transactions.mockRestore();
		},
	};
}

/**
 * Runs each stage's `mutate` once, in order, before the next execution of a statement
 * matching its `pattern`, whether or not guards lead it. Outside a transaction the change
 * lands just before that statement. Inside one, the transaction stops there and runs again
 * from its start, so the change also precedes any guards in front of it.
 */
export function beforeStatements(db: Database, stages: { pattern: RegExp; mutate: () => void }[]) {
	const prepare = db.prepare.bind(db);
	const transaction = db.transaction.bind(db);
	let next = 0;
	let pending = false;
	// Advance first: a change may itself prepare a statement a later stage matches.
	const fire = () => {
		const stage = stages[next];
		next += 1;
		stage?.mutate();
	};
	const prepared = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		if (pending || !stages[next]?.pattern.test(sql)) return prepare(sql);
		if (db.inTransaction) {
			pending = true;
			throw RESTART;
		}
		fire();
		return prepare(sql);
	});
	const restartable =
		(run: (...args: unknown[]) => unknown) =>
		(...args: unknown[]) => {
			try {
				return run(...args);
			} catch (error) {
				if (error !== RESTART) throw error;
				fire();
				pending = false;
				return run(...args);
			}
		};
	const transactions = vi.spyOn(db, "transaction").mockImplementation((fn) => {
		const tx = transaction(fn) as unknown as Transaction;
		return Object.assign(restartable(tx), {
			deferred: restartable(tx.deferred),
			immediate: restartable(tx.immediate),
			exclusive: restartable(tx.exclusive),
		}) as unknown as ReturnType<typeof transaction>;
	});
	return {
		/** How many stages ran. */
		reached: () => next,
		restore() {
			prepared.mockRestore();
			transactions.mockRestore();
		},
	};
}

// The statements a controller review checks with, in the SQLite store's transaction: its
// guards, its reads of the reviewed snapshot, and its plain insert, eligibility and
// current-attestation statements.
const CONTROLLER_CHECK = [
	new RegExp(GUARD_MARKER),
	/json_array\(i\.invite_id/,
	/\bSELECT 1 AS eligible FROM enrolled_devices e\b/,
	/\bINSERT INTO coordinator_auth_controller_attestations\s*\(/,
	/\bSELECT a\.\* FROM coordinator_auth_controller_attestations a\s+JOIN enrolled_devices e\b/,
];

/**
 * Runs `mutate` once inside the SQLite store's transaction, just before its first
 * controller check. That transaction reads and writes atomically, so this is the moment
 * the old single statement checked everything; a refusal there commits no write.
 */
export function beforeControllerCheck(db: Database, mutate: () => void) {
	const prepare = db.prepare.bind(db);
	let observed = false;
	const prepared = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		if (!observed && db.inTransaction && CONTROLLER_CHECK.some((check) => check.test(sql))) {
			observed = true;
			mutate();
		}
		return prepare(sql);
	});
	return { observed: () => observed, restore: () => prepared.mockRestore() };
}
