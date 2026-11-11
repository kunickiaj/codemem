// Each test changes one retained-ownership fact after the self-bind reads and before the
// batch that writes. The negative owner guards in that batch must refuse the step.
import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import type { DeviceRebindAttempt } from "./coordinator-device-rebind-proof.js";
import {
	retainOwnReviewOwnership,
	selfBindFixture,
} from "./coordinator-device-self-bind-test-fixtures.js";
import {
	NEGATIVE_OWNER_CHANGES,
	type NegativeOwnerChange,
	type RaceSubject,
} from "./coordinator-owner-negative-race-test-fixtures.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});

type Fixture = Awaited<ReturnType<typeof selfBindFixture>>;
const PHASES = ["start", "claim", "callback", "confirm", "commit"] as const;
const ADVANCED = /^(started|browser_claimed|verified|confirmed|finalized|prior_commit)$/;
type Phase = (typeof PHASES)[number];
const STATE_BEFORE = {
	start: undefined,
	claim: "pending",
	callback: "browser_claimed",
	confirm: "oidc_verified",
	commit: "confirmed",
} as const;
const attemptState = (f: Fixture) =>
	(
		f.db.prepare("SELECT state FROM coordinator_device_rebind_attempts").get() as
			| { state: string }
			| undefined
	)?.state;

/** Runs the ceremony to the phase, then applies the change just before that phase writes. */
async function race(phase: Phase, change: NegativeOwnerChange) {
	const f = await selfBindFixture("D1", "peer");
	close.push(f.close);
	await retainOwnReviewOwnership(f);
	const subject: RaceSubject = {
		coordinatorId: f.config.coordinatorId,
		...f.signer,
		ownerIdentityId: f.input.currentIdentityId,
	};
	change.arrange?.(f.db, subject);
	let armed = false;
	const racing: AuthLinkBackend = {
		...f.backend,
		batch: async (statements) => {
			if (armed) change.change(f.db, subject);
			armed = false;
			return f.backend.batch(statements);
		},
	};
	const ceremony = f.makeCeremony(racing);
	const s = f.steps(ceremony);
	const steps = [s.start, s.claim, s.verify, s.confirm];
	let last: Awaited<ReturnType<typeof s.confirm>> = null;
	for (const step of steps.slice(0, PHASES.indexOf(phase))) {
		last = await step();
		expect(last?.kind).toMatch(ADVANCED);
	}
	const finalize = () => {
		if (last?.kind !== "confirmed") throw new Error(JSON.stringify(last));
		const row = f.db
			.prepare("SELECT * FROM coordinator_device_rebind_attempts")
			.get() as DeviceRebindAttempt;
		return ceremony.finalize(f.finalizedInput(row, last.completionSecret));
	};
	armed = true;
	const result = await (steps[PHASES.indexOf(phase)] ?? finalize)();
	return { f, result, changed: !armed };
}

describe("self-bind start with retained ownership", () => {
	it.each(NEGATIVE_OWNER_CHANGES)("refuses the start when $fact ($reads)", async (change) => {
		// Arrange, Act
		const { f, result, changed } = await race("start", change);
		// Assert
		expect(changed).toBe(true);
		expect(result).toEqual({ kind: "refused", reason: "unavailable" });
		expect(attemptState(f)).toBeUndefined();
	});
});

// A fact only the negative owner reads select: an unparseable completion naming the device.
const historyOnly = NEGATIVE_OWNER_CHANGES.find((change) => change.reads === "history");
describe("later self-bind steps with retained ownership", () => {
	it.each(PHASES.slice(1))("refuses the %s step when retained history changes", async (phase) => {
		// Arrange, Act
		if (!historyOnly) throw new Error("history change missing");
		const { f, result, changed } = await race(phase, historyOnly);
		// Assert: the attempt stays where it was and nothing is bound.
		expect(changed).toBe(true);
		expect(result?.kind).not.toMatch(ADVANCED);
		expect(attemptState(f)).toBe(STATE_BEFORE[phase]);
		expect(f.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all()).toEqual([]);
	});
});
