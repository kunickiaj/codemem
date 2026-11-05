import { describe, expect, it } from "vitest";
import {
	RELAY_ADDRESS_MAX_ENTRIES,
	RELAY_ADDRESS_REFILL_MS,
	RelayAddressAllowances,
	relayAddressKey,
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

describe("relay address key", () => {
	it.each([
		["192.0.2.7", "192.0.2.7"],
		["::ffff:192.0.2.7", "192.0.2.7"],
		["0:0:0:0:0:ffff:192.0.2.7", "192.0.2.7"],
		["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
		["2001:DB8:1:2:ffff::1", "2001:db8:1:2::/64"],
		["2001:0db8:0001:0002::", "2001:db8:1:2::/64"],
		["2001:db8::1", "2001:db8:0:0::/64"],
		["fe80::1%en0", "fe80:0:0:0::/64"],
		[`%${"%".repeat(50_000)}`, ""],
		["::1", "0:0:0:0::/64"],
		["", ""],
		["not-an-address", "not-an-address"],
		["1:2:3", "1:2:3"],
	])("keys %s as %s", (address, key) => {
		expect(relayAddressKey(address)).toBe(key);
	});

	it("puts every address in one IPv6 /64 in one bucket", () => {
		const { allowances: a } = allowances();
		expect(a.take(relayAddressKey("2001:db8:1:2::a"))).toBe(true);
		expect(a.take(relayAddressKey("2001:db8:1:2::b"))).toBe(true);
		expect(a.take(relayAddressKey("2001:db8:1:2::c"))).toBe(false);
		expect(a.take(relayAddressKey("2001:db8:1:3::a"))).toBe(true);
	});
});
