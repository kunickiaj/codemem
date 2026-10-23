import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	dispatchFileContextTransport,
	FILE_CONTEXT_TRANSPORT_PROFILE,
	type FileContextTransportRequest,
	parseFileContextTransportRequest,
} from "./file-context-transport.js";
import { seedProvenMixedScopeFixture } from "./managed-scope-test-fixtures.js";
import { useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import { getRetrievalAttempt, queryRetrievalAttempts } from "./retrieval-ledger.js";

beforeEach(() => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("CODEMEM_")) vi.stubEnv(key, undefined);
	}
	vi.stubEnv("HOME", "/nonexistent/codemem-transport-test-home");
});
const { fixture, enroll, remember } = useLocalCaptureFixture();
const attemptId = "018f2db4-f9d3-7a22-8d18-000000000001";
const fallbackId = "018f2db4-f9d3-7a22-8d18-000000000002";
const requestId = `claude-file-context/http/${attemptId}`;
const lookup = (): FileContextTransportRequest => ({
	action: "lookup",
	attempt_id: attemptId,
	request_id: requestId,
	source_session_id: "synthetic-session",
	ledger_enabled: true,
	db_path: fixture.store.dbPath,
	identity_target: { device_id: "synthetic" },
	relative_path: "src/security.ts",
	project: "test-project",
	file_mtime_ms: 0,
});
function delivery(overrides: Record<string, unknown> = {}): FileContextTransportRequest {
	const {
		relative_path: _path,
		project: _project,
		file_mtime_ms: _mtime,
		...base
	} = lookup() as Extract<FileContextTransportRequest, { action: "lookup" }>;
	return {
		...base,
		action: "delivery",
		delivery_status: "handed_off",
		...overrides,
	} as FileContextTransportRequest;
}
const attempt = () => getRetrievalAttempt(fixture.store.db, attemptId);
const dispatch = (request = lookup()) => dispatchFileContextTransport(fixture.store, request);
function seed() {
	return remember("Visible file decision", { files_modified: ["src/security.ts"] });
}

describe("file-context transport contract", () => {
	it("advertises capability independently of the package version", () => {
		// Arrange / Act
		const profile = FILE_CONTEXT_TRANSPORT_PROFILE;
		// Assert
		expect(profile).toEqual({
			file_context_transport: 1,
			visibility_enforced: true,
			deferred_delivery: true,
		});
		expect(Object.isFrozen(profile)).toBe(true);
	});
	it.each(["lookup", "skip", "delivery"])("accepts the strict %s action", (action) => {
		// Arrange
		let payload: unknown = lookup();
		if (action === "delivery") payload = delivery();
		if (action === "skip") {
			const {
				relative_path: _path,
				project: _project,
				file_mtime_ms: _mtime,
				...base
			} = lookup() as Extract<FileContextTransportRequest, { action: "lookup" }>;
			payload = { ...base, action, reason: "outside_cwd" };
		}
		// Act
		const parsed = parseFileContextTransportRequest(payload);
		// Assert
		expect(parsed.success).toBe(true);
	});
	it.each([
		{ action: "unknown" },
		{ relative_path: "" },
		{ relative_path: "/etc/passwd" },
		{ relative_path: "../secret" },
		{ relative_path: "src/../../secret" },
		{ relative_path: "C:\\secret" },
		{ relative_path: "\\\\server\\share" },
		{ relative_path: "." },
		{ source_session_id: " " },
		{ source_session_id: "/session" },
		{ source_session_id: "C:\\session" },
		{ source_session_id: 7 },
		{ attempt_id: "not-a-uuid" },
		{ request_id: "other-request" },
		{ db_path: " " },
		{ identity_target: null },
		{ identity_target: [] },
		{ ledger_enabled: "true" },
		{ file_mtime_ms: Number.POSITIVE_INFINITY },
		{ context: { authorized: true } },
	])("rejects invalid or client-authority fields %j", (changes) => {
		// Arrange
		const payload = { ...lookup(), ...changes };
		// Act
		const parsed = parseFileContextTransportRequest(payload);
		// Assert
		expect(parsed.success).toBe(false);
		expect(queryRetrievalAttempts(fixture.store.db)).toEqual([]);
	});
	it.each(["relative_path", "source_session_id", "action", "db_path", "identity_target"])(
		"requires %s rather than silently choosing a target",
		(field) => {
			// Arrange
			const payload = { ...lookup() } as Record<string, unknown>;
			delete payload[field];
			// Act
			const parsed = parseFileContextTransportRequest(payload);
			// Assert
			expect(parsed.success).toBe(false);
		},
	);
});

