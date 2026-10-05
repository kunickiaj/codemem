import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { createCoordinatorAccountLinkReceiver } from "./coordinator-account-link-receiver.js";

const proof = Buffer.alloc(32, 19).toString("base64url");
const query = `?attempt_id=attempt-a&completion=${proof}`;
type Receiver = Awaited<ReturnType<typeof createCoordinatorAccountLinkReceiver>>;

// Raw TCP preserves authorities and request targets that fetch would normalize.
function request(receiver: Receiver, target: string, host?: string, method = "GET") {
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
				`${method} ${target} HTTP/1.1\r\nHost: ${host ?? url.host}\r\nConnection: close\r\n\r\n`,
			),
		);
	});
}

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
