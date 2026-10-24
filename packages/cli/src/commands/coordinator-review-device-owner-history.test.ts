import {
	type CoordinatorControllerReviewPreview,
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	legacyTeamCandidateId,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
	RemoteCoordinatorRequestError,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	coordinatorAuthControllerReviewAction: vi.fn(),
	readCoordinatorOwnerReviewLocalEvidence: vi.fn(),
	readCodememConfigFile: vi.fn(),
	resolveDbPath: vi.fn((path: string) => path),
	confirm: vi.fn(),
	isCancel: vi.fn(() => false),
	log: { error: vi.fn(), warn: vi.fn(), message: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	...mocks,
}));
vi.mock("@clack/prompts", () => ({
	confirm: mocks.confirm,
	isCancel: mocks.isCancel,
	log: mocks.log,
}));

import {
	buildCoordinatorReviewDeviceOwnerCommand,
	formatControllerReviewHistory,
} from "./coordinator-review-device-owner.js";

const subject = { deviceId: "device-a", fingerprint: "a".repeat(64), identityId: "current-actor" };
type Decision =
	CoordinatorControllerReviewPreview["legacy_history"][number]["manifest"]["device_decisions"][number];
function decision(index = 0, long = false): Decision {
	return {
		device_id: long ? `${index}-${"d".repeat(250)}` : `device-${index}`,
		key_fingerprint: subject.fingerprint,
		enabled: true,
		identity_id: long ? `actor-${"i".repeat(250)}` : "old-actor",
		decision: "included",
	};
}
function preview(
	records = 1,
	decisions: Decision[] = [decision()],
): CoordinatorControllerReviewPreview {
	return {
		state: "ready",
		reasons: [],
		coordinator_id: "coordinator-a",
		evidence_digest: "b".repeat(64),
		enrollment: {
			device_id: subject.deviceId,
			fingerprint: subject.fingerprint,
			display_name: null,
			identity_label: "none",
		},
		reviewed_invites: [],
		reviewed_invite_count: 0,
		legacy_history: Array.from({ length: records }, (_, index) => {
			const group = `historical-group-${index}`;
			const manifest = normalize({
				version: 1,
				coordinator_id: "coordinator-a",
				candidate_ref: legacyTeamCandidateId("coordinator-a", group),
				candidate_digest: "a".repeat(64),
				team_id: `historical-team-${index}`,
				team_digest: "b".repeat(64),
				source_digest: "c".repeat(64),
				finish_digest: "d".repeat(64),
				access_delta_digest: "e".repeat(64),
				team: {
					display_name: "Historical Team",
					policy_revision: "f".repeat(64),
					device_eligibility_mode: "reviewed_allowlist",
				},
				memberships: [
					...new Set(decisions.flatMap((row) => (row.identity_id ? [row.identity_id] : []))),
				].map((identity_id) => ({ identity_id, role: "member" })),
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
		}),
	};
}
function run(json = false) {
	return buildCoordinatorReviewDeviceOwnerCommand().parseAsync(
		["group-a", ...(json ? ["--json"] : [])],
		{ from: "user" },
	);
}
function order(mock: { mock: { invocationCallOrder: number[] } }, index = -1): number {
	const value = mock.mock.invocationCallOrder.at(index);
	if (value === undefined) throw new Error("Expected invocation missing");
	return value;
}
const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalExitCode = process.exitCode;
beforeEach(() => {
	vi.resetAllMocks();
	for (const key of [
		"CODEMEM_ACTOR_ID",
		"CODEMEM_DEVICE_ID",
		"CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_TIMEOUT_S",
	])
		vi.stubEnv(key, undefined);
	process.exitCode = undefined;
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
	mocks.readCodememConfigFile.mockReturnValue({
		actor_id: subject.identityId,
		sync_coordinator_url: "https://coordinator.example.test",
		sync_coordinator_admin_secret: "fixture-secret",
	});
	mocks.readCoordinatorOwnerReviewLocalEvidence.mockReturnValue({
		state: "ready",
		reasons: [],
		device: { ...subject, publicKey: "fixture-key" },
		identity: { identityId: subject.identityId, source: "config" },
		memoryCounts: { current: 2, others: 3, unknown: 1 },
		teamCount: 1,
		projectCount: 2,
		ownershipRecords: { actorPresent: true, deviceAssignmentPresent: true },
	});
	mocks.coordinatorAuthControllerReviewAction.mockResolvedValue(preview());
	mocks.confirm.mockResolvedValue(false);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	process.exitCode = originalExitCode;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it("shows complete historical assignments and current authority before default-No approval", async () => {
	// Arrange
	const evidence = preview(1, [
		{ ...decision(), device_id: subject.deviceId },
		{ ...decision(1), identity_id: null, enabled: false, decision: "excluded" },
	]);
	mocks.coordinatorAuthControllerReviewAction.mockResolvedValue(evidence);
	// Act
	await run();
	// Assert
	const output = mocks.log.message.mock.calls.map(([text]) => String(text)).join("\n");
	for (const value of [
		"historical-group-0",
		"historical-team-0",
		"2026-10-01",
		"included",
		"excluded",
		"old-actor",
		"Identity: none",
		"device-a",
		"device-1",
		subject.fingerprint,
		subject.identityId,
		"enabled: yes",
		"enabled: no",
	])
		expect(output).toContain(value);
	for (const record of evidence.legacy_history) {
		expect(output).toContain(JSON.stringify(record.manifest_json));
		expect(output).toContain(record.candidate_ref);
		expect(output).toContain(`manifest version: ${record.manifest_version}`);
		expect(output).toContain(JSON.stringify(record.created_at));
	}
	expect(output).toMatch(
		/does not migrate sharing, move memories, merge Identities, or grant Team\/Project access/,
	);
	expect(output).toContain("existing controller authority, including account management");
	expect(output).toContain("Google account linking remains a separate step");
	expect(order(mocks.log.message)).toBeLessThan(order(mocks.confirm, 0));
	expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledOnce();
	expect(mocks.log.success).not.toHaveBeenCalled();
});
it.each([
	[subject.deviceId, subject.fingerprint, "Current device; current fingerprint"],
	[subject.deviceId, "c".repeat(64), "Current device; different recorded key"],
	["other-device", subject.fingerprint, "Other device; current fingerprint"],
	[
		"other-device",
		"c".repeat(64),
		"Other recorded device/key; canonical-key equivalence is not identified",
	],
])(
	"classifies device %s / fingerprint %s without assuming aliases",
	(device_id, key_fingerprint, expected) => {
		// Arrange
		const evidence = preview(1, [{ ...decision(), device_id, key_fingerprint }]);
		// Act
		const result = formatControllerReviewHistory(evidence, subject);
		// Assert
		expect(result.complete).toBe(true);
		expect(result.text).toContain(expected);
		if (device_id !== subject.deviceId || key_fingerprint !== subject.fingerprint)
			expect(result.text).not.toContain("Current device; current fingerprint");
	},
);
it("escapes terminal and Unicode controls while retaining readable Unicode", () => {
	// Arrange: test formatter escaping even for values rejected by canonical parsing.
	const evidence = preview();
	const unsafe = '雪 café "quoted"\n\r\t\u001b[31m\u009b\u202e\u2028\u2029\ud800';
	const record = evidence.legacy_history[0];
	if (!record) throw new Error("Expected history missing");
	record.group_id = unsafe;
	record.manifest.team_id = unsafe;
	record.completed_at = unsafe;
	record.manifest.device_decisions[0] = {
		...decision(),
		device_id: unsafe,
		identity_id: unsafe,
		key_fingerprint: unsafe,
	};
	// Act
	const result = formatControllerReviewHistory(evidence, { ...subject, identityId: unsafe });
	// Assert
	expect(result.complete).toBe(true);
	expect(result.text).toContain("雪 café");
	expect(result.text).toContain('\\"quoted\\"');
	for (const escaped of [
		"\\n",
		"\\r",
		"\\t",
		"\\u001b",
		"\\u{9b}",
		"\\u{202e}",
		"\\u{2028}",
		"\\u{2029}",
		"\\ud800",
	])
		expect(result.text).toContain(escaped);
	for (const code of [13, 9, 27, 155, 0x202e, 0x2028, 0x2029, 0xd800])
		expect(result.text).not.toContain(String.fromCodePoint(code));
});
const limits = [
	// Full canonical manifests can hit the character limit before the 20-record cap.
	{ name: "records", within: () => preview(10), over: () => preview(21) },
	{
		name: "decisions",
		within: () =>
			preview(
				1,
				Array.from({ length: 40 }, (_, i) => decision(i)),
			),
		over: () =>
			preview(
				1,
				Array.from({ length: 41 }, (_, i) => decision(i)),
			),
	},
	{
		name: "characters",
		within: () =>
			preview(
				1,
				Array.from({ length: 5 }, (_, i) => decision(i, true)),
			),
		over: () =>
			preview(
				1,
				Array.from({ length: 40 }, (_, i) => decision(i, true)),
			),
	},
];
it.each(limits)(
	"keeps $name within budget complete and allows the ordinary prompt",
	async ({ within }) => {
		// Arrange
		const evidence = within();
		mocks.coordinatorAuthControllerReviewAction.mockResolvedValue(evidence);
		// Act
		const result = formatControllerReviewHistory(evidence, subject);
		await run();
		// Assert
		expect(result.complete).toBe(true);
		expect(result.text).not.toContain("TRUNCATED");
		expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
	},
);
it.each(limits)(
	"caps $name and refuses confirmation instead of hiding evidence",
	async ({ over, name }) => {
		// Arrange
		const evidence = over();
		mocks.coordinatorAuthControllerReviewAction.mockResolvedValue(evidence);
		mocks.confirm.mockResolvedValue(true);
		// Act
		const result = formatControllerReviewHistory(evidence, subject);
		await run();
		// Assert
		expect(result.complete).toBe(false);
		expect(result.text).toContain("TRUNCATED");
		expect(result.text).toContain("Terminal confirmation is disabled");
		expect(result.text.length).toBeLessThan(25_000);
		if (name === "records")
			expect(result.text.match(/Historical group/g)?.length ?? 0).toBeLessThanOrEqual(20);
		if (name === "decisions") expect(result.text.match(/ {2}Device:/g)).toHaveLength(40);
		if (name === "characters")
			expect(result.text.match(/ {2}Device:/g)?.length ?? 0).toBeLessThan(40);
		expect(process.exitCode).toBe(2);
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledOnce();
		expect(mocks.log.error).toHaveBeenCalledWith(
			expect.stringContaining("--json"),
			expect.anything(),
		);
		expect(mocks.log.success).not.toHaveBeenCalled();
	},
);
it("JSON preserves every full manifest over the terminal limit without prompting or mutation", async () => {
	// Arrange
	const evidence = preview(21);
	mocks.coordinatorAuthControllerReviewAction.mockResolvedValue(evidence);
	// Act
	await run(true);
	// Assert
	const output = JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]?.[0]));
	expect(output).toMatchObject({
		unchanged: true,
		review: { legacy_history: evidence.legacy_history },
	});
	expect(output.review.legacy_history).toHaveLength(21);
	expect(mocks.log.message).not.toHaveBeenCalled();
	expect(mocks.confirm).not.toHaveBeenCalled();
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledOnce();
});
it("empty history retains default-No approval and authority disclosure", async () => {
	// Arrange
	const evidence = preview(0);
	mocks.coordinatorAuthControllerReviewAction.mockResolvedValue(evidence);
	// Act
	const result = formatControllerReviewHistory(evidence, subject);
	await run();
	// Assert
	expect(result.complete).toBe(true);
	expect(result.text).toContain("No relevant retained legacy assignments");
	expect(result.text).toContain("existing controller authority");
	expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledOnce();
});
it("approval commits only the current actor and exact digest after displaying unchanged history", async () => {
	// Arrange
	const evidence = preview();
	const retained = structuredClone(evidence);
	mocks.confirm.mockResolvedValue(true);
	mocks.coordinatorAuthControllerReviewAction
		.mockResolvedValueOnce(evidence)
		.mockResolvedValueOnce({
			state: "created",
			attestation_id: `controller-v1:${"d".repeat(64)}`,
			coordinator_id: evidence.coordinator_id,
			group_id: "group-a",
			device_id: subject.deviceId,
			identity_id: subject.identityId,
			fingerprint: subject.fingerprint,
			created_at: "2026-10-01T00:00:00.000Z",
		});
	// Act
	await run();
	// Assert
	expect(process.exitCode).toBeUndefined();
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledTimes(2);
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenLastCalledWith(
		expect.objectContaining({
			identityId: subject.identityId,
			deviceId: subject.deviceId,
			fingerprint: subject.fingerprint,
			confirmEvidenceDigest: evidence.evidence_digest,
		}),
	);
	expect(order(mocks.log.message)).toBeLessThan(order(mocks.confirm, 0));
	expect(order(mocks.confirm, 0)).toBeLessThan(
		order(mocks.coordinatorAuthControllerReviewAction, 1),
	);
	expect(evidence).toEqual(retained);
	expect(mocks.log.success).toHaveBeenCalledOnce();
});
it.each(["missing", "null", "malformed", "mismatched-manifest"])(
	"refuses %s history with upgrade guidance in human and JSON output",
	async (field) => {
		// Arrange
		const { legacy_history: _history, ...oldPreview } = preview(0);
		let legacy_history: unknown = null;
		if (field === "malformed") legacy_history = [{}];
		if (field === "mismatched-manifest") {
			const evidence = preview();
			const row = evidence.legacy_history[0];
			if (!row) throw new Error("Expected history missing");
			row.manifest.team_id = "tampered-team";
			legacy_history = evidence.legacy_history;
		}
		const payload = field === "missing" ? oldPreview : { ...oldPreview, legacy_history };
		mocks.coordinatorAuthControllerReviewAction.mockResolvedValue(payload);
		mocks.confirm.mockResolvedValue(true);
		// Act
		await run();
		await run(true);
		// Assert
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledTimes(2);
		expect(process.exitCode).toBe(1);
		const human = mocks.log.error.mock.calls.map(([text]) => String(text)).join("\n");
		const json = JSON.parse(
			String(
				vi.mocked(process.stdout.write).mock.calls[0]?.[0] ??
					vi.mocked(console.log).mock.calls[0]?.[0],
			),
		);
		expect(human).toMatch(/update.*coordinator|coordinator.*update/i);
		expect(json.error).toBeTruthy();
		expect(json.message).toMatch(/update.*coordinator|coordinator.*update/i);
		expect(json.review).toBeUndefined();
		expect(mocks.log.message.mock.calls.map(([text]) => String(text)).join("\n")).not.toContain(
			"No relevant retained legacy assignments",
		);
		expect(mocks.log.success).not.toHaveBeenCalled();
	},
);
it("stale digest after explicit approval never retries or autoapproves fresh history", async () => {
	// Arrange
	const evidence = preview();
	mocks.confirm.mockResolvedValue(true);
	mocks.coordinatorAuthControllerReviewAction
		.mockResolvedValueOnce(evidence)
		.mockRejectedValueOnce(new RemoteCoordinatorRequestError(409, "review_stale"));
	// Act
	await run();
	// Assert
	expect(mocks.confirm).toHaveBeenCalledOnce();
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenCalledTimes(2);
	expect(mocks.coordinatorAuthControllerReviewAction).toHaveBeenLastCalledWith(
		expect.objectContaining({ confirmEvidenceDigest: evidence.evidence_digest }),
	);
	expect(mocks.log.error).toHaveBeenCalledWith(
		expect.stringContaining("Evidence changed since the preview"),
		expect.anything(),
	);
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});
