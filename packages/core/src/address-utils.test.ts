import { describe, expect, it } from "vitest";
import { MAX_PEER_ADDRESSES, mergeCoordinatorPeerAddresses } from "./address-utils.js";

const manualArchive = Array.from(
	{ length: 160 },
	(_, index) => `http://manual-${index}.example:7337`,
);
const freshAddresses = Array.from(
	{ length: 10 },
	(_, index) => `http://fresh-${index}.example:7337`,
);
const successfulAddress = "http://successful.example:7337";

describe("mergeCoordinatorPeerAddresses", () => {
	it("reserves six fresh slots despite an overflowing manual archive and successful fallback", () => {
		const result = mergeCoordinatorPeerAddresses(manualArchive, freshAddresses, manualArchive, {
			successfulAddress,
		});

		expect(result).toEqual([...freshAddresses.slice(0, 6), successfulAddress, manualArchive[0]]);
		expect(manualArchive).toHaveLength(160);
	});

	it("admits a late current IPv4 candidate after moving link-local IPv6 candidates last", () => {
		const linkLocal = Array.from({ length: 11 }, (_, index) => `http://[fe80::${index + 1}]:7337`);
		const global = ["http://[2001:db8::1]:7337", "http://[2001:db8::2]:7337"];
		const current = "http://192.0.2.25:7337";
		const candidates = [...linkLocal.slice(0, 1), ...global, ...linkLocal.slice(1), current];

		const result = mergeCoordinatorPeerAddresses(manualArchive, candidates, manualArchive, {
			successfulAddress,
		});

		expect(candidates.indexOf(current)).toBe(13);
		expect(result).toEqual([
			...global,
			current,
			...linkLocal.slice(0, 3),
			successfulAddress,
			manualArchive[0],
		]);
		expect(candidates[0]).toBe(linkLocal[0]);
	});

	it("deprioritizes the whole IPv6 link-local /10 range without reordering other candidates", () => {
		const linkLocal = ["http://[fe80::1]:7337", "http://[febf::1]:7337"];
		const other = ["http://[fec0::1]:7337", "http://192.0.2.1:7337", "http://[2001:db8::1]:7337"];

		expect(
			mergeCoordinatorPeerAddresses(
				[],
				[...linkLocal.slice(0, 1), ...other, ...linkLocal.slice(1)],
			),
		).toEqual([...other, ...linkLocal]);
	});

	it("retains link-local manual and successful fallbacks", () => {
		const successful = "http://[fe80::1]:7337";
		const manual = "http://[fe80::2]:7337";

		expect(
			mergeCoordinatorPeerAddresses([], freshAddresses, [manual], {
				successfulAddress: successful,
			}),
		).toEqual([...freshAddresses.slice(0, 6), successful, manual]);
	});

	it("keeps manual and cached fallbacks when no fresh candidates exist", () => {
		const cached = "http://cached.example:7337";

		expect(
			mergeCoordinatorPeerAddresses([cached], [], manualArchive, { successfulAddress }),
		).toEqual([
			successfulAddress,
			...manualArchive.slice(0, 2),
			...manualArchive.slice(-2),
			cached,
		]);
	});

	it("keeps all eight manual addresses when no fresh candidates exist", () => {
		const manual = manualArchive.slice(0, MAX_PEER_ADDRESSES);

		expect(mergeCoordinatorPeerAddresses(manual, [], manual)).toEqual(manual);
	});

	it("uses spare slots for protected fallbacks when few fresh candidates exist", () => {
		expect(
			mergeCoordinatorPeerAddresses(manualArchive, freshAddresses.slice(0, 2), manualArchive, {
				successfulAddress,
			}),
		).toEqual([
			...freshAddresses.slice(0, 2),
			successfulAddress,
			...manualArchive.slice(0, 2),
			...manualArchive.slice(-2),
			manualArchive[2],
		]);
	});

	it("fills all eight slots from fresh candidates when no fallbacks exist", () => {
		expect(mergeCoordinatorPeerAddresses([], freshAddresses)).toEqual(freshAddresses.slice(0, 8));
	});
});

