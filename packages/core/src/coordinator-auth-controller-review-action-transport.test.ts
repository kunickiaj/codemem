import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { coordinatorAuthControllerReviewAction } from "./coordinator-actions.js";
import {
	captureControllerHistorySnapshot,
	controllerHistoryDiscoveryFragments,
	parseControllerHistoryEvidence,
} from "./coordinator-auth-controller-history.js";
import type { CoordinatorControllerReviewPreview } from "./coordinator-auth-controller-review-route.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

const responseLimit = 2 * 750_000 + 16_384;
const options = {
	remoteUrl: "https://coordinator.example.test/",
	adminSecret: "fixture-secret",
	groupId: "group-a",
	deviceId: "device-a",
	identityId: "actor-a",
	fingerprint: "a".repeat(64),
};
type History = CoordinatorControllerReviewPreview["legacy_history"];
function historyRecord(index: number, long = true): History[number] {
	const group = `history-${index}`;
	// Quotes/backslashes inflate both JSON layers; Unicode distinguishes bytes from characters.
	const suffix = long ? '雪\\"'.repeat(80) : "";
	const decisions = Array.from({ length: long ? 40 : 1 }, (_, i) => ({
		device_id: `device-${i}-${suffix}`,
		key_fingerprint: options.fingerprint,
		enabled: true,
		identity_id: `actor-${i}-${suffix}`,
		decision: "included",
	}));
	const manifest = normalize({
		version: 1,
		coordinator_id: "coordinator-a",
		candidate_ref: legacyTeamCandidateId("coordinator-a", group),
		candidate_digest: "a".repeat(64),
		team_id: `team-${index}`,
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic retained Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: decisions.map(({ identity_id }) => ({ identity_id, role: "member" })),
		device_decisions: decisions,
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-10-01T00:00:00.000Z",
	});
	return {
		group_id: group,
		candidate_ref: manifest.candidate_ref,
		manifest_version: 1,
		completed_at: manifest.completed_at,
		created_at: manifest.completed_at,
		manifest_json: canonical(manifest),
		manifest,
	};
}
function snapshot(history: History) {
	return {
		coordinatorId: "coordinator-a",
		deviceId: options.deviceId,
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: options.fingerprint,
		keys: [{ public_key: CANONICAL_PUBLIC_KEY, fingerprint: options.fingerprint }],
		discoveryKeys: [CANONICAL_PUBLIC_KEY],
		discoveryFragments: controllerHistoryDiscoveryFragments(CANONICAL_PUBLIC_KEY),
		fingerprints: [options.fingerprint],
		records: history.map(({ manifest: _manifest, ...record }) => record),
	};
}
function preview(history: History): CoordinatorControllerReviewPreview {
	return {
		state: "ready",
		reasons: [],
		coordinator_id: "coordinator-a",
		evidence_digest: "b".repeat(64),
		enrollment: {
			device_id: options.deviceId,
			fingerprint: options.fingerprint,
			display_name: null,
			identity_label: "none",
		},
		reviewed_invites: [],
		reviewed_invite_count: 0,
		legacy_history: history,
	};
}
function nearSnapshotCap(): History {
	const history: History = [];
	for (let i = 0; i < 500; i++) {
		const next = [...history, historyRecord(i)];
		if (Buffer.byteLength(JSON.stringify(snapshot(next))) > 750_000) break;
		history.push(next[i] as History[number]);
	}
	return history;
}
function streamedResponse(text: string, declaredLength: boolean) {
	const bytes = new TextEncoder().encode(text);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				// Split UTF-8 sequences across chunks, exercising the real streaming decoder.
				const unicode = bytes.indexOf(0xe9);
				const split = unicode < 0 ? 1 : unicode + 1;
				controller.enqueue(bytes.subarray(0, split));
				for (let i = split; i < bytes.length; i += 16_381)
					controller.enqueue(bytes.subarray(i, i + 16_381));
				controller.close();
			},
		}),
		{ status: 200, headers: declaredLength ? { "content-length": String(bytes.byteLength) } : {} },
	);
}
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	vi.restoreAllMocks();
});

