import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HEADLESS_CODE_LIMITS_TABLE,
	HEADLESS_LINK_PROVENANCE_TABLE,
} from "./coordinator-auth-headless-schema.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import {
	ownerStartFixture,
	seedOwnerCallbackAuthority,
} from "./coordinator-owner-enrollment-historical-test-fixture.js";
import { createCoordinatorOwnerEnrollmentHttp } from "./coordinator-owner-enrollment-http.js";
import { ownerEnrollmentFinalMessage } from "./coordinator-owner-enrollment-proof.js";
import {
	ATTEMPTS,
	config,
	hash,
	ORIGIN,
	proof,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { ownerEnrollmentStartMessage } from "./owner-enrollment-start.js";

const BLOCKED =
	"This account was linked from a device without a browser. Link it once from a computer with a browser before adding devices to it.";
let f: ReturnType<typeof ownerStartFixture>;
beforeEach(() => {
	f = ownerStartFixture();
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		f.close();
		vi.restoreAllMocks();
	}
});

/** Marks the account's active link as written by headless finalize. */
function markHeadless(linkId = activeLinkId()) {
	f.db
		.prepare(
			`INSERT INTO ${HEADLESS_LINK_PROVENANCE_TABLE} (coordinator_id, link_id, identity_id, issuer, subject,
			 attempt_id, created_at_ms) VALUES (?, ?, 'identity-a', ?, 'fixture-subject', ?, 1)`,
		)
		.run(config.coordinatorId, linkId, config.issuer, `headless-${linkId}`);
}
function activeLinkId() {
	return (
		f.db.prepare("SELECT link_id FROM coordinator_auth_account_links").get() as { link_id: string }
	).link_id;
}
const bindings = () => f.rows("coordinator_device_ownership_bindings");
function fields(html: string) {
	return Object.fromEntries(
		[...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
	);
}

/** A fresh device B starts owner enrollment over HTTP and returns from Google. */
async function throughCallback(beforeCallback?: () => void) {
	const provider = oidcFixture({ issuer: config.issuer });
	const http = await createCoordinatorOwnerEnrollmentHttp({
		config: { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret },
		backend: f.backend,
		oidcOptions: { fetch: provider.fetch },
		clock: () => NOW,
	});
	const send = (path: string, init: RequestInit = {}) =>
		http.handle(new Request(`${ORIGIN}${path}`, init), "socket-a");
	const post = (path: string, body: unknown) =>
		send(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const start = {
		attemptId: "attempt-a",
		deviceId: "device-b",
		publicKey: f.key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	start.signature = f.key.sign(ownerEnrollmentStartMessage(start, http.pin));
	expect((await post("/v1/auth/owner-attempts", start)).status).toBe(200);
	const page = await send(
		`/auth/owner/start?attempt_id=${start.attemptId}&start_code=${start.browserStartCode}`,
	);
	const claim = await send("/auth/owner/start", {
		method: "POST",
		headers: {
			cookie: page.headers.getSetCookie()[0]?.split(";")[0] ?? "",
			origin: ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields(await page.text())),
	});
	const transaction = claim.headers.getSetCookie()[0]?.split(";")[0] ?? "";
	seedOwnerCallbackAuthority(f);
	beforeCallback?.();
	const callback = await http.handle(
		new Request(provider.authorize(claim.headers.get("location") ?? ""), {
			headers: { cookie: transaction },
		}),
		"socket-a",
	);
	return { callback, transaction, send, post, start };
}

/** Confirms in the browser, then signs finalize as device B. */
async function finalizeAfter(beforeFinalize?: () => void) {
	const c = await throughCallback();
	const confirmed = await c.send("/auth/owner/confirm", {
		method: "POST",
		headers: {
			cookie: c.transaction,
			origin: ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields(await c.callback.text())),
	});
	const destination = new URL(confirmed.headers.get("location") ?? "");
	const completionSecret = destination.searchParams.get("completion") ?? "";
	const signed = {
		coordinator_id: config.coordinatorId,
		origin: ORIGIN,
		auth_config_revision: config.revision,
		attempt_id: c.start.attemptId,
		device_id: c.start.deviceId,
		public_key: c.start.publicKey,
		key_id: await ed25519KeyId(c.start.publicKey),
		fingerprint: hash(c.start.publicKey),
		issuer: config.issuer,
		confirmation_hash: destination.searchParams.get("confirmation"),
	};
	beforeFinalize?.();
	return c.post("/v1/auth/owner-attempts/finalize", {
		attemptId: c.start.attemptId,
		completionSecret,
		signature: f.key.sign(ownerEnrollmentFinalMessage(signed, completionSecret)),
	});
}

describe("owner enrollment into a headless-linked controller account", () => {
	it("explains the refusal at the Google callback and writes no confirmation", async () => {
		// Act
		const { callback } = await throughCallback(() => markHeadless());
		// Assert
		expect(callback.status).toBe(403);
		expect(await callback.text()).toContain(BLOCKED);
		expect(f.rows(ATTEMPTS)[0]).toMatchObject({ state: "browser_claimed", link_id: null });
	});

	it("refuses inside the commit when the link became headless after confirmation", async () => {
		// Act
		const response = await finalizeAfter(() => markHeadless());
		// Assert: the device sees the same unavailable reply it always has.
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("Owner enrollment unavailable.");
		expect(bindings()).toEqual([]);
		expect(f.rows(ATTEMPTS)[0]).toMatchObject({ state: "confirmed" });
	});

	it("enrolls normally when only another link is headless", async () => {
		// Act
		const response = await finalizeAfter(() => markHeadless("link-other"));
		// Assert
		expect(await response.json()).toMatchObject({ kind: "finalized", identityId: "identity-a" });
		expect(bindings()).toHaveLength(1);
	});

	it("enrolls as before on a coordinator without the headless tables", async () => {
		// Arrange
		f.db.exec(
			`DROP TABLE ${HEADLESS_CODE_LIMITS_TABLE}; DROP TABLE ${HEADLESS_LINK_PROVENANCE_TABLE};`,
		);
		// Act
		const response = await finalizeAfter();
		// Assert
		expect(await response.json()).toMatchObject({ kind: "finalized" });
		expect(bindings()).toHaveLength(1);
	});
});
