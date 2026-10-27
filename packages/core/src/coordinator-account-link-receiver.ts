import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	type AccountReceiptOutcome,
	createAccountLinkReceipt,
} from "./coordinator-account-link-receipt.js";
import { COORDINATOR_AUTH_STYLE } from "./coordinator-auth-browser-style.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { decodeCoordinatorAuthProof32 } from "./coordinator-auth-proof.js";

export interface CoordinatorAccountLinkReceiver {
	destination: string;
	completion: Promise<string>;
	close(options?: AccountReceiptOutcome): Promise<void>;
}
export interface CoordinatorOwnerEnrollmentCompletion {
	completionSecret: string;
	confirmationHash: string;
}
export interface CoordinatorOwnerEnrollmentReceiver {
	destination: string;
	completion: Promise<CoordinatorOwnerEnrollmentCompletion>;
	close(): Promise<void>;
}
export interface CoordinatorAccountLinkReceiverOptions {
	intent?: "link" | "refresh" | "disconnect";
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

const PATH = "/codemem/auth/complete";
const HEADERS = {
	"Content-Type": "text/html; charset=utf-8",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": `default-src 'none'; style-src 'sha256-${createHash("sha256").update(COORDINATOR_AUTH_STYLE).digest("base64")}'; frame-ancestors 'none'; base-uri 'none'`,
};
function reply(response: ServerResponse, status: number, text: string): void {
	response.writeHead(status, HEADERS);
	response.end(text);
}
function replyWithReceipt(
	response: ServerResponse,
	page: string,
	receipt: ReturnType<typeof createAccountLinkReceipt> | null,
): void {
	if (!receipt) {
		reply(response, 200, page);
		return;
	}
	response.once("finish", receipt.delivered);
	response.writeHead(200, { ...HEADERS, ...receipt.headers });
	response.end(page);
}
function readCompletion(
	request: IncomingMessage,
	host: string,
	attemptId: string,
	mode: "account_link" | "owner_enroll",
): string | CoordinatorOwnerEnrollmentCompletion | null {
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
	return parseCompletionParams(params, attemptId, mode);
}
function parseCompletionParams(
	params: URLSearchParams,
	attemptId: string,
	mode: "account_link" | "owner_enroll",
): string | CoordinatorOwnerEnrollmentCompletion | null {
	if (
		[...params].length !== (mode === "owner_enroll" ? 3 : 2) ||
		params.getAll("attempt_id").length !== 1 ||
		params.getAll("completion").length !== 1 ||
		(mode === "owner_enroll" && params.getAll("confirmation").length !== 1)
	)
		return null;
	if (params.get("attempt_id") !== attemptId) return null;
	const completion = params.get("completion");
	if (!completion || !decodeCoordinatorAuthProof32(completion)) return null;
	if (mode === "account_link") return completion;
	const confirmationHash = params.get("confirmation");
	if (!confirmationHash || !/^[0-9a-f]{64}$/.test(confirmationHash)) return null;
	return { completionSecret: completion, confirmationHash };
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
function receiverLifecycle<T>(server: Server, signal?: AbortSignal) {
	let settled = false;
	let closing: Promise<void> | undefined;
	let accept: (proof: T) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const completion = new Promise<T>((resolve, reject) => {
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
		accept(proof: T, response: ServerResponse): boolean {
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
		(options.intent === undefined || ["link", "refresh", "disconnect"].includes(options.intent)) &&
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
async function createReceiver(
	options: CoordinatorAccountLinkReceiverOptions,
	mode: "account_link" | "owner_enroll",
	ownerPage = "Your computer received the confirmation. Return to the app to finish adding the device.",
): Promise<{
	destination: string;
	completion: Promise<string | CoordinatorOwnerEnrollmentCompletion>;
	close(options?: AccountReceiptOutcome): Promise<void>;
}> {
	if (!validOptions(options)) throw new Error("Invalid account-link receiver options.");
	if (mode === "owner_enroll" && options.coordinatorOrigin !== undefined)
		throw new Error("Invalid owner-enrollment receiver options.");
	const { attemptId, signal, port = 0, host = "127.0.0.1" } = options;
	const receipt = mode === "account_link" ? createAccountLinkReceipt(options.intent) : null;
	const page =
		mode === "owner_enroll" ? ownerPage : (receipt?.page ?? "Return to Codemem and check status.");
	let authority = "";
	let closing: Promise<void> | undefined;
	const server = createServer(
		{ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000 },
		(request, response) => {
			if (receipt?.handle(request, response, authority)) return;
			if (request.method !== "GET") {
				reply(response, 405, "Method not allowed.");
				return;
			}
			const proof = readCompletion(request, authority, attemptId, mode);
			if (!proof) {
				reply(response, 400, "Invalid completion request.");
				return;
			}
			if (!lifecycle.accept(proof, response)) {
				reply(response, 410, "Completion is no longer available.");
				return;
			}
			replyWithReceipt(response, page, receipt);
		},
	);
	server.setTimeout(5000, (socket) => socket.destroy());
	const lifecycle = receiverLifecycle<string | CoordinatorOwnerEnrollmentCompletion>(
		server,
		signal,
	);
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
			close(options?: AccountReceiptOutcome) {
				if (!closing)
					closing = (async () => {
						await receipt?.finish(options);
						await lifecycle.close();
					})();
				return closing;
			},
		};
	} catch {
		lifecycle.detach();
		if (server.listening) await lifecycle.close();
		throw new Error("Could not start the account-link receiver.");
	}
}

export async function createCoordinatorAccountLinkReceiver(
	options: CoordinatorAccountLinkReceiverOptions,
): Promise<CoordinatorAccountLinkReceiver> {
	const receiver = await createReceiver(options, "account_link");
	return { ...receiver, completion: receiver.completion as Promise<string> };
}

/** Owner-only delivery adds the browser-approved commitment; account linking stays two-parameter. */
export async function createCoordinatorOwnerEnrollmentReceiver(
	options: Omit<CoordinatorAccountLinkReceiverOptions, "coordinatorOrigin">,
): Promise<CoordinatorOwnerEnrollmentReceiver> {
	const receiver = await createReceiver(options, "owner_enroll");
	return {
		...receiver,
		completion: receiver.completion as Promise<CoordinatorOwnerEnrollmentCompletion>,
	};
}

/**
 * Device rebind (ADR 0005 Section 8) delivers the same three values as owner
 * enrollment: attempt, completion secret, and the browser's confirmation hash.
 */
export async function createCoordinatorDeviceRebindReceiver(
	options: Omit<CoordinatorAccountLinkReceiverOptions, "coordinatorOrigin" | "intent">,
): Promise<CoordinatorOwnerEnrollmentReceiver> {
	const receiver = await createReceiver(
		options,
		"owner_enroll",
		"Your computer received the confirmation. Return to Codemem to finish signing in.",
	);
	return {
		...receiver,
		completion: receiver.completion as Promise<CoordinatorOwnerEnrollmentCompletion>,
	};
}
