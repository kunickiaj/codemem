import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	RelayFaultAction,
	RelayFaultFrame,
	RelayFaultRule,
} from "../../core/src/relay-fault-proxy-test-fixtures.js";
import { relayDeadline } from "../../core/src/relay-peer-client-test-fixtures.js";
import { syncScopedChannelOnce } from "../../core/src/sync-channel-pass.js";
import { getSyncChannelProgress } from "../../core/src/sync-channel-progress.js";
import { getReplicationCursor, setReplicationCursor } from "../../core/src/sync-replication.js";
import {
	type RelaySyncFixture,
	relaySyncFixture,
	runRelaySyncCleanups,
	seedOtherSpace,
} from "./relay-sync-test-fixtures.js";
import { SCOPE } from "./sync-channel-dispatch-test-fixtures.js";

/**
 * Relay fault recovery and sync-state isolation (relay protocol contract). Each case
 * injects one fault through the keyless proxy, checks that the failed pass changed no
 * sync state it must not, then runs a clean pass and checks full convergence.
 */

afterEach(async () => {
	await runRelaySyncCleanups();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// The target registers first, so it owns proxy socket 0 and the source owns socket 1.
const TARGET_SOCKET = 0;
const SOURCE_SOCKET = 1;
const LOCAL_SCOPE = "local-default";

/**
 * Applies `action` once, to DATA frame `nth` toward the source within route `route`
 * (0 status, 1 pull or snapshot, 2 push). Frame 0 of a route is the responder's
 * Noise handshake; later frames are encrypted records.
 */
type CountedRule = RelayFaultRule & { fired: () => boolean };

function counted(match: (frame: RelayFaultFrame) => RelayFaultAction | undefined): CountedRule {
	let fired = false;
	const rule = (frame: RelayFaultFrame) => {
		if (fired) return;
		const action = match(frame);
		if (action) fired = true;
		return action;
	};
	return Object.assign(rule, { fired: () => fired });
}

function onRouteData(route: number, nth: number, action: RelayFaultAction): CountedRule {
	const sessions: string[] = [];
	const seen = new Map<string, number>();
	return counted((frame) => {
		if (frame.socket !== SOURCE_SOCKET || frame.direction !== "toPeer") return;
		if (frame.kind !== "data") return;
		if (!sessions.includes(frame.session)) sessions.push(frame.session);
		if (sessions.indexOf(frame.session) !== route) return;
		const index = seen.get(frame.session) ?? 0;
		seen.set(frame.session, index + 1);
		return index === nth ? action : undefined;
	});
}

/** The relay's first OPEN toward the target is lost. */
const dropFirstOpenToTarget = () =>
	counted((frame) => {
		if (frame.socket !== TARGET_SOCKET || frame.direction !== "toPeer") return;
		if (frame.kind !== "control" || frame.type !== "OPEN") return;
		return { type: "drop" };
	});

const flipLastByte: RelayFaultAction = {
	type: "substitute",
	bytes: (original) => {
		const copy = Buffer.from(original);
		copy[copy.length - 1] = (copy.at(-1) ?? 0) ^ 0xff;
		return copy;
	},
};

/** A fault rule the test can switch off before the clean retry. */
function switchable(rule: () => CountedRule) {
	const state = { armed: true, rule: rule() };
	const wrapped: RelayFaultRule = (frame) => (state.armed ? state.rule(frame) : undefined);
	return { state, wrapped };
}

function rows(f: RelaySyncFixture, side: "client" | "remote") {
	const db = side === "client" ? f.client.db : f.remote.store.db;
	return db.prepare("SELECT scope_id, title FROM memory_items ORDER BY scope_id, title").all() as {
		scope_id: string;
		title: string;
	}[];
}

const ack = (f: RelaySyncFixture) =>
	getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)?.last_acked_cursor ?? null;
const cursor = (f: RelaySyncFixture) =>
	getReplicationCursor(f.client.db, f.remote.localDeviceId, SCOPE);

/** A client memory and its outbound op in the local-only scope, which must never leave the device. */
function seedLocalOnly(f: RelaySyncFixture, authored: { op_id: string }) {
	const db = f.client.db;
	db.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, created_at, updated_at, visibility, origin_device_id, rev, import_key, scope_id, metadata_json)
		SELECT session_id, kind, 'local-only-item', body_text, created_at, updated_at, visibility, origin_device_id, rev, import_key || '-local', ?, metadata_json
		FROM memory_items WHERE title = 'client-item'`).run(LOCAL_SCOPE);
	db.prepare(`INSERT INTO replication_ops
		(op_id, entity_type, entity_id, op_type, payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at, scope_id)
		SELECT 'local-only-op', entity_type, entity_id || '-local', op_type, payload_json, clock_rev, clock_updated_at, clock_device_id, device_id, created_at, ?
		FROM replication_ops WHERE op_id = ?`).run(LOCAL_SCOPE, authored.op_id);
}

interface FaultCase {
	readonly name: string;
	readonly rule: () => CountedRule;
	/** Stable local reason, or null when the fault is tolerated and the pass succeeds. */
	readonly reason: string | null;
	/** Bootstrap instead of an incremental pull. */
	readonly snapshot?: boolean;
	readonly deadlineMs?: number;
}

const cases: FaultCase[] = [
	{
		name: "a substituted responder handshake",
		rule: () => onRouteData(0, 0, flipLastByte),
		reason: "relay_handshake_failed",
	},
	{
		name: "a replayed status record",
		rule: () => onRouteData(0, 1, { type: "duplicate" }),
		reason: "relay_record_invalid",
	},
	{
		name: "a substituted pull record",
		rule: () => onRouteData(1, 1, flipLastByte),
		reason: "relay_record_invalid",
	},
	{
		name: "a truncated push response",
		rule: () => onRouteData(2, 1, { type: "truncate", keep: 40 }),
		reason: "relay_frame_invalid",
	},
	{
		name: "two pull records delivered out of order",
		rule: () => onRouteData(1, 1, { type: "reorder" }),
		reason: "relay_record_invalid",
	},
	{
		name: "an OPEN lost on the way to the target",
		rule: dropFirstOpenToTarget,
		reason: "relay_expired",
		deadlineMs: 4000,
	},
	{
		name: "a pull record delayed past the next one",
		rule: () => onRouteData(1, 1, { type: "delay", ms: 300 }),
		reason: "relay_record_invalid",
	},
	{
		// Nothing follows the handshake until the source answers it, so it cannot be overtaken.
		name: "a delayed pull handshake",
		rule: () => onRouteData(1, 0, { type: "delay", ms: 300 }),
		reason: null,
	},
	{
		name: "a truncated snapshot page",
		rule: () => onRouteData(1, 1, { type: "truncate", keep: 40 }),
		reason: "relay_frame_invalid",
		snapshot: true,
	},
];

async function arrange(fault: FaultCase) {
	const fault$ = switchable(fault.rule);
	// A fault pass and its retry make about 18 admission checks, past the default burst of 16.
	const f = await relaySyncFixture({
		faultProxy: { rule: fault$.wrapped },
		admissionRatePerMinute: 96,
	});
	if (!fault.snapshot)
		setReplicationCursor(
			f.client.db,
			f.remote.localDeviceId,
			{ lastApplied: "2025-01-01T00:00:00Z|initial" },
			SCOPE,
		);
	f.seed("remote", "remote-item");
	const authored = f.seed("client", "client-item");
	seedOtherSpace(f, authored);
	seedLocalOnly(f, authored);
	await f.target.connect(new AbortController().signal, relayDeadline());
	return { f, fault$ };
}

/** One pass with a new connection factory, as the daemon builds per pass, so each reason is its own. */
const pass = (f: RelaySyncFixture, deadlineMs?: number) =>
	syncScopedChannelOnce({
		...f.options,
		factory: f.source.factory(f.remote.localDeviceId, f.remote.localPublicKey),
		...(deadlineMs ? { deadlineMs: performance.now() + deadlineMs } : {}),
	});

/** Nothing outside the authorized Space ever reaches the remote, and no title is applied twice. */
function expectIsolatedAndIdempotent(f: RelaySyncFixture) {
	const remote = rows(f, "remote");
	expect(remote.filter((row) => row.scope_id !== SCOPE)).toEqual([]);
	for (const side of ["client", "remote"] as const) {
		const titles = rows(f, side).map((row) => row.title);
		expect(new Set(titles).size).toBe(titles.length);
	}
	expect(rows(f, "client").filter((row) => row.scope_id !== SCOPE)).toEqual([
		{ scope_id: LOCAL_SCOPE, title: "local-only-item" },
		{ scope_id: "other-space", title: "other-space-item" },
	]);
}

describe("relay fault recovery and sync-state isolation", () => {
	it.each(cases)(
		"$name",
		async (fault) => {
			// Arrange.
			const { f, fault$ } = await arrange(fault);
			const cursorBefore = cursor(f);
			// Act: one pass with the fault armed.
			const faulted = await pass(f, fault.deadlineMs);
			// Assert: the failed pass reports its stable reason and leaves sync state safe.
			expectIsolatedAndIdempotent(f);
			if (fault.reason === null) {
				expect(faulted).toMatchObject({ ok: true });
			} else {
				expect(faulted).toMatchObject({ ok: false, relayFailureReason: fault.reason });
				// Relay DATA and control acknowledgements never stand in for a completed push.
				expect(ack(f)).toBeNull();
				const pulled = rows(f, "client").some((row) => row.title === "remote-item");
				// The replication cursor moves only together with an applied pull.
				if (!pulled) expect(cursor(f)).toEqual(cursorBefore);
				if (fault.snapshot) expect(pulled).toBe(false);
			}
			// Act: a clean retry.
			fault$.state.armed = false;
			const retried = await pass(f);
			// Assert: cursor, snapshot or pull, and push all converge once.
			expect(retried).toMatchObject({ ok: true });
			expectIsolatedAndIdempotent(f);
			const shared = (side: "client" | "remote") =>
				rows(f, side)
					.filter((row) => row.scope_id === SCOPE)
					.map((row) => row.title);
			expect(shared("client")).toEqual(["client-item", "remote-item"]);
			expect(shared("remote")).toEqual(["client-item", "remote-item"]);
			expect(ack(f)).toContain("|client-item-op");
			if (fault.snapshot) expect(cursor(f)).not.toBeNull();
			expect(f.relay.runtime.counters()).toMatchObject({ routes: 0, queuedBytes: 0 });
			expect(f.relay.runtime.counters().trafficQuotaAborts ?? 0).toBe(0);
		},
		90_000,
	);
});
