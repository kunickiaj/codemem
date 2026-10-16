import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
	createCoordinatorAccountLinkReceiver,
	createCoordinatorOwnerEnrollmentReceiver,
} from "./coordinator-account-link-receiver.js";

const proof = Buffer.alloc(32, 19).toString("base64url");
const query = `?attempt_id=attempt-a&completion=${proof}`;
type Receiver = Awaited<ReturnType<typeof createCoordinatorAccountLinkReceiver>>;

// Raw TCP preserves authorities and request targets that fetch would normalize.
function request(
	receiver: Pick<Receiver, "destination">,
	target: string,
	host?: string,
	method = "GET",
	headers = "",
) {
	const url = new URL(receiver.destination);
	return new Promise<string>((resolve, reject) => {
		const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) });
		let response = "";
		socket.setTimeout(2000, () => socket.destroy(new Error("local request timed out")));
		socket.on("error", reject);
		socket.on("data", (chunk) => {
			response += chunk.toString();
		});
		socket.on("end", () => resolve(response));
		socket.on("connect", () =>
			socket.write(
				`${method} ${target} HTTP/1.1\r\nHost: ${host ?? url.host}\r\n${headers}Connection: close\r\n\r\n`,
			),
		);
	});
}

function receiptToken(response: string): string {
	const document = new JSDOM(response.split("\r\n\r\n")[1]).window.document;
	const scripts = [...document.querySelectorAll("script")];
	expect(scripts).toHaveLength(1);
	expect(scripts[0].hasAttribute("src")).toBe(false);
	const script = scripts[0].textContent ?? "";
	const hash = createHash("sha256").update(script).digest("base64");
	const csp = /content-security-policy: ([^\r\n]+)/i.exec(response)?.[1] ?? "";
	expect(
		csp
			.split(";")
			.find((part) => part.trim().startsWith("script-src "))
			?.trim(),
	).toBe(`script-src 'sha256-${hash}'`);
	expect(csp).toContain("connect-src 'self'");
	expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
	const token = document.querySelector("main[data-receipt]")?.getAttribute("data-receipt") ?? "";
	expect(token.length).toBeGreaterThanOrEqual(32);
	expect(script).not.toContain(token);
	expect(document.body.textContent).not.toContain(token);
	return token;
}

function receiptHeaders(token: string): string {
	return `X-Codemem-Receipt: ${token}\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: cors\r\n`;
}

describe("account link receiver finishing receipt", () => {
	it.each(["127.0.0.1", "::1"] as const)(
		"returns an isolated finishing receipt without requiring another browser session on %s",
		async (host) => {
			// Arrange
			const receiver = await createCoordinatorAccountLinkReceiver({
				attemptId: "attempt-a",
				host,
				coordinatorOrigin: "https://app.example.test",
			});
			const target = new URL(receiver.destination).pathname + query;
			try {
				// Act: the browser cannot nominate a return destination, even before the valid delivery.
				const rejected = await request(receiver, `${target}&return=https://evil.example.test`);
				const ownerDelivery = await request(receiver, `${target}&confirmation=${"a".repeat(64)}`);
				const response = await request(receiver, target);
				// Assert
				expect(rejected).toMatch(/^HTTP\/1.1 400 /);
				expect(ownerDelivery).toMatch(/^HTTP\/1.1 400 /);
				expect(response).toMatch(/^HTTP\/1.1 200 /);
				expect(response.toLowerCase()).toContain("referrer-policy: no-referrer");
				expect(response.toLowerCase()).toContain("cache-control: no-store");
				expect(response.toLowerCase()).not.toMatch(/location:|access-control-allow-origin:/);
				expect(response).not.toContain(proof);
				expect(response).not.toContain("evil.example.test");
				const document = new JSDOM(response.split("\r\n\r\n")[1]).window.document;
				expect(document.querySelector("h1")?.textContent).toMatch(/finishing|return/i);
				expect(document.body.textContent).toMatch(/Codemem/);
				expect(document.querySelector("main")?.textContent).not.toMatch(
					/finish.*coordinator|successfully linked|linking complete|account linked/i,
				);
				expect(document.querySelector("style")?.textContent?.length).toBeGreaterThan(0);
				expect(document.querySelector("a,meta[http-equiv='refresh'],form")).toBeNull();
				receiptToken(response);
				expect(await receiver.completion).toBe(proof);
			} finally {
				await receiver.close();
			}
		},
	);
	it("rejects unsafe coordinator navigation origins without returning a listener", async () => {
		// Arrange
		const origins = [
			"http://evil.example.test",
			"http://localhost:4567",
			"https://user@app.example.test",
			"https://app.example.test/path",
			"https://app.example.test?x=1",
			"https://app.example.test#fragment",
			"http://127.1:4567",
			"https://app.example.test:443",
		];
		for (const coordinatorOrigin of origins) {
			// Act: close an incorrectly accepted listener so a red test cannot leak its port.
			const result = await createCoordinatorAccountLinkReceiver({
				attemptId: "attempt-a",
				host: "127.0.0.1",
				coordinatorOrigin,
			}).then(
				async (receiver) => {
					await receiver.close();
					return null;
				},
				(error: unknown) => error,
			);
			// Assert
			expect(result).toBeInstanceOf(Error);
			expect(String(result)).not.toContain(coordinatorOrigin);
		}
	});
});

