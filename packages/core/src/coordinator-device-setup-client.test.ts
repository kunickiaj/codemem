import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CoordinatorDeviceSetupOptions,
	completeCoordinatorDeviceSetup,
	readCoordinatorDeviceSetup,
} from "./coordinator-device-setup-client.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const files = vi.hoisted(() => ({ read: vi.fn(), sign: vi.fn() }));
vi.mock("./coordinator-account-link-signer.js", () => ({
	readAccountLinkDevice: files.read,
	signAccountLinkRequest: files.sign,
}));

const options: CoordinatorDeviceSetupOptions = {
	dbPath: "fixture.sqlite",
	keysDir: "fixture-keys",
	coordinatorUrl: "https://coordinator.example.test",
	groupId: "group-a",
	currentIdentityId: "local:device-a",
};
const unavailable = (cause: string) => ({ kind: "unavailable", cause });
const unknown = { kind: "unknown", cause: "completion_outcome_unknown" };
const methods = (transport: ReturnType<typeof vi.fn<typeof fetch>>) =>
	transport.mock.calls.map(([, init]) => init?.method);

beforeEach(() => {
	files.read.mockReset().mockReturnValue({
		deviceId: "device-a",
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
	});
	files.sign.mockReset().mockReturnValue({ "X-Opencode-Signature": "fixture-signature" });
});
afterEach(() => vi.useRealTimers());

describe("device setup status transport", () => {
	it.each(["ready", "complete", "requires_review", "connect_required"])(
		"reads exact %s with one GET",
		async (kind) => {
			// Arrange
			const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ kind }));
			// Act
			const result = await readCoordinatorDeviceSetup({ ...options, fetch: transport });
			// Assert
			expect(result).toEqual({ kind });
			expect(methods(transport)).toEqual(["GET"]);
			expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
		},
	);

	it.each([{ kind: "completed" }, { kind: "complete", extra: true }, ["complete"]])(
		"rejects non-contract GET status %j",
		async (value) => {
			// Arrange
			const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
			// Act
			const result = await readCoordinatorDeviceSetup({ ...options, fetch: transport });
			// Assert
			expect(result).toEqual(unavailable("invalid_response"));
			expect(methods(transport)).toEqual(["GET"]);
		},
	);

	it("preserves the typed schema-upgrade error on a read", async () => {
		// Arrange
		const transport = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(null, {
				status: 503,
				headers: { "X-Codemem-Auth-Error": "coordinator_auth_schema_upgrade_required" },
			}),
		);
		// Act
		const result = await readCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual(unavailable("coordinator_auth_schema_upgrade_required"));
		expect(methods(transport)).toEqual(["GET"]);
	});
});

describe("direct device completion transport", () => {
	it.each(["complete", "requires_review"])(
		"returns %s from exactly one signed POST",
		async (kind) => {
			// Arrange
			const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ kind }));
			// Act
			const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
			// Assert
			expect(result).toEqual({ kind });
			expect(methods(transport)).toEqual(["POST"]);
			expect(files.sign).toHaveBeenCalledWith(
				expect.objectContaining({
					method: "POST",
					dbPath: options.dbPath,
					bodyBytes: Buffer.from(
						JSON.stringify({ group_id: options.groupId, identity_id: options.currentIdentityId }),
					),
				}),
			);
		},
	);

	it.each(["ready", "connect_required", "completed"])(
		"does not accept POST %s as completion",
		async (kind) => {
			// Arrange: an invalid write response needs one safe status read, not another write.
			const transport = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ kind }))
				.mockResolvedValueOnce(Response.json({ kind: "ready" }));
			// Act
			const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
			// Assert
			expect(result).toEqual(unknown);
			expect(methods(transport)).toEqual(["POST", "GET"]);
		},
	);

	it.each(["complete", "ready"])(
		"resolves a lost response only when the one recovery GET says %s",
		async (kind) => {
			// Arrange
			const transport = vi
				.fn<typeof fetch>()
				.mockRejectedValueOnce(new Error("response lost"))
				.mockResolvedValueOnce(Response.json({ kind }));
			// Act
			const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
			// Assert
			expect(result).toEqual(kind === "complete" ? { kind: "complete" } : unknown);
			expect(methods(transport)).toEqual(["POST", "GET"]);
		},
	);

	it("preserves the typed upgrade result when ambiguous POST recovery also reports missing schema", async () => {
		// Arrange: even schema exceptions may follow a committed write.
		const refusal = () =>
			new Response(null, {
				status: 503,
				headers: { "X-Codemem-Auth-Error": "coordinator_auth_schema_upgrade_required" },
			});
		const transport = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(refusal())
			.mockResolvedValueOnce(refusal());
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual(unavailable("coordinator_auth_schema_upgrade_required"));
		expect(methods(transport)).toEqual(["POST", "GET"]);
	});

	it.each([
		{ status: 401, cause: "coordinator_rejected" },
		{ status: 409, cause: "coordinator_rejected" },
		{ status: 429, cause: "rate_limited" },
	])("does not reread or retry a definitive HTTP $status refusal", async ({ status, cause }) => {
		// Arrange
		const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
		// Act
		const result = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
		// Assert
		expect(result).toEqual(unavailable(cause));
		expect(methods(transport)).toEqual(["POST"]);
	});

	it.each([readCoordinatorDeviceSetup, completeCoordinatorDeviceSetup])(
		"treats route/config/backend 404 as unsupported",
		async (call) => {
			// Arrange
			const transport = vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response(null, { status: 404 }));
			// Act
			const result = await call({ ...options, fetch: transport });
			// Assert
			expect(result).toEqual({ kind: "unsupported", cause: "coordinator_upgrade_required" });
			expect(transport).toHaveBeenCalledTimes(1);
		},
	);
});