describe("file-context transport selection and delivery", () => {
	it("records source, session, project and selection before an explicit handoff", () => {
		// Arrange
		const id = seed();
		const query = vi.spyOn(fixture.store, "findByFile");
		// Act
		const result = dispatch();
		const selected = attempt();
		const ack = dispatch(delivery());
		// Assert
		expect(result).toMatchObject({
			ok: true,
			delivery_pending: true,
			result: {
				hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
			},
		});
		expect(query).toHaveBeenCalledWith("src/security.ts", { limit: 40, project: "test-project" });
		expect(selected).toMatchObject({
			source: "claude",
			surface: "file_context",
			sourceSessionId: "synthetic-session",
			requestId,
			project: "test-project",
			retrievalStatus: "succeeded",
			deliveryStatus: "not_attempted",
			selectedCount: 1,
		});
		expect(selected?.exposures).toEqual([
			expect.objectContaining({ memoryId: id, handoffStatus: "not_attempted" }),
		]);
		expect(ack).toEqual({ ok: true });
		expect(attempt()?.deliveryStatus).toBe("handed_off");
		expect(attempt()?.exposures[0]?.handoffStatus).toBe("handed_off");
	});
	it("caps selection at 15 after the store's 40-candidate window", () => {
		// Arrange: distinct sessions prevent deduplication from hiding the display cap.
		for (let i = 0; i < 45; i++) {
			const id = remember(`Visible decision ${i}`, { files_modified: ["src/security.ts"] });
			const session = fixture.store.db
				.prepare("INSERT INTO sessions(started_at, project) VALUES ('2026-01-01', 'test-project')")
				.run();
			fixture.store.db
				.prepare("UPDATE memory_items SET session_id = ? WHERE id = ?")
				.run(session.lastInsertRowid, id);
		}
		// Act
		const result = dispatch();
		// Assert
		expect(attempt()).toMatchObject({
			candidateCount: 40,
			selectedCount: 15,
			deliveryStatus: "not_attempted",
		});
		expect(JSON.stringify(result).match(/\(discovery\)/g)).toHaveLength(15);
	});
	it.each(["empty", "project mismatch"])("returns a valid continuation for %s", (reason) => {
		// Arrange
		if (reason === "project mismatch") seed();
		const request = { ...lookup(), project: "other-project" } as FileContextTransportRequest;
		// Act
		const result = dispatch(request);
		// Assert
		expect(result).toMatchObject({ ok: true, delivery_pending: false, result: { continue: true } });
		expect(attempt()).toMatchObject({
			retrievalStatus: "no_results",
			deliveryStatus: "not_attempted",
			selectedCount: 0,
		});
		expect(dispatch(delivery())).toEqual({ ok: false });
	});
	it("records a skip without querying or accepting a delivery", () => {
		// Arrange
		const query = vi.spyOn(fixture.store, "findByFile");
		const {
			relative_path: _path,
			project: _project,
			file_mtime_ms: _mtime,
			...base
		} = lookup() as Extract<FileContextTransportRequest, { action: "lookup" }>;
		// Act
		const result = dispatch({ ...base, action: "skip", reason: "outside_cwd" });
		// Assert
		expect(query).not.toHaveBeenCalled();
		expect(result).toMatchObject({ delivery_pending: false, result: { continue: true } });
		expect(attempt()).toMatchObject({
			retrievalStatus: "skipped",
			failureCode: "outside_cwd",
			failureStage: "path_validation",
		});
		expect(dispatch(delivery())).toEqual({ ok: false });
	});
});

