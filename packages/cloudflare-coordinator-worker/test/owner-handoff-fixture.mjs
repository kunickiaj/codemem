// Test-only Node adapter. Never imported by the Worker or ordinary CLI.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";

const privacy = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const limit = 16384;

export function ownerHttpRequest(url, { method = "GET", headers = {}, body = "" } = {}) {
	const target = new URL(url);
	assert.ok(target.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(target.hostname));
	assert.ok(!target.username && !target.password);
	return new Promise((resolve, reject) => {
		const request = httpRequest(target, { method, headers }, (response) => {
			const chunks = [];
			let bytes = 0;
			response.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > limit) response.destroy(new Error("Fixture response too large"));
				else chunks.push(chunk);
			});
			response.on("error", reject);
			response.on("end", () =>
				resolve({
					status: response.statusCode,
					headers: response.headers,
					body: Buffer.concat(chunks).toString(),
				}),
			);
		});
		request.on("error", reject);
		request.setTimeout(5000, () => request.destroy(new Error("Fixture request timed out")));
		request.end(body);
	});
}

async function bodyBytes(request) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > limit) throw new Error("Fixture body too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function reply(response, status, result, headers = {}) {
	response.writeHead(status, { ...privacy, "content-type": "application/json", ...headers });
	response.end(result === undefined ? "" : JSON.stringify(result));
}

export async function ownerHttpDispatcher({ getApi, origin, loseFinalReply = () => false }) {
	async function dispatch(incoming, response) {
		// Same explicit HTTPS URL rewrite as the existing native browser fixture.
		// Preserve Origin, Cookie, content type and actual wire bytes; do not repair forms.
		if (!incoming.url?.startsWith("/") || incoming.url.length > 8192) return reply(response, 400);
		const url = new URL(incoming.url, origin);
		if (url.origin !== origin) return reply(response, 400);
		const bytes = await bodyBytes(incoming);
		const request = new Request(url, {
			method: incoming.method,
			headers: incoming.headers,
			body: ["GET", "HEAD"].includes(incoming.method) ? undefined : bytes,
		});
		const api = getApi();
		// Socket identity is owned by this test server; never use forwarding headers.
		const result = await api.handle(request, incoming.socket.remoteAddress);
		if (incoming.method === "POST" && url.pathname.endsWith("/finalize") && loseFinalReply())
			return response.destroy();
		const headers = Object.fromEntries(result.headers);
		const cookies = result.headers.getSetCookie();
		if (cookies.length) headers["set-cookie"] = cookies;
		response.writeHead(result.status, headers);
		response.end(Buffer.from(await result.arrayBuffer()));
	}
	const server = createServer((request, response) => {
		dispatch(request, response).catch(() => reply(response, 400));
	});
	server.requestTimeout = 5000;
	server.headersTimeout = 5000;
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		base: `http://127.0.0.1:${server.address().port}`,
		close: () => {
			server.closeAllConnections();
			return new Promise((resolve) => server.close(resolve));
		},
	};
}

export function ownerFormFields(html) {
	return Object.fromEntries([...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]));
}

// The browser uses the rendered random CSRF and cookie, not a known test secret.
export async function ownerBrowserStart(send, start, origin) {
	const page = await send(`/auth/owner/start?attempt_id=${start.attemptId}&start_code=${start.browserStartCode}`);
	assert.equal(page.status, 200);
	return send("/auth/owner/start", {
		method: "POST",
		headers: { origin, cookie: page.headers["set-cookie"][0].split(";")[0], "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(ownerFormFields(page.body)).toString(),
	});
}

// Disposable B signs only its own start pins and the owner-only receiver's delivery.
export async function ownerHandoffClient({
	helpers: h,
	pin,
	key,
	deviceId,
	attemptId,
	host,
	signal,
}) {
	const receiver = await h.createCoordinatorOwnerEnrollmentReceiver({ attemptId, host, signal });
	const start = {
		attemptId,
		deviceId,
		publicKey: key.publicKey,
		loopbackRedirect: receiver.destination,
		browserStartCode: h.proof(),
		signature: "",
	};
	start.signature = key.sign(h.ownerEnrollmentStartMessage(start, pin));
	let retained;
	let exactBody;
	const post = (base, path, body) =>
		ownerHttpRequest(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
	return {
		receiver,
		start,
		startRequest: (base, input = start) =>
			post(base, "/v1/auth/owner-attempts", JSON.stringify(input)),
		async consumeCompletion() {
			if (retained) return retained;
			const { completionSecret, confirmationHash } = await receiver.completion;
			const keyId = await h.ed25519KeyId(key.publicKey);
			assert.ok(keyId);
			const fingerprint = await h.ownerEnrollmentHash(key.publicKey);
			const pins = {
				coordinator_id: pin.coordinatorId,
				origin: pin.origin,
				auth_config_revision: pin.revision,
				attempt_id: attemptId,
				device_id: deviceId,
				public_key: key.publicKey,
				key_id: keyId,
				fingerprint,
				issuer: pin.issuer,
				confirmation_hash: confirmationHash,
			};
			retained = Object.freeze({
				attemptId,
				completionSecret,
				signature: key.sign(h.ownerEnrollmentFinalMessage(pins, completionSecret)),
			});
			exactBody = JSON.stringify(retained);
			return retained;
		},
		finalize(base, input) {
			assert.ok(exactBody, "Consume completion before finalizing");
			return post(
				base,
				"/v1/auth/owner-attempts/finalize",
				input ? JSON.stringify(input) : exactBody,
			);
		},
	};
}
