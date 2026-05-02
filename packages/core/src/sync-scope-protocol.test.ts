import { describe, expect, it } from "vitest";
import {
	addSyncScopeToBoundary,
	parseSyncScopeRequest,
	syncScopeResetRequiredPayload,
} from "./sync-scope-protocol.js";

describe("sync scope protocol compatibility", () => {
	it("treats omitted scope_id as legacy compatibility mode", () => {
		expect(parseSyncScopeRequest(undefined, false)).toEqual({
			ok: true,
			mode: "legacy",
			scope_id: null,
		});
	});

	it("returns missing_scope when scope_id is present but empty", () => {
		expect(parseSyncScopeRequest("  ", true)).toEqual({ ok: false, reason: "missing_scope" });
	});

	it("returns unsupported_scope for explicit scoped requests until per-scope sync lands", () => {
		expect(parseSyncScopeRequest("acme-work", true)).toEqual({
			ok: false,
			reason: "unsupported_scope",
		});
	});

	it("adds legacy scope shape to reset boundaries", () => {
		expect(
			addSyncScopeToBoundary(
				{
					generation: 2,
					snapshot_id: "snapshot-2",
					baseline_cursor: null,
					retained_floor_cursor: "2026-01-01T00:00:00Z|floor",
				},
				null,
			),
		).toEqual({
			generation: 2,
			snapshot_id: "snapshot-2",
			baseline_cursor: null,
			retained_floor_cursor: "2026-01-01T00:00:00Z|floor",
			scope_id: null,
		});
	});

	it("builds reset_required payloads for scope protocol errors", () => {
		expect(
			syncScopeResetRequiredPayload(
				{
					generation: 3,
					snapshot_id: "snapshot-3",
					baseline_cursor: "2026-01-01T00:00:01Z|base",
					retained_floor_cursor: null,
				},
				"unsupported_scope",
				"aware",
			),
		).toEqual({
			error: "reset_required",
			reset_required: true,
			sync_capability: "aware",
			reason: "unsupported_scope",
			generation: 3,
			snapshot_id: "snapshot-3",
			baseline_cursor: "2026-01-01T00:00:01Z|base",
			retained_floor_cursor: null,
			scope_id: null,
		});
	});
});