it("captures validated destination, body, signing paths and transport before an asynchronous write", async () => {
	// Arrange: mutate the caller's object after dispatch, before recovery uses it.
	const shared = { ...options };
	const replacement = vi.fn<typeof fetch>();
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementationOnce(async () => {
			Object.assign(shared, {
				coordinatorUrl: "https://other.example.test",
				groupId: "other-group",
				currentIdentityId: "other-identity",
				dbPath: "other.sqlite",
				keysDir: "other-keys",
				fetch: replacement,
			});
			throw new Error("uncertain write");
		})
		.mockResolvedValueOnce(Response.json({ kind: "complete" }));
	shared.fetch = transport;
	// Act
	const result = await completeCoordinatorDeviceSetup(shared);
	// Assert
	expect(result).toEqual({ kind: "complete" });
	expect(methods(transport)).toEqual(["POST", "GET"]);
	for (const [url] of transport.mock.calls)
		expect(new URL(String(url)).origin).toBe(options.coordinatorUrl);
	expect(new URL(String(transport.mock.calls[1]?.[0])).searchParams.get("identity_id")).toBe(
		options.currentIdentityId,
	);
	expect(
		files.sign.mock.calls.every(
			([input]) => input.dbPath === options.dbPath && input.keysDir === options.keysDir,
		),
	).toBe(true);
	expect(replacement).not.toHaveBeenCalled();
});

it("rejects invalid local inputs before transport", async () => {
	// Arrange
	const transport = vi.fn<typeof fetch>();
	// Act
	const invalid = await completeCoordinatorDeviceSetup({
		...options,
		currentIdentityId: "",
		fetch: transport,
	});
	files.read.mockImplementation(() => {
		throw new Error("missing local key");
	});
	const missing = await completeCoordinatorDeviceSetup({ ...options, fetch: transport });
	// Assert
	expect(invalid).toEqual(unavailable("invalid_input"));
	expect(missing).toEqual(unavailable("device_unavailable"));
	expect(transport).not.toHaveBeenCalled();
});

it("keeps bounded-body and deadline protection at the client boundary", async () => {
	// Arrange: shared helper edge matrices live with the maintained account-status client tests.
	vi.useFakeTimers();
	const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(20_000)));
	const hanging = vi.fn<typeof fetch>(() => new Promise(() => {}));
	// Act
	const body = await readCoordinatorDeviceSetup({ ...options, fetch: oversized });
	const pending = readCoordinatorDeviceSetup({ ...options, fetch: hanging });
	await vi.advanceTimersByTimeAsync(10_001);
	// Assert
	expect(body).toEqual(unavailable("invalid_response"));
	expect(await pending).toEqual(unavailable("coordinator_unreachable"));
});