describe("account link receiver trusted receipt acknowledgement", () => {
	it.each(["linked", "pending", "claimed string", "fetch failure"])(
		"receipt closes itself only for trusted linked status: %s",
		async (state) => {
			// Arrange: execute only the fixed receipt script, with all browser I/O mocked.
			const receiver = await createCoordinatorAccountLinkReceiver({ attemptId: "attempt-a" });
			try {
				const receipt = await request(receiver, new URL(receiver.destination).pathname + query);
				const token = receiptToken(receipt);
				const dom = new JSDOM(receipt.split("\r\n\r\n")[1], {
					url: receiver.destination + query,
					runScripts: "outside-only",
				});
				const results: Record<string, unknown> = {
					linked: true,
					pending: false,
					"claimed string": "true",
				};
				const fetch = vi
					.fn()
					.mockResolvedValue({ ok: true, json: async () => ({ linked: results[state] }) });
				if (state === "fetch failure")
					fetch.mockRejectedValue(new Error("local receiver unavailable"));
				Object.defineProperty(dom.window, "fetch", { value: fetch });
				const close = vi.spyOn(dom.window, "close").mockImplementation(() => {});
				vi.spyOn(dom.window, "setTimeout").mockReturnValue(0);
				try {
					// Act
					dom.window.eval(dom.window.document.querySelector("script")?.textContent ?? "");
					for (let turn = 0; turn < 12; turn++) await Promise.resolve();
					// Assert: neither an uncertain result nor a failed request claims success.
					expect(fetch).toHaveBeenCalled();
					const [url, options] = fetch.mock.calls[0];
					expect(new URL(String(url), receiver.destination).href).toBe(
						new URL("/codemem/auth/result", receiver.destination).href,
					);
					expect(new Headers(options?.headers).get("X-Codemem-Receipt")).toBe(token);
					expect(options).toMatchObject({ cache: "no-store", credentials: "omit" });
					expect(dom.window.location.search).toBe("");
					expect(close).toHaveBeenCalledTimes(state === "linked" ? 1 : 0);
					expect(dom.window.document.body.textContent).toMatch(/return to Codemem|check status/i);
				} finally {
					close.mockRestore();
					dom.window.close();
				}
			} finally {
				await receiver.close();
			}
		},
	);
});