describe("coordinator address normalization and explicit pairing", () => {
	it("keeps five manual addresses active when promoting a successful address from a crowded cache", () => {
		// Arrange: success promotion must not inherit the coordinator's six-fresh reservation.
		const manual = manualArchive.slice(0, 5);
		const cached = ["http://[fe80::1]:7337", ...freshAddresses.slice(0, 7)];

		// Act
		const result = mergeCoordinatorPeerAddresses(cached, [successfulAddress, ...cached], manual, {
			requiredFreshAddresses: 1,
			successfulAddress,
		});

		// Assert: promotion stays first, cached order stays intact, and all manual fallbacks fit.
		expect(result).toEqual([successfulAddress, cached[0], ...manual, cached[1]]);
		expect(result).toHaveLength(MAX_PEER_ADDRESSES);
	});

	it("keeps five manual addresses active without promoting or ranking a crowded cache", () => {
		// Arrange: an explicit zero reservation is not a coordinator refresh.
		const manual = manualArchive.slice(0, 5);
		const cached = ["http://[fe80::1]:7337", ...freshAddresses.slice(0, 7)];

		// Act
		const result = mergeCoordinatorPeerAddresses(cached, cached, manual, {
			requiredFreshAddresses: 0,
		});

		// Assert: cached order survives, including link-local first, without evicting manual addresses.
		expect(result).toEqual([...cached.slice(0, 3), ...manual]);
		expect(result).toHaveLength(MAX_PEER_ADDRESSES);
	});

	it("still reserves six ranked fresh candidates when the coordinator reservation is undefined", () => {
		// Arrange: coordinator refreshes intentionally favor fresh addresses over manual fallbacks.
		const manual = manualArchive.slice(0, 5);
		const cached = ["http://[fe80::1]:7337", ...freshAddresses.slice(0, 7)];

		// Act
		const result = mergeCoordinatorPeerAddresses(cached, cached, manual, {
			requiredFreshAddresses: undefined,
		});

		// Assert: the non-coordinator correction must not weaken coordinator freshness or ranking.
		expect(result).toEqual([...freshAddresses.slice(0, 6), ...manual.slice(0, 2)]);
		expect(result).toHaveLength(MAX_PEER_ADDRESSES);
	});

	it("normalizes and deduplicates candidates and fallbacks before reserving slots", () => {
		const candidates = [
			" ",
			"http://[invalid]:7337",
			"HTTP://FRESH.EXAMPLE:80/",
			"http://fresh.example",
			"http://[FE80::1]:7337/",
			"http://[fe80::1]:7337",
			"http://192.0.2.1:7337/",
		];

		expect(
			mergeCoordinatorPeerAddresses([], candidates, ["http://successful.example:7337/"], {
				successfulAddress,
			}),
		).toEqual([
			"http://fresh.example",
			"http://192.0.2.1:7337",
			"http://[fe80::1]:7337",
			successfulAddress,
		]);
	});

	it("preserves explicit pairing order including link-local addresses", () => {
		const paired = ["http://[fe80::1]:7337", ...freshAddresses.slice(0, 7)];

		expect(
			mergeCoordinatorPeerAddresses(manualArchive, paired, manualArchive, {
				requiredFreshAddresses: MAX_PEER_ADDRESSES,
				successfulAddress,
			}),
		).toEqual(paired);
	});

	it("preserves legacy non-HTTP normalization without throwing during ranking", () => {
		expect(
			mergeCoordinatorPeerAddresses([], ["file://example.com/path", "http://192.0.2.1:7337"]),
		).toEqual(["http://null/path", "http://192.0.2.1:7337"]);
	});

	it("caps explicit pairing reservations at eight addresses", () => {
		expect(
			mergeCoordinatorPeerAddresses(manualArchive, freshAddresses, manualArchive, {
				requiredFreshAddresses: 20,
				successfulAddress,
			}),
		).toEqual(freshAddresses.slice(0, MAX_PEER_ADDRESSES));
	});

	it("honors explicit pairing reservations above six without exceeding the dial limit", () => {
		expect(
			mergeCoordinatorPeerAddresses(manualArchive, freshAddresses, manualArchive, {
				requiredFreshAddresses: 7,
				successfulAddress,
			}),
		).toEqual([...freshAddresses.slice(0, 7), successfulAddress]);
	});
});