describe("file-context attempt binding and acknowledgement", () => {
	it("keeps HTTP timeout and CLI fallback selections as separate attempts", () => {
		// Arrange
		seed();
		dispatch(); // A timed-out client never acknowledges this HTTP selection.
		const fallback = {
			...lookup(),
			attempt_id: fallbackId,
			request_id: `claude-file-context/cli/${fallbackId}`,
		};
		// Act
		dispatch(fallback);
		dispatch(delivery({ attempt_id: fallbackId, request_id: fallback.request_id }));
		// Assert
		expect(attempt()?.deliveryStatus).toBe("not_attempted");
		expect(getRetrievalAttempt(fixture.store.db, fallbackId)?.deliveryStatus).toBe("handed_off");
		expect(queryRetrievalAttempts(fixture.store.db)).toHaveLength(2);
	});
	it.each(["handed_off", "failed"])(
		"records %s and permits an identical acknowledgement retry",
		(status) => {
			// Arrange
			seed();
			dispatch();
			// Act
			const first = dispatch(delivery({ delivery_status: status }));
			const retry = dispatch(delivery({ delivery_status: status }));
			// Assert
			expect(first).toEqual({ ok: true });
			expect(retry).toEqual({ ok: true });
			expect(attempt()?.deliveryStatus).toBe(status);
			expect(queryRetrievalAttempts(fixture.store.db)).toHaveLength(1);
		},
	);
	it.each(["request", "session", "attempt", "source", "surface"])(
		"rejects acknowledgement with a different %s",
		(field) => {
			// Arrange
			seed();
			dispatch();
			const changes: Record<string, unknown> = {};
			if (field === "request") changes.request_id = `claude-file-context/cli/${fallbackId}`;
			if (field === "session") changes.source_session_id = "other-session";
			if (field === "attempt") changes.attempt_id = fallbackId;
			if (field === "source")
				fixture.store.db
					.prepare("UPDATE retrieval_attempts SET source = 'opencode' WHERE attempt_id = ?")
					.run(attemptId);
			if (field === "surface")
				fixture.store.db
					.prepare("UPDATE retrieval_attempts SET surface = 'memory_pack' WHERE attempt_id = ?")
					.run(attemptId);
			// Act
			const result = dispatch(delivery(changes));
			// Assert
			expect(result).toEqual({ ok: false });
			expect(attempt()?.deliveryStatus).toBe("not_attempted");
		},
	);
	it("does not turn a replay or conflicting selection into a pending delivery", () => {
		// Arrange
		seed();
		dispatch();
		const original = attempt();
		// Act
		const replay = dispatch();
		const conflict = dispatch({ ...lookup(), request_id: `claude-file-context/cli/${fallbackId}` });
		// Assert
		expect(replay).toMatchObject({ delivery_pending: false });
		expect(conflict).toMatchObject({ delivery_pending: false });
		expect(attempt()).toEqual(original);
		expect(dispatch(delivery({ request_id: `claude-file-context/cli/${fallbackId}` }))).toEqual({
			ok: false,
		});
	});
	it("does not downgrade a completed handoff", () => {
		// Arrange
		seed();
		dispatch();
		dispatch(delivery());
		// Act
		const result = dispatch(delivery({ delivery_status: "failed" }));
		// Assert
		expect(result).toEqual({ ok: false });
		expect(attempt()?.deliveryStatus).toBe("handed_off");
	});
});