describe("account link receiver result endpoint", () => {
	it("reports pending until trusted finalization and flushes the linked acknowledgement before closing", async () => {
		// Arrange
		const receiver = await createCoordinatorAccountLinkReceiver({ attemptId: "attempt-a" });
		try {
			const receipt = await request(receiver, new URL(receiver.destination).pathname + query);
			const token = receiptToken(receipt);
			expect(await receiver.completion).toBe(proof);
			// Act: browser-supplied status cannot mark the local runtime successful.
			const forged = await request(
				receiver,
				"/codemem/auth/result?linked=true",
				undefined,
				"GET",
				receiptHeaders(token),
			);
			const pending = await request(
				receiver,
				"/codemem/auth/result",
				undefined,
				"GET",
				receiptHeaders(token),
			);
			// Assert
			expect(forged).toMatch(/^HTTP\/1.1 4\d\d /);
			expect(pending).toMatch(/^HTTP\/1.1 200 /);
			expect(pending).toContain('"linked":false');
			// Act: only the runtime's trusted close call can acknowledge success.
			const closing = (receiver as { close(options: { linked: boolean }): Promise<void> }).close({
				linked: true,
			});
			const linked = await request(
				receiver,
				"/codemem/auth/result",
				undefined,
				"GET",
				receiptHeaders(token),
			);
			await closing;
			// Assert
			expect(linked).toMatch(/^HTTP\/1.1 200 /);
			expect(linked).toContain('"linked":true');
			expect(linked.toLowerCase()).toContain("cache-control: no-store");
			expect(linked.toLowerCase()).not.toContain("access-control-allow-origin:");
			for (const response of [forged, pending, linked]) {
				expect(response).not.toContain(token);
				expect(response).not.toContain(proof);
			}
			await expect(request(receiver, "/codemem/auth/result")).rejects.toThrow();
		} finally {
			await receiver.close();
		}
	});

	it("denies result reads before proof and rejects wrong tokens, authorities and cross-site requests", async () => {
		// Arrange
		const receiver = await createCoordinatorAccountLinkReceiver({ attemptId: "attempt-a" });
		try {
			const early = await request(
				receiver,
				"/codemem/auth/result",
				undefined,
				"GET",
				receiptHeaders("forged-token"),
			);
			const receipt = await request(receiver, new URL(receiver.destination).pathname + query);
			const token = receiptToken(receipt);
			const validHeaders = receiptHeaders(token);
			const invalid: [string | undefined, string, string][] = [
				[undefined, "GET", receiptHeaders("wrong-token")],
				["localhost:1234", "GET", validHeaders],
				[undefined, "POST", validHeaders],
				[undefined, "OPTIONS", validHeaders],
				[undefined, "GET", validHeaders.replace("same-origin", "cross-site")],
				[undefined, "GET", validHeaders.replace("cors", "navigate")],
				[undefined, "GET", `X-Codemem-Receipt: ${token}\r\n`],
				[undefined, "GET", `${validHeaders}X-Codemem-Receipt: ${token}\r\n`],
			];
			// Act
			const denied = [early];
			for (const [host, method, headers] of invalid)
				denied.push(await request(receiver, "/codemem/auth/result", host, method, headers));
			const pending = await request(
				receiver,
				"/codemem/auth/result",
				undefined,
				"GET",
				validHeaders,
			);
			await receiver.close();
			// Assert: rejected probes neither consume proof nor acknowledge success.
			for (const response of denied) {
				expect(response).toMatch(/^HTTP\/1.1 4\d\d /);
				expect(response).not.toContain('"linked":true');
				expect(response.toLowerCase()).not.toContain("access-control-allow-origin:");
			}
			expect(pending).toContain('"linked":false');
			expect(await receiver.completion).toBe(proof);
			await expect(
				request(receiver, "/codemem/auth/result", undefined, "GET", validHeaders),
			).rejects.toThrow();
		} finally {
			await receiver.close();
		}
	});
});