it("transports valid full history above 16 KiB with long escaped Unicode identifiers and both manifest forms", async () => {
	// Arrange: use the production snapshot and evidence validators, not route-only fixtures.
	const history = nearSnapshotCap();
	const stored = snapshot(history);
	const payload = preview(history);
	const encoded = JSON.stringify(payload);
	vi.mocked(fetch).mockResolvedValue(streamedResponse(encoded, false));
	// Act
	const result = await coordinatorAuthControllerReviewAction(options);
	// Assert
	expect(history.length).toBeGreaterThan(1);
	expect(history.length).toBeLessThanOrEqual(500);
	expect(Buffer.byteLength(JSON.stringify(stored))).toBeGreaterThan(600_000);
	expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(750_000);
	expect(captureControllerHistorySnapshot(stored)).not.toBeNull();
	expect(parseControllerHistoryEvidence(history, payload.coordinator_id)).toEqual(history);
	expect(Buffer.byteLength(encoded)).toBeGreaterThan(16_384);
	expect(Buffer.byteLength(encoded)).toBeGreaterThan(encoded.length);
	expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(responseLimit);
	expect(encoded).toContain('\\\\\\"');
	expect(encoded).toContain("雪");
	expect(result).toEqual(payload);
	expect(fetch).toHaveBeenCalledExactlyOnceWith(
		"https://coordinator.example.test/v1/admin/auth-controller-reviews",
		expect.objectContaining({
			method: "POST",
			redirect: "error",
			headers: expect.objectContaining({ "X-Codemem-Coordinator-Admin": "fixture-secret" }),
		}),
	);
	const request = vi.mocked(fetch).mock.calls[0]?.[1];
	expect(JSON.parse(new TextDecoder().decode(request?.body as Uint8Array))).toEqual({
		group_id: options.groupId,
		device_id: options.deviceId,
		identity_id: options.identityId,
		fingerprint: options.fingerprint,
	});
});
it.each([true, false])(
	"accepts the exact finite byte budget with declared length=%s",
	async (declared) => {
		// Arrange: trailing JSON whitespace reaches the exact limit without inventing manifest fields.
		const payload = preview([historyRecord(0)]);
		const encoded = JSON.stringify(payload);
		const text = encoded + " ".repeat(responseLimit - Buffer.byteLength(encoded));
		vi.mocked(fetch).mockResolvedValue(streamedResponse(text, declared));
		// Act
		const result = await coordinatorAuthControllerReviewAction(options);
		// Assert
		expect(Buffer.byteLength(text)).toBe(responseLimit);
		expect(result).toEqual(payload);
		expect(fetch).toHaveBeenCalledOnce();
	},
);
it.each([true, false])(
	"refuses one byte above budget with declared length=%s without retry or confirmation",
	async (declared) => {
		// Arrange
		const encoded = JSON.stringify(preview([historyRecord(0)]));
		const text = encoded + " ".repeat(responseLimit + 1 - Buffer.byteLength(encoded));
		vi.mocked(fetch).mockResolvedValue(streamedResponse(text, declared));
		// Act
		const result = coordinatorAuthControllerReviewAction(options);
		// Assert
		expect(Buffer.byteLength(text)).toBe(responseLimit + 1);
		await expect(result).rejects.toThrow("coordinator_response_too_large");
		expect(fetch).toHaveBeenCalledOnce();
	},
);
it("accepts the 500-record history boundary through the real action transport", async () => {
	// Arrange
	const history = Array.from({ length: 500 }, (_, i) => historyRecord(i, false));
	const payload = preview(history);
	vi.mocked(fetch).mockResolvedValue(streamedResponse(JSON.stringify(payload), false));
	// Act
	const result = await coordinatorAuthControllerReviewAction(options);
	// Assert
	expect(captureControllerHistorySnapshot(snapshot(history))).not.toBeNull();
	expect(parseControllerHistoryEvidence(result.legacy_history, payload.coordinator_id)).toEqual(
		history,
	);
	expect(result.legacy_history).toHaveLength(500);
	expect(fetch).toHaveBeenCalledOnce();
});
it("rejects 501 records through the shared history validator even when transport bytes fit", async () => {
	// Arrange
	const history = Array.from({ length: 501 }, (_, i) => historyRecord(i, false));
	const payload = preview(history);
	vi.mocked(fetch).mockResolvedValue(streamedResponse(JSON.stringify(payload), false));
	// Act
	const result = await coordinatorAuthControllerReviewAction(options);
	// Assert
	expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(responseLimit);
	expect(captureControllerHistorySnapshot(snapshot(history))).toBeNull();
	expect(() =>
		parseControllerHistoryEvidence(result.legacy_history, payload.coordinator_id),
	).toThrow("legacy_history_invalid");
	expect(fetch).toHaveBeenCalledOnce();
});