describe("file-context transport failure isolation", () => {
	it("marks a new selection failed when formatting fails", () => {
		// Arrange
		seed();
		vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(() => {
			throw new Error("synthetic formatter failure");
		});
		// Act
		const result = dispatch();
		// Assert
		expect(result).toMatchObject({ delivery_pending: false, result: { continue: true } });
		expect(attempt()).toMatchObject({
			retrievalStatus: "succeeded",
			selectedCount: 1,
			deliveryStatus: "failed",
		});
	});
	it("does not mark the original selection failed when a replay cannot format", () => {
		// Arrange
		seed();
		dispatch();
		const original = attempt();
		vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(() => {
			throw new Error("synthetic replay formatter failure");
		});
		// Act
		const result = dispatch();
		// Assert
		expect(result).toMatchObject({ delivery_pending: false, result: { continue: true } });
		expect(attempt()).toEqual(original);
	});
	it("rejects a failed ledger delivery write without changing the selection", () => {
		// Arrange
		seed();
		dispatch();
		const original = attempt();
		fixture.store.db.exec(
			"CREATE TRIGGER fail_transport_ack BEFORE UPDATE ON retrieval_attempts BEGIN SELECT RAISE(FAIL, 'synthetic delivery failure'); END",
		);
		// Act
		const result = dispatch(delivery());
		// Assert
		expect(result).toEqual({ ok: false });
		expect(attempt()).toEqual(original);
	});
	it("delivers context without a ledger when capture is disabled", () => {
		// Arrange
		seed();
		// Act
		const result = dispatch({ ...lookup(), ledger_enabled: false });
		// Assert
		expect(JSON.stringify(result)).toContain("Visible file decision");
		expect(result).toMatchObject({ delivery_pending: false });
		expect(queryRetrievalAttempts(fixture.store.db)).toEqual([]);
	});
	it("keeps selection usable when the ledger insert fails", () => {
		// Arrange
		seed();
		fixture.store.db.exec(
			"CREATE TRIGGER fail_transport_ledger BEFORE INSERT ON retrieval_attempts BEGIN SELECT RAISE(FAIL, 'synthetic ledger failure'); END",
		);
		// Act
		const result = dispatch();
		// Assert
		expect(JSON.stringify(result)).toContain("Visible file decision");
		expect(result).toMatchObject({ delivery_pending: false });
		expect(queryRetrievalAttempts(fixture.store.db)).toEqual([]);
	});
	it("records a sanitized query failure without a handoff", () => {
		// Arrange
		vi.spyOn(fixture.store, "findByFile").mockImplementation(() => {
			throw new Error("synthetic private query detail");
		});
		// Act
		const result = dispatch();
		// Assert
		expect(result).toMatchObject({ delivery_pending: false, result: { continue: true } });
		expect(attempt()).toMatchObject({
			retrievalStatus: "failed",
			failureCode: "query_failed",
			deliveryStatus: "not_attempted",
		});
		expect(JSON.stringify(attempt())).not.toContain("synthetic private query detail");
	});
});

describe("file-context transport uses current store authorization", () => {
	it("filters newer hidden replicas before LIMIT and refreshes revocation on the same store", async () => {
		// Arrange: cryptographically proven synthetic grant, not a client visibility hint.
		enroll("transport-device");
		const scopes = await seedProvenMixedScopeFixture(
			fixture.store.db,
			fixture.keysDir,
			fixture.store.deviceId,
		);
		const db = fixture.store.db;
		for (const id of scopes.allIds)
			db.prepare(
				"INSERT INTO memory_file_refs(memory_id, file_path, relation) VALUES (?, 'src/security.ts', 'modified')",
			).run(id);
		db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(scopes.personalId);
		for (let i = 0; i < 45; i++) {
			const row = db
				.prepare(
					"INSERT INTO memory_items(session_id, kind, title, body_text, active, created_at, updated_at, metadata_json, scope_id, visibility) VALUES (?, 'decision', ?, 'hidden body', 1, '2099-01-01', '2099-01-01', '{}', ?, 'shared')",
				)
				.run(scopes.sessionId, `Hidden newer ${i}`, scopes.unauthorizedScopeId);
			db.prepare(
				"INSERT INTO memory_file_refs(memory_id, file_path, relation) VALUES (?, 'src/security.ts', 'modified')",
			).run(row.lastInsertRowid);
		}
		const request = { ...lookup(), project: "mixed-domain-fixture" };
		// Act
		const before = dispatch(request);
		db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?").run(
			scopes.authorizedScopeId,
		);
		const after = dispatch({
			...request,
			attempt_id: fallbackId,
			request_id: `claude-file-context/http/${fallbackId}`,
		});
		// Assert
		expect(JSON.stringify(before)).toContain(scopes.visibleTitles[1]);
		expect(JSON.stringify(before)).not.toContain("Hidden newer");
		expect(attempt()).toMatchObject({ candidateCount: 1, selectedCount: 1 });
		expect(after).toMatchObject({ delivery_pending: false, result: { continue: true } });
		expect(getRetrievalAttempt(db, fallbackId)).toMatchObject({
			retrievalStatus: "no_results",
			selectedCount: 0,
		});
		expect(JSON.stringify(after)).not.toContain(scopes.visibleTitles[1]);
	});
});