describe("account link receiver acknowledgement timeout", () => {
	it("releases the listener after exactly 1500ms without a browser acknowledgement", async () => {
		// Arrange: deliver and flush the receipt over real localhost sockets before faking timers.
		const receiver = await createCoordinatorAccountLinkReceiver({ attemptId: "attempt-a" });
		try {
			const receipt = await request(receiver, new URL(receiver.destination).pathname + query);
			expect(receipt).toMatch(/^HTTP\/1.1 200 /);
			expect(await receiver.completion).toBe(proof);
			vi.useFakeTimers();
			let closed = false;
			// Act: the browser never polls the result endpoint.
			const closing = receiver.close({ linked: true }).then(() => {
				closed = true;
			});
			await vi.advanceTimersByTimeAsync(1499);
			// Assert: the acknowledgement window remains available until its deadline.
			expect(closed).toBe(false);
			// Act
			await vi.advanceTimersByTimeAsync(1);
			await closing;
			vi.useRealTimers();
			// Assert: no acknowledgement is required to finish cleanup after the deadline.
			expect(closed).toBe(true);
			await expect(request(receiver, "/codemem/auth/result")).rejects.toThrow();
		} finally {
			if (vi.isFakeTimers()) {
				await vi.runAllTimersAsync();
				vi.useRealTimers();
			}
			await receiver.close();
		}
	});
});

describe("account link receiver literal transport boundary", () => {
	it.each(["127.0.0.1", "::1"] as const)(
		"accepts exact %s once without disclosing completion",
		async (host) => {
			// Arrange
			const receiver = await createCoordinatorAccountLinkReceiver({
				attemptId: "attempt-a",
				host,
				port: 0,
			});
			const target = new URL(receiver.destination).pathname + query;
			const other = randomBytes(32).toString("base64url");
			try {
				// Act
				const raced = await Promise.all([
					request(receiver, target),
					request(receiver, target.replace(proof, other)),
				]);
				const completion = await receiver.completion;
				const second = await request(receiver, target);
				// Assert
				expect(raced.map((response) => response.slice(9, 12)).sort()).toEqual(["200", "410"]);
				expect(completion).toBe(raced[0]?.startsWith("HTTP/1.1 200 ") ? proof : other);
				expect(second).toMatch(/^HTTP\/1.1 410 /);
				for (const response of [...raced, second]) {
					expect(response.toLowerCase()).toContain("cache-control: no-store");
					expect(response.toLowerCase()).toContain("referrer-policy: no-referrer");
					expect(response.toLowerCase()).toContain("content-security-policy:");
					expect(response).not.toContain(proof);
					expect(response).not.toContain(other);
					expect(response).not.toContain("attempt-a");
					expect(response.toLowerCase()).not.toMatch(/location:|access-control-allow-origin:/);
				}
			} finally {
				await receiver.close();
			}
		},
	);
	it.each(["127.0.0.1", "::1"] as const)(
		"rejects hostile raw %s requests without spending the promise",
		async (host) => {
			// Arrange
			const receiver = await createCoordinatorAccountLinkReceiver({
				attemptId: "attempt-a",
				host,
				port: 0,
			});
			const url = new URL(receiver.destination);
			const valid = url.pathname + query;
			const variants: [string, string | undefined, string?][] = [
				[valid, url.hostname], // Missing explicit saved port, even when URL parsers would supply 80.
				[valid, `localhost:${url.port}`],
				[valid, `${url.host}\r\nHost: ${url.host}`],
				[valid, `wrong.test:${url.port}\r\nX-Forwarded-Host: ${url.host}`],
				[valid, `${url.host}\r\nContent-Length: 1`],
				[valid, `${url.host}\r\nTransfer-Encoding: chunked`],
				[valid, undefined, "POST"],
				[valid, undefined, "HEAD"],
				[`${receiver.destination}${query}`, undefined],
				[`/codemem/auth/../auth/complete${query}`, undefined],
				[`/codemem/auth/%63omplete${query}`, undefined],
				[`${valid}&attempt_id=attempt-a`, undefined],
				[`${valid}&extra=1`, undefined],
				[valid.replace("attempt-a", "other-attempt"), undefined],
				[`${valid}=`, undefined],
				[valid.replace(proof, `${proof.slice(0, -1)}1`), undefined],
			];
			try {
				// Act
				const denied = [];
				for (const [target, authority, method] of variants)
					denied.push(await request(receiver, target, authority, method));
				const accepted = await request(receiver, valid);
				// Assert
				for (const response of denied) {
					expect(response).toMatch(/^HTTP\/1.1 4\d\d /);
					expect(response).not.toContain(proof);
				}
				expect(accepted).toMatch(/^HTTP\/1.1 200 /);
				expect(await receiver.completion).toBe(proof);
			} finally {
				await receiver.close();
			}
		},
	);
	it.each(["abort", "close"])(
		"%s rejects pending completion and releases the socket",
		async (mode) => {
			// Arrange
			const controller = new AbortController();
			const receiver = await createCoordinatorAccountLinkReceiver({
				attemptId: "attempt-a",
				host: "127.0.0.1",
				signal: controller.signal,
			});
			const rejection = expect(receiver.completion).rejects.toThrow();
			try {
				// Act
				if (mode === "abort") controller.abort(new Error(proof));
				await receiver.close();
				// Assert
				await rejection;
				await expect(
					request(receiver, new URL(receiver.destination).pathname + query),
				).rejects.toThrow();
			} finally {
				await receiver.close();
			}
		},
	);
	it("busy listen fails with a fixed error rather than a socket address", async () => {
		// Arrange
		const receiver = await createCoordinatorAccountLinkReceiver({
			attemptId: "attempt-a",
			host: "127.0.0.1",
		});
		const completion = receiver.completion.catch(() => undefined);
		try {
			// Act
			const error = await createCoordinatorAccountLinkReceiver({
				attemptId: "other",
				host: "127.0.0.1",
				port: Number(new URL(receiver.destination).port),
			}).catch((cause: unknown) => cause);
			// Assert
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).not.toMatch(/EADDRINUSE|127\.0\.0\.1|listen/);
		} finally {
			await receiver.close();
			await completion;
		}
	});
});

