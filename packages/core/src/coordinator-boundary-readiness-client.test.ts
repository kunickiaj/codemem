import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BOUNDARY_READINESS_MAX_BODY_BYTES,
	type BoundaryReadinessProject,
} from "./coordinator-boundary-readiness.js";
import {
	type SubmitBoundaryReadinessInput,
	submitBoundaryReadiness,
} from "./coordinator-boundary-readiness-client.js";
import { buildAuthHeaders } from "./sync-auth.js";

vi.mock("./sync-auth.js", () => ({ buildAuthHeaders: vi.fn() }));

const PROJECT = {
	source_scope_id: "team:exämple:default",
	boundary_scope_id: `managed-project:${"a".repeat(64)}`,
	state: "waiting",
	own_rows_in_source: 4,
	own_rows_in_boundary: 0,
} as const;
const INPUT: SubmitBoundaryReadinessInput = {
	coordinatorUrl: "https://coordinator.example.test/",
	groupId: "g/a & b",
	deviceId: "device-a",
	dbPath: "synthetic.sqlite",
	keysDir: "synthetic-keys",
	sequence: 7,
	omittedProjects: 2,
	projects: [PROJECT],
};
const fetchResponse = vi.fn<typeof fetch>();
const sign = vi.mocked(buildAuthHeaders);
const STORED = { version: 1, status: "stored", sequence: INPUT.sequence, rejected: [] };

