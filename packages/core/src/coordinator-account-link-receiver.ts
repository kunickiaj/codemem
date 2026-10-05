import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { decodeCoordinatorAuthProof32 } from "./coordinator-auth-proof.js";

export interface CoordinatorAccountLinkReceiver {
	destination: string;
	completion: Promise<string>;
	close(): Promise<void>;
}
export interface CoordinatorAccountLinkReceiverOptions {
	attemptId: string;
	host?: "127.0.0.1" | "::1";
	port?: number;
	signal?: AbortSignal;
	coordinatorOrigin?: string;
}

export function normalizeCoordinatorAccountLinkOrigin(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		const local =
			url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
		if (
			(!local && url.protocol !== "https:") ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			value.includes("\\") ||
			/[\s\p{Cc}]/u.test(value) ||
			value.includes("?") ||
			value.includes("#") ||
			(value !== url.origin && value !== `${url.origin}/`)
		)
			return null;
		return url.origin;
	} catch {
		return null;
	}
}

function completionPage(options: CoordinatorAccountLinkReceiverOptions): string {
	if (options.coordinatorOrigin === undefined)
		return "Return to the coordinator tab to finish linking.";
	const origin = normalizeCoordinatorAccountLinkOrigin(options.coordinatorOrigin);
	if (!origin) throw new Error("Invalid account-link receiver options.");
	const url = new URL("/auth/link/complete", origin);
	url.searchParams.set("attempt_id", options.attemptId);
	const href = url.href
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	return `<p>Your computer received the confirmation. Finish linking at the coordinator.</p><a href="${href}" referrerpolicy="no-referrer" rel="noreferrer">Finish linking</a>`;
}
const PATH = "/codemem/auth/complete";
const HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
function reply(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, HEADERS);
	response.end(text);
}
function readCompletion(request: IncomingMessage, host: string, attemptId: string): string | null {
	if (!isNavigation(request)) return null;
	const raw = request.url ?? "";
	const hosts = request.rawHeaders.filter(
		(value, index) => index % 2 === 0 && value.toLowerCase() === "host",
	);
	if (hosts.length !== 1 || request.headers.host !== host) return null;
	if (Buffer.byteLength(raw) > 1024 || !raw.startsWith(`${PATH}?`) || raw.includes("#"))
		return null;
	if (request.headers["transfer-encoding"] !== undefined) return null;
	if (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")
		return null;
	const params = new URLSearchParams(raw.slice(PATH.length + 1));
	if (
		[...params].length !== 2 ||
		params.getAll("attempt_id").length !== 1 ||
		params.getAll("completion").length !== 1
	)
		return null;
	if (params.get("attempt_id") !== attemptId) return null;
	const completion = params.get("completion");
	return decodeCoordinatorAuthProof32(completion) ? completion : null;
}
function isNavigation(request: IncomingMessage): boolean {
	const headers = request.headers;
	if (
		headers.origin !== undefined ||
		headers.purpose !== undefined ||
		headers["sec-purpose"] !== undefined
	)
		return false;
	if (headers["sec-fetch-mode"] !== undefined && headers["sec-fetch-mode"] !== "navigate")
		return false;
	return headers["sec-fetch-dest"] === undefined || headers["sec-fetch-dest"] === "document";
}
function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) reject(new Error("Account-link receiver could not close."));
			else resolve();
		});
		server.closeIdleConnections();
		// Incomplete clients must not hold cleanup; accepted browser replies are flushed first.
		server.closeAllConnections();
	});
}
function listen(server: Server, host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const failed = () => reject(new Error("Could not start the account-link receiver."));
		server.once("error", failed);
		server.listen({ host, port, exclusive: true }, () => {
			server.removeListener("error", failed);
			resolve();
		});
	});
}
function receiverLifecycle(server: Server, signal?: AbortSignal) {
	let settled = false;
	let closing: Promise<void> | undefined;
	let accept: (proof: string) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const completion = new Promise<string>((resolve, reject) => {
		accept = resolve;
		fail = reject;
	});
	// Closing before delivery is normal. Awaiting consumers still receive the rejection.
	void completion.catch(() => {});
	const abort = () => {
		if (!settled) {
			settled = true;
			fail(new Error("Account-link receiver stopped."));
		}
	};
	signal?.addEventListener("abort", abort, { once: true });
	server.on("error", abort);
	const detach = () => signal?.removeEventListener("abort", abort);
	return {
		completion,
		detach,
		accept(proof: string, response: ServerResponse): boolean {
			if (settled || signal?.aborted) return false;
			settled = true;
			response.once("finish", () => accept(proof));
			response.once("close", () => {
				if (!response.writableFinished) fail(new Error("Account-link receiver stopped."));
			});
			return true;
		},
		close(): Promise<void> {
			if (closing) return closing;
			detach();
			abort();
			closing = closeServer(server);
			return closing;
		},
	};
}
function validOptions(options: CoordinatorAccountLinkReceiverOptions): boolean {
	const { attemptId, signal, port = 0, host = "127.0.0.1" } = options;
	return (
		isAuthControllerId(attemptId) &&
		(host === "127.0.0.1" || host === "::1") &&
		Number.isInteger(port) &&
		port >= 0 &&
		port <= 65535 &&
		(options.coordinatorOrigin === undefined ||
			normalizeCoordinatorAccountLinkOrigin(options.coordinatorOrigin) !== null) &&
		!signal?.aborted
	);
}
/** Bind before creating an attempt. Only this held literal-loopback listener owns delivery. */
export async function createCoordinatorAccountLinkReceiver(
	options: CoordinatorAccountLinkReceiverOptions,
): Promise<CoordinatorAccountLinkReceiver> {
	if (!validOptions(options)) throw new Error("Invalid account-link receiver options.");
	const { attemptId, signal, port = 0, host = "127.0.0.1" } = options;
	const page = completionPage(options);
	let authority = "";
	const server = createServer(
		{ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000 },
		(request, response) => {
			if (request.method !== "GET") {
				reply(response, 405, "Method not allowed.");
				return;
			}
			const proof = readCompletion(request, authority, attemptId);
			if (!proof) {
				reply(response, 400, "Invalid completion request.");
				return;
			}
			if (!lifecycle.accept(proof, response)) {
				reply(response, 410, "Completion is no longer available.");
				return;
			}
			reply(response, 200, page);
		},
	);
	server.setTimeout(5000, (socket) => socket.destroy());
	const lifecycle = receiverLifecycle(server, signal);
	try {
		await listen(server, host, port);
		const address = server.address();
		if (!address || typeof address === "string" || signal?.aborted)
			throw new Error("Account-link receiver stopped.");
		const literal = host === "::1" ? "[::1]" : host;
		authority = `${literal}:${address.port}`;
		return {
			destination: `http://${authority}${PATH}`,
			completion: lifecycle.completion,
			close: lifecycle.close,
		};
	} catch {
		lifecycle.detach();
		if (server.listening) await lifecycle.close();
		throw new Error("Could not start the account-link receiver.");
	}
}