describe("owner-only confirmation delivery", () => {
	it.each(["127.0.0.1", "::1"] as const)(
		"requires exactly one lowercase-hex confirmation on %s without consuming invalid delivery",
		async (host) => {
			// Arrange: an arbitrary valid commitment is delivery data, not local account authority.
			const receiver = await createCoordinatorOwnerEnrollmentReceiver({
				attemptId: "attempt-a",
				host,
			});
			const confirmationHash = "a".repeat(64);
			const base = new URL(receiver.destination).pathname + query;
			const valid = `${base}&confirmation=${confirmationHash}`;
			const invalid = [
				base,
				`${valid}&confirmation=${confirmationHash}`,
				`${valid}&extra=1`,
				...["", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65)].map(
					(value) => `${base}&confirmation=${value}`,
				),
			];
			try {
				// Act
				const denied = [];
				for (const target of invalid) denied.push(await request(receiver, target));
				const accepted = await request(receiver, valid);
				const completion = await receiver.completion;
				const replay = await request(receiver, valid);
				// Assert
				for (const response of denied) expect(response).toMatch(/^HTTP\/1.1 400 /);
				expect(accepted).toMatch(/^HTTP\/1.1 200 /);
				expect(completion).toEqual({ completionSecret: proof, confirmationHash });
				expect(accepted).not.toMatch(/<script\b/i);
				expect(replay).toMatch(/^HTTP\/1.1 410 /);
				for (const response of [...denied, accepted, replay]) {
					expect(response).not.toContain(proof);
					expect(response).not.toContain(confirmationHash);
				}
			} finally {
				await receiver.close();
			}
		},
	);
});