beforeEach(() => {
	fetchResponse.mockReset().mockResolvedValue(Response.json(STORED));
	vi.stubGlobal("fetch", fetchResponse);
	sign.mockReset().mockReturnValue({
		"X-Opencode-Device": INPUT.deviceId,
		"X-Opencode-Signature": "fixture-signature",
		"X-Opencode-Timestamp": "2026-11-20T00:00:00Z",
		"X-Opencode-Nonce": "fixture-nonce",
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("readiness request transport", () => {
	it("sends the same bytes and group query that were signed, without admin credentials", async () => {
		const projectWithLocalMetadata = { ...PROJECT, name: "local-only Project name" };
		await expect(
			submitBoundaryReadiness({ ...INPUT, projects: [projectWithLocalMetadata] }),
		).resolves.toEqual({
			kind: "stored",
			sequence: INPUT.sequence,
			rejected: [],
		});

		expect(fetchResponse).toHaveBeenCalledTimes(1);
		const [url, request] = fetchResponse.mock.calls[0] ?? [];
		expect(url).toBe(
			"https://coordinator.example.test/v1/boundary-readiness?group_id=g%2Fa%20%26%20b",
		);
		expect(request).toMatchObject({ method: "POST", redirect: "error" });
		expect(new Headers(request?.headers).has("X-Codemem-Coordinator-Admin")).toBe(false);
		const bytes = Buffer.from(
			JSON.stringify({
				version: 1,
				sequence: 7,
				omitted_projects: 2,
				projects: [PROJECT],
			}),
		);
		expect(request?.body).toEqual(bytes);
		expect(new Headers(request?.headers).get("Content-Length")).toBe(String(bytes.byteLength));
		expect(sign).toHaveBeenCalledWith({
			deviceId: INPUT.deviceId,
			dbPath: INPUT.dbPath,
			keysDir: INPUT.keysDir,
			method: "POST",
			url,
			bodyBytes: bytes,
		});
	});

	it("does not sign an oversized request", async () => {
		const projects = [
			{ ...PROJECT, source_scope_id: "a".repeat(BOUNDARY_READINESS_MAX_BODY_BYTES) },
		];

		await expect(submitBoundaryReadiness({ ...INPUT, projects })).resolves.toEqual({
			kind: "failed",
			reason: "request_too_large",
		});
		expect(sign).not.toHaveBeenCalled();
		expect(fetchResponse).not.toHaveBeenCalled();
	});

	it("does not send a request if the existing key cannot sign", async () => {
		sign.mockImplementationOnce(() => {
			throw new Error("key unavailable");
		});

		await expect(submitBoundaryReadiness(INPUT)).resolves.toEqual({
			kind: "failed",
			reason: "signing_failed",
		});
		expect(fetchResponse).not.toHaveBeenCalled();
	});

	it.each([
		{ groupId: " " },
		{ groupId: " group-a " },
		{ deviceId: "" },
		{ sequence: 0 },
		{ sequence: Number.MAX_SAFE_INTEGER + 1 },
		{ omittedProjects: -1 },
		{ coordinatorUrl: "file:///tmp/coordinator" },
		{ coordinatorUrl: "https://coordinator.example.test/?profile=a" },
		{ coordinatorUrl: "https://coordinator.example.test/?" },
		{ coordinatorUrl: "https://coordinator.example.test/#" },
		{ coordinatorUrl: "https://user:password@coordinator.example.test/" },
	])("rejects invalid input before signing: %j", async (overrides) => {
		await expect(submitBoundaryReadiness({ ...INPUT, ...overrides })).resolves.toEqual({
			kind: "failed",
			reason: "invalid_input",
		});
		expect(sign).not.toHaveBeenCalled();
		expect(fetchResponse).not.toHaveBeenCalled();
	});
});

describe("readiness reply handling", () => {
	it("returns rejected entries as part of a stored reply", async () => {
		const rejected = [
			{
				source_scope_id: PROJECT.source_scope_id,
				boundary_scope_id: PROJECT.boundary_scope_id,
				reason: "source_scope_not_authorized",
			},
		];
		fetchResponse.mockResolvedValueOnce(Response.json({ ...STORED, rejected }));

		await expect(submitBoundaryReadiness(INPUT)).resolves.toEqual({
			kind: "stored",
			sequence: 7,
			rejected,
		});
	});

	it("validates the reply against the record it sent even if the caller updates the input", async () => {
		const project: BoundaryReadinessProject = { ...PROJECT };
		const input = { ...INPUT, projects: [project] };
		const rejected = [
			{
				source_scope_id: project.source_scope_id,
				boundary_scope_id: project.boundary_scope_id,
				reason: "source_scope_not_authorized",
			},
		];
		fetchResponse.mockResolvedValueOnce(Response.json({ ...STORED, rejected }));

		const result = submitBoundaryReadiness(input);
		input.sequence++;
		project.source_scope_id = "other";

		await expect(result).resolves.toEqual({ kind: "stored", sequence: INPUT.sequence, rejected });
	});

	it.each([7, 8])(
		"returns sequence %s as a stale floor and does not resubmit",
		async (sequence) => {
			fetchResponse.mockResolvedValueOnce(Response.json({ version: 1, status: "stale", sequence }));

			await expect(submitBoundaryReadiness(INPUT)).resolves.toEqual({ kind: "stale", sequence });
			expect(fetchResponse).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		{ ...STORED, version: 2 },
		{ ...STORED, sequence: 8 },
		{ ...STORED, sequence: "7" },
		{ ...STORED, status: "stale", sequence: 6 },
		{ ...STORED, rejected: null },
		{ ...STORED, rejected: [null] },
		{ ...STORED, rejected: [{ ...PROJECT, reason: "unknown" }] },
		{
			...STORED,
			rejected: [{ ...PROJECT, source_scope_id: "other", reason: "source_scope_not_authorized" }],
		},
	])("rejects an unusable HTTP 200 reply: %j", async (reply) => {
		fetchResponse.mockResolvedValueOnce(Response.json(reply));

		await expect(submitBoundaryReadiness(INPUT)).resolves.toEqual({
			kind: "failed",
			reason: "invalid_response",
		});
	});

	it.each([
		{ status: 404, result: { kind: "unsupported" } },
		{ status: 503, result: { kind: "unavailable" } },
		{ status: 403, result: { kind: "rejected", status: 403 } },
		{ status: 429, result: { kind: "rejected", status: 429 } },
	])("classifies HTTP $status without retrying", async ({ status, result }) => {
		fetchResponse.mockResolvedValueOnce(new Response(null, { status }));

		await expect(submitBoundaryReadiness(INPUT)).resolves.toEqual(result);
		expect(fetchResponse).toHaveBeenCalledTimes(1);
	});

	it("reports a lost response without retrying a write that may have succeeded", async () => {
		fetchResponse.mockRejectedValueOnce(new Error("connection closed"));

		await expect(submitBoundaryReadiness(INPUT)).resolves.toEqual({
			kind: "failed",
			reason: "transport_failed",
		});
		expect(fetchResponse).toHaveBeenCalledTimes(1);
	});

	it("refuses an oversized success response even when it contains a valid acknowledgement", async () => {
		fetchResponse.mockResolvedValueOnce(
			Response.json({ ...STORED, padding: "a".repeat(2 * BOUNDARY_READINESS_MAX_BODY_BYTES) }),
		);

		await expect(submitBoundaryReadiness(INPUT)).resolves.toEqual({
			kind: "failed",
			reason: "invalid_response",
		});
	});
});
