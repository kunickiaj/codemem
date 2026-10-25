import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	db,
	exec,
	installSchema,
	type Producer,
	type ProducerKind,
	producer,
	reset,
	resolutionTable,
	retain,
	sourceTable,
	state,
	timestamp,
} from "./owner-producer-consistency-test-fixtures.js";

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await reset();
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type Outcome = { returned: unknown; error?: never } | { error: unknown; returned?: never };
async function run(p: Producer): Promise<Outcome> {
	try {
		return { returned: await p.run() };
	} catch (error) {
		return { error };
	}
}
function accepted(p: Producer, outcome: Outcome) {
	expect(outcome.error).toBeUndefined();
	if (p.kind === "enrollment") expect(outcome.returned).toBe(true);
	else if (p.kind === "claim") expect(outcome.returned).toMatchObject({ kind: "applied" });
	else expect(outcome.returned).toMatchObject({ status: "accepted" });
}
function denied(p: Producer, outcome: Outcome) {
	if (p.kind === "enrollment") {
		expect(outcome.error).toBeUndefined();
		expect(outcome.returned).toBe(false);
	} else if (p.kind === "claim") {
		expect(outcome.error).toBeUndefined();
		expect(outcome.returned).toMatchObject({ kind: "rejected" });
	} else expect(outcome.error).toBeInstanceOf(Error);
}

for (const kind of [
	"claim",
	"enrollment",
	"team_member",
	"add_device",
] as const satisfies readonly ProducerKind[]) {
	describe(`native ${kind} retained owner consistency`, () => {
		it("preserves ordinary admission with native default SQL limits and at most 100 binds", async () => {
			// Arrange: real confirmed proof or reviewed invite, not a mocked admission result.
			const p = await producer(kind);
			// Act
			const outcome = await run(p);
			// Assert: the configured native runtime retains default depth/compound limits.
			accepted(p, outcome);
			expect(p.h.maxBinds()).toBeGreaterThan(0);
			expect(p.h.maxBinds()).toBeLessThanOrEqual(100);
		});

		it.each(["device", "key"] as const)(
			"retained A denies requested B by %s after source removal",
			async (match) => {
				// Arrange: source removal prevents old live-controller guards from masking this check.
				const p = await producer(kind);
				await retain({ ...p.subject, ownerIdentityId: "owner-A" }, { match, removeSource: true });
				const before = await state();
				// Act
				const outcome = await run(p);
				// Assert: includes all attempts, tokens, grants, bindings, links and audit siblings.
				denied(p, outcome);
				expect(await state()).toEqual(before);
			},
		);

		it("pins absent catalog at the actual winning native batch", async () => {
			// Arrange: SQL is fully composed before the external DDL change.
			const p = await producer(kind);
			await exec(`DROP TABLE ${resolutionTable}`);
			p.h.arm(installSchema);
			// Act
			const outcome = await run(p);
			// Assert: no sibling write survives the zero-row winner; external DDL stays.
			expect(p.h.observed()).toBe(true);
			denied(p, outcome);
			expect(await state()).toEqual(p.h.afterMutation());
		});

		it("pins empty subject facts at the actual winning native batch", async () => {
			// Arrange: persist only a negative receipt at the final execution boundary.
			const p = await producer(kind);
			p.h.arm(async () => {
				await retain({ ...p.subject, ownerIdentityId: "owner-A" }, { removeSource: true });
			});
			// Act
			const outcome = await run(p);
			// Assert: the injected fact remains; every producer-owned sibling rolls back.
			expect(p.h.observed()).toBe(true);
			denied(p, outcome);
			expect(await state()).toEqual(p.h.afterMutation());
		});

		it("same-owner receipt cannot replace ordinary admission or ledger proof", async () => {
			// Arrange: a valid receipt never relaxes disabled enrollment, revoked grants or ownership ledger denial.
			const p = await producer(kind);
			await retain(p.subject);
			await p.denyAdmission();
			const before = await state();
			// Act
			const outcome = await run(p);
			// Assert
			denied(p, outcome);
			expect(await state()).toEqual(before);
		});

		it("validates and pins one catalog snapshot despite index restoration between reads", async () => {
			// Arrange: an unsupported first snapshot must not borrow readiness from a later read.
			const p = await producer(kind);
			const index = "idx_legacy_owner_resolutions_key";
			const definition = await db
				.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='index'")
				.bind(index)
				.first<{ sql: string }>();
			if (!definition) throw new Error("native key index missing before race");
			await exec(`DROP INDEX ${index}`);
			let afterExternal = await state();
			p.h.afterCatalog(async () => {
				await exec(definition.sql);
				afterExternal = await state();
			});
			p.h.arm(async () => {
				await exec(`DROP INDEX ${index}`);
			});
			// Act
			const outcome = await run(p);
			// Assert: early refusal is correct; a reached winning batch must pin the same bytes.
			expect(p.h.catalogObserved()).toBe(true);
			denied(p, outcome);
			expect(await state()).toEqual(p.h.afterMutation() ?? afterExternal);
		});
	});
}

for (const kind of ["enrollment", "team_member", "add_device"] as const) {
	describe(`native ${kind} retained original source`, () => {
		it("accepts ordinary same-owner admission after source group/enrollment removal", async () => {
			// Arrange: the one complete original controller remains; its old group never exists.
			const p = await producer(kind);
			await retain(p.subject);
			const original = (await db.prepare(`SELECT * FROM ${sourceTable}`).all()).results;
			const receipts = (await db.prepare(`SELECT * FROM ${resolutionTable}`).all()).results;
			// Act
			const outcome = await run(p);
			// Assert: compose the full native evidence predicate without granting access from metadata.
			accepted(p, outcome);
			expect(p.h.maxBinds()).toBeGreaterThan(0);
			expect(p.h.maxBinds()).toBeLessThanOrEqual(100);
			expect((await db.prepare(`SELECT * FROM ${sourceTable}`).all()).results).toEqual(original);
			expect((await db.prepare(`SELECT * FROM ${resolutionTable}`).all()).results).toEqual(
				receipts,
			);
		});

		it("rechecks source revocation at the actual winning batch and rolls back siblings", async () => {
			// Arrange: the source verifies during capture but loses authority immediately before execution.
			const p = await producer(kind);
			await retain(p.subject);
			p.h.arm(async () => {
				await exec(
					`UPDATE ${sourceTable} SET revoked_at=? WHERE attestation_id='producer-original-controller'`,
					timestamp,
				);
			});
			// Act
			const outcome = await run(p);
			// Assert
			expect(p.h.observed()).toBe(true);
			denied(p, outcome);
			expect(await state()).toEqual(p.h.afterMutation());
		});
	});
}

for (const kind of ["team_member", "add_device"] as const) {
	it(`native ${kind} without trusted namespace rejects relevant foreign ownership`, async () => {
		// Arrange: neither the recipient actor nor Team supplies an implicit coordinator.
		const p = await producer(kind);
		await retain(p.subject, { foreign: true, removeSource: true });
		p.omitNamespace?.();
		const before = await state();
		// Act
		const outcome = await run(p);
		// Assert
		denied(p, outcome);
		expect(await state()).toEqual(before);
	});
}
