import { describe, expect, it, vi } from "vitest";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";

const path = "/codemem/auth/complete";
const invalid = { ok: false, error: "invalid_loopback_destination" };

describe("parseCoordinatorAuthLoopback", () => {
	// Only these exact loopback authorities can receive the auth completion redirect.
	it.each([
		["127.0.0.1", 1],
		["127.0.0.1", 80],
		["127.0.0.1", 65535],
		["[::1]", 1],
		["[::1]", 80],
		["[::1]", 65535],
	] as const)("preserves canonical %s port %i without URL normalization", (host, port) => {
		// Arrange
		const destination = `http://${host}:${port}${path}`;

		// Act
		const result = parseCoordinatorAuthLoopback(destination);

		// Assert
		expect(result).toEqual({ ok: true, destination, host, port });
	});

	// Ports must be explicit canonical decimal in the transport's valid range.
	it.each(["0", "65536", "", "01", "00080", "-1", "+1", "1e2", "0x50", "8.0", " 80", "80 "])(
		"rejects noncanonical or out-of-range port %j",
		(port) => {
			// Arrange
			const destination = `http://127.0.0.1:${port}${path}`;

			// Act
			const result = parseCoordinatorAuthLoopback(destination);

			// Assert
			expect(result).toEqual(invalid);
		},
	);

	// URL parsers normalize host aliases; auth redirects must not accept them.
	it.each([
		"localhost",
		"127.1",
		"2130706433",
		"0177.0.0.1",
		"127.0.0.2",
		"[::ffff:127.0.0.1]",
		"[0:0:0:0:0:0:0:1]",
		"[::2]",
		"LOCALHOST",
		"127%2e0.0.1",
	])("rejects host alias %s", (host) => {
		// Arrange
		const destination = `http://${host}:80${path}`;

		// Act
		const result = parseCoordinatorAuthLoopback(destination);

		// Assert
		expect(result).toEqual(invalid);
	});

	// The callback is an exact string, not a URL that may be repaired or decoded.
	it.each([
		"https://127.0.0.1:80/codemem/auth/complete",
		"file://127.0.0.1:80/codemem/auth/complete",
		"//127.0.0.1:80/codemem/auth/complete",
		"http://127.0.0.1/codemem/auth/complete",
		"http://[::1]/codemem/auth/complete",
		"HTTP://127.0.0.1:80/codemem/auth/complete",
		"http://user@127.0.0.1:80/codemem/auth/complete",
		"http://user:pass@127.0.0.1:80/codemem/auth/complete",
		"http://127.0.0.1:80/codemem/auth/complete?code=secret",
		"http://127.0.0.1:80/codemem/auth/complete#fragment",
		"http://127.0.0.1:80/codemem/auth/%63omplete",
		"http://127.0.0.1:80/codemem/%61uth/complete",
		"http://127.0.0.1:80/codemem/auth/../auth/complete",
		"http://127.0.0.1:80//codemem/auth/complete",
		"http://127.0.0.1:80/codemem//auth/complete",
		"http://127.0.0.1:80/codemem/auth/complete/",
		"http://127.0.0.1:80/codemem/auth/complete//foo",
		"http://127.0.0.1:80/codemem/auth/complete\n",
		"http://127.0.0.1:80/codemem/auth/complete\r",
		"http://127.0.0.1:80/codemem/auth/complete\t",
		"http://127.0.0.1:80/codemem/auth/complete\u200b",
		"http://127.0.0.1:80/codemem/auth/complete\u0000",
		"http://127.0.0.1:80/codemem/auth/complete\u202e",
		" http://127.0.0.1:80/codemem/auth/complete",
		"http://127.0.0.1:80/codemem/auth/complete ",
	])("rejects altered URL %j", (destination) => {
		// Arrange
		const input = destination;

		// Act
		const result = parseCoordinatorAuthLoopback(input);

		// Assert
		expect(result).toEqual(invalid);
	});

	// Unknown values must be rejected without coercion or invoking caller code.
	it("rejects nonstrings without calling custom toString", () => {
		// Arrange
		const stringify = vi.fn(() => `http://127.0.0.1:80${path}`);
		const inputs: unknown[] = [
			null,
			undefined,
			80,
			false,
			Symbol("loopback"),
			{},
			[],
			new URL(`http://127.0.0.1:80${path}`),
			{ toString: stringify },
		];

		// Act
		const results = inputs.map((input) => parseCoordinatorAuthLoopback(input));

		// Assert
		expect(results).toEqual(inputs.map(() => invalid));
		expect(stringify).not.toHaveBeenCalled();
	});
});
