import { describe, expect, it } from "vitest";
import {
	RELAY_ADDRESS_MAX_ENTRIES,
	RELAY_ADDRESS_REFILL_MS,
	RelayAddressAllowances,
} from "./relay-address-allowance.js";

function allowances(start = 0) {
	const clock = { now: start };
	return { clock, allowances: new RelayAddressAllowances(() => clock.now) };
}

describe("relay address allowances", () => {
	it("allows a burst of two, then one attempt per refill interval", () => {
		const { clock, allowances: a } = allowances();
		expect([a.take("x"), a.take("x"), a.take("x")]).toEqual([true, true, false]);
		clock.now += RELAY_ADDRESS_REFILL_MS;
		expect([a.take("x"), a.take("x")]).toEqual([true, false]);
	});

	it("keeps each address separate", () => {
		const { allowances: a } = allowances();
		a.take("x");
		a.take("x");
		expect(a.take("x")).toBe(false);
		expect(a.take("y")).toBe(true);
	});

	it("refuses new addresses once the table is full, until entries expire", () => {
		const { clock, allowances: a } = allowances();
		for (let i = 0; i < RELAY_ADDRESS_MAX_ENTRIES; i++) expect(a.take(`a${i}`)).toBe(true);
		expect(a.take("new")).toBe(false);
		expect(a.take("a0")).toBe(true);
		clock.now += 60_000;
		expect(a.take("new")).toBe(true);
	});
});
