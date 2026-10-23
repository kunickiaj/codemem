import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { cfg, NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	enroll,
	type Fixture,
	review,
	setupStore,
	sqliteD1,
} from "./coordinator-auth-store-test-fixtures.js";
import { controllerGuardedD1 } from "./coordinator-controller-revocation-test-harness.js";
import { parseSshEd25519PublicKeyForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	ACCEPTED_ALIASES,
	CANONICAL_BASE64,
	CANONICAL_PUBLIC_KEY,
	MALFORMED_KEYS,
	publicKeyFromWire,
	wireBytes,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

const subject = review({ publicKey: CANONICAL_PUBLIC_KEY });
const secret = "synthetic-admin-secret";
const body = {
	group_id: subject.groupId,
	device_id: subject.deviceId,
	identity_id: subject.identityId,
	fingerprint: subject.fingerprint,
};
function appFor(f: Fixture) {
	return createCoordinatorApp({
		storeFactory: () => f.store,
		requestVerifier: async () => false,
		runtime: { adminSecret: () => secret, now: () => new Date(NOW).toISOString() },
		authLink: {
			config: { ...cfg, redirectUri: "https://coordinator.example.test/auth/callback" },
			storeFactory: () => f.store,
		},
	});
}
function request(app: ReturnType<typeof appFor>, digest?: string) {
	return app.request("/v1/admin/auth-controller-reviews", {
		method: "POST",
		headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": secret },
		body: JSON.stringify({ ...body, ...(digest ? { confirm_evidence_digest: digest } : {}) }),
	});
}
function snapshot(f: Fixture) {
	return (
		f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
			name: string;
		}[]
	).map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
function history(
	f: Fixture,
	options: {
		group?: string;
		device?: string;
		fingerprint?: string;
		identity?: string | null;
	} = {},
) {
	const group = options.group ?? "history-group";
	const identity = options.identity === undefined ? "old-identity" : options.identity;
	const manifest = normalize({
		version: 1,
		coordinator_id: cfg.coordinatorId,
		candidate_ref: legacyTeamCandidateId(cfg.coordinatorId, group),
		candidate_digest: "a".repeat(64),
		team_id: `team-${group}`,
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic historical Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: identity ? [{ identity_id: identity, role: "member" }] : [],
		device_decisions: [
			{
				device_id: options.device ?? subject.deviceId,
				key_fingerprint: options.fingerprint ?? subject.fingerprint,
				enabled: true,
				identity_id: identity,
				decision: identity ? "included" : "excluded",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-10-01T00:00:00.000Z",
	});
	f.db
		.prepare(`INSERT INTO coordinator_legacy_team_completions
		(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
		VALUES (?,?,?,?,?,?)`)
		.run(
			group,
			manifest.candidate_ref,
			1,
			canonical(manifest),
			manifest.completed_at,
			manifest.completed_at,
		);
	return manifest;
}
function changeHistory(f: Fixture) {
	f.db
		.prepare("UPDATE coordinator_legacy_team_completions SET created_at=?")
		.run("2026-10-02T00:00:00.000Z");
}
function unrelatedDevice(index: number) {
	// Valid SSH Ed25519 wire structure, with a distinct 32-byte raw key per device.
	const wire = Buffer.from(CANONICAL_BASE64, "base64");
	wire.writeUInt32BE(index + 1, wire.length - 4);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return {
		device: `unrelated-device-${index}`,
		publicKey,
		fingerprint: createHash("sha256").update(publicKey).digest("hex"),
	};
}
function enrollUnrelated(f: Fixture, index: number, comment?: string) {
	const device = unrelatedDevice(index);
	if (comment !== undefined) {
		const wire = Buffer.from(CANONICAL_BASE64, "base64");
		wire.set(
			createHash("sha256").update(`unrelated-roster-key-${index}`).digest(),
			wire.length - 32,
		);
		device.publicKey = `ssh-ed25519 ${wire.toString("base64")} ${comment}`;
		device.fingerprint = createHash("sha256").update(device.publicKey).digest("hex");
	}
	f.db
		.prepare(`INSERT INTO enrolled_devices
		(group_id,device_id,public_key,fingerprint,enabled,created_at) VALUES (?,?,?,?,1,?)`)
		.run(
			subject.groupId,
			device.device,
			device.publicKey,
			device.fingerprint,
			"2026-10-01T00:00:00.000Z",
		);
	return device;
}
function corruptedJson(manifest: ReturnType<typeof history>, invalid: string) {
	const json = canonical(manifest);
	switch (invalid) {
		case "canonical-bytes":
			return JSON.stringify(manifest, null, 2);
		case "malformed-json":
			return `{"device_decisions":[{"device_id":"${subject.deviceId}"}`;
		case "missing-fingerprint":
			return json.replace(`"key_fingerprint":"${subject.fingerprint}",`, "");
		case "unsafe-fingerprint":
			return json.replace(subject.fingerprint, "unsafe\\u0000fingerprint");
		case "oversized":
			return json.replace("Synthetic historical Team", "x".repeat(750_001));
		default:
			return json;
	}
}
function discoveryAlias(innerTypeLength: number, representation: string) {
	const wire = wireBytes({
		innerType: "x".repeat(innerTypeLength),
		trailing: representation === "trailing bytes and comments" ? [0, 0, 255] : [],
	});
	const key = publicKeyFromWire(wire);
	switch (representation) {
		case "URL-safe":
			return key.replace(/\+/g, "-").replace(/\//g, "_");
		case "Buffer-ignored junk":
			return key.replace("ssh-ed25519 ", "ssh-ed25519 !");
		case "Unicode whitespace":
			return `\u2003${key.replace(" ", "\u00a0")}\u2003`;
		case "trailing bytes and comments":
			return `${key} ordinary.user@example.test 雪`;
		default:
			return key;
	}
}
const discoveryAliases = [0, 1, 2].flatMap((innerTypeLength) =>
	[
		"plain",
		"URL-safe",
		"Buffer-ignored junk",
		"Unicode whitespace",
		"trailing bytes and comments",
	].map((representation) => ({
		alignment: (8 + innerTypeLength) % 3,
		representation,
		publicKey: discoveryAlias(innerTypeLength, representation),
	})),
);

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const backend of ["SQLite", "D1"] as const) {
	const test = it.extend<{ f: Fixture }>({
		f: async ({ task: _task }, use) => {
			const f = setupStore(backend, { authClock: () => NOW });
			vi.spyOn(f.store, "close").mockResolvedValue(undefined);
			await enroll(f.store, subject);
			try {
				await use(f);
			} finally {
				f.db.close();
			}
		},
	});
	describe(`${backend} controller history pinning`, () => {
		test("previews complete canonical agreeing, disagreeing and excluded cross-group history read-only", async ({
			f,
		}) => {
			// Arrange: unrelated malformed history must not veto an otherwise valid review.
			const manifests = [
				history(f, { group: "agree", identity: subject.identityId }),
				history(f, { group: "disagree" }),
				history(f, { group: "excluded", identity: null }),
			];
			history(f, { group: "unrelated", device: "other-device", fingerprint: "9".repeat(64) });
			f.db
				.prepare(
					"UPDATE coordinator_legacy_team_completions SET manifest_json='broken' WHERE group_id='unrelated'",
				)
				.run();
			const before = snapshot(f);
			const app = appFor(f);
			// Act
			const response = await request(app);
			const preview = await response.json();
			const afterPreview = snapshot(f);
			const committed = await request(app, preview.evidence_digest);
			// Assert: preview exposes all evidence, not only matching assignments or summaries.
			expect(response.status).toBe(200);
			expect(preview.state).toBe("ready");
			expect(preview.legacy_history).toEqual(
				manifests.map((manifest, index) => ({
					group_id: ["agree", "disagree", "excluded"][index],
					candidate_ref: manifest.candidate_ref,
					manifest_version: 1,
					completed_at: manifest.completed_at,
					created_at: manifest.completed_at,
					manifest_json: canonical(manifest),
					manifest,
				})),
			);
			expect(afterPreview).toEqual(before);
			expect(committed.status).toBe(201);
			expect(
				f.db
					.prepare(
						"SELECT manifest_json FROM coordinator_legacy_team_completions WHERE group_id!='unrelated' ORDER BY group_id",
					)
					.all(),
			).toEqual(manifests.map((manifest) => ({ manifest_json: canonical(manifest) })));
		});
		test("unrelated new identity history does not invalidate confirmation or its exact retry", async ({
			f,
		}) => {
			// Arrange: the additional record shares neither the reviewed device nor a known key alias.
			history(f);
			const app = appFor(f);
			const preview = await (await request(app)).json();
			history(f, { group: "unrelated", device: "other", fingerprint: "9".repeat(64) });
			// Act
			const committed = await request(app, preview.evidence_digest);
			const afterCommit = snapshot(f);
			const retry = await request(app, preview.evidence_digest);
			// Assert: the relevant evidence has not changed; the retry writes nothing.
			expect(committed.status).toBe(201);
			expect(retry.status).toBe(200);
			expect(snapshot(f)).toEqual(afterCommit);
		});

		test.for(["metadata", "new-record", "newly-relevant", "exact-retry"] as const)(
			"rejects stale digest after %s without additional writes",
			async (change, { f }) => {
				// Arrange
				history(f);
				if (change === "newly-relevant")
					history(f, { group: "later", device: "other", fingerprint: "9".repeat(64) });
				const app = appFor(f);
				const preview = await (await request(app)).json();
				if (change === "exact-retry")
					expect((await request(app, preview.evidence_digest)).status).toBe(201);
				if (change === "new-record") history(f, { group: "new" });
				else if (change === "newly-relevant") {
					f.db
						.prepare("DELETE FROM coordinator_legacy_team_completions WHERE group_id='later'")
						.run();
					history(f, { group: "later" });
				} else changeHistory(f);
				const before = snapshot(f);
				// Act
				const denied = await request(app, preview.evidence_digest);
				// Assert
				expect(denied.status).toBe(409);
				expect(await denied.json()).toMatchObject({ error: "review_stale" });
				expect(snapshot(f)).toEqual(before);
			},
		);
	});
	describe(`${backend} unrelated enrolled history isolation`, () => {
		test.for([
			{ change: "already-enrolled device completes history", retry: false },
			{ change: "already-enrolled device completes history", retry: true },
			{ change: "history device becomes newly enrolled", retry: false },
			{ change: "history device becomes newly enrolled", retry: true },
		])(
			"unrelated $change preserves evidence and success with exact retry=$retry",
			async ({ change, retry }, { f }) => {
				// Arrange: keep real subject evidence; only another device/key changes.
				history(f);
				const unrelated = unrelatedDevice(0);
				if (change === "already-enrolled device completes history") enrollUnrelated(f, 0);
				else
					history(f, {
						group: "unrelated",
						device: unrelated.device,
						fingerprint: unrelated.fingerprint,
					});
				const app = appFor(f);
				const beforePreview = snapshot(f);
				const original = await (await request(app)).json();
				expect(snapshot(f)).toEqual(beforePreview);
				if (retry) expect((await request(app, original.evidence_digest)).status).toBe(201);
				if (change === "already-enrolled device completes history")
					history(f, {
						group: "unrelated",
						device: unrelated.device,
						fingerprint: unrelated.fingerprint,
					});
				else enrollUnrelated(f, 0);
				const before = snapshot(f);
				// Act
				const fresh = await (await request(app)).json();
				const afterPreview = snapshot(f);
				const result = await request(app, original.evidence_digest);
				const afterCommit = snapshot(f);
				const repeated = await request(app, original.evidence_digest);
				// Assert: unrelated history cannot change the review or break an exact retry.
				expect(afterPreview).toEqual(before);
				expect(fresh.legacy_history).toEqual(original.legacy_history);
				expect(fresh.evidence_digest).toBe(original.evidence_digest);
				expect(result.status).toBe(retry ? 200 : 201);
				expect(repeated.status).toBe(200);
				expect(snapshot(f)).toEqual(afterCommit);
				if (retry) expect(afterCommit).toEqual(before);
			},
		);
		test("4097 unrelated enrolled keys with canonical history do not deny an empty subject review", async ({
			f,
		}) => {
			// Arrange: exceed the global key count, but retain zero relevant subject records.
			const app = appFor(f);
			const original = await (await request(app)).json();
			f.db.transaction(() => {
				for (let index = 0; index < 4097; index++) {
					const unrelated = enrollUnrelated(f, index);
					history(f, {
						group: `unrelated-${index}`,
						device: unrelated.device,
						fingerprint: unrelated.fingerprint,
					});
				}
			})();
			const before = snapshot(f);
			// Act
			const fresh = await (await request(app)).json();
			const afterPreview = snapshot(f);
			const result = await request(app, original.evidence_digest);
			// Assert: resource limits apply to relevant evidence, not other owners' history.
			expect(afterPreview).toEqual(before);
			expect(fresh).toMatchObject({
				state: "ready",
				legacy_history: [],
				evidence_digest: original.evidence_digest,
			});
			expect(result.status).toBe(201);
		});
	});
	describe(`${backend} ordinary commented roster isolation`, () => {
		test.for([
			{
				name: "ASCII email",
				comment:
					"ordinary.user@example.test Synthetic workstation personal development key generated for standard SSH client use",
			},
			{
				name: "Unicode name",
				comment:
					"ordinary.user@example.test 雪 café Synthetic workstation personal development key generated for standard SSH client use",
			},
		])(
			"4097 unrelated keys with $name comments leave empty review ready and retryable",
			async ({ comment }, { f }) => {
				// Arrange: change every raw key byte, not merely its suffix, so shared key
				// fragments cannot explain collecting this ordinary preexisting roster.
				f.db.transaction(() => {
					for (let index = 0; index < 4097; index++) enrollUnrelated(f, index, comment);
				})();
				const sample = f.db
					.prepare("SELECT public_key FROM enrolled_devices WHERE device_id='unrelated-device-0'")
					.get() as { public_key: string };
				expect(parseSshEd25519PublicKeyForRevocation(sample.public_key).kind).toBe("ed25519");
				expect(parseSshEd25519PublicKeyForRevocation(sample.public_key)).not.toEqual(
					parseSshEd25519PublicKeyForRevocation(subject.publicKey),
				);
				const before = snapshot(f);
				const app = appFor(f);
				// Act
				const preview = await (await request(app)).json();
				const afterPreview = snapshot(f);
				const digest = preview.evidence_digest ?? "b".repeat(64);
				const committed = await request(app, digest);
				const afterCommit = snapshot(f);
				const retry = await request(app, digest);
				// Assert: comments cannot turn unrelated keys into subject evidence limits.
				expect(afterPreview).toEqual(before);
				expect(preview).toMatchObject({
					state: "ready",
					legacy_history: [],
					evidence_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
				});
				expect(committed.status).toBe(201);
				expect(retry.status).toBe(200);
				expect(snapshot(f)).toEqual(afterCommit);
			},
		);
	});
	describe(`${backend} portable alias discovery`, () => {
		test.for(discoveryAliases)(
			"discovers $representation at raw-key alignment $alignment and rejects stale approval",
			async ({ publicKey }, { f }) => {
				// Arrange: validate fixture identity using the compatibility parser before
				// exercising actual store SQL; text fragments never prove key identity.
				const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
				expect(parsed.kind).toBe("ed25519");
				expect(parsed).toEqual(parseSshEd25519PublicKeyForRevocation(subject.publicKey));
				const fingerprint = "8".repeat(64);
				const manifest = history(f, { device: "historical-other-device", fingerprint });
				const app = appFor(f);
				const original = await (await request(app)).json();
				expect(original.legacy_history).toEqual([]);
				await enroll(
					f.store,
					review({ groupId: "alias", deviceId: "alias-device", publicKey, fingerprint }),
				);
				const before = snapshot(f);
				// Act
				const fresh = await (await request(app)).json();
				const afterPreview = snapshot(f);
				const stale = await request(app, original.evidence_digest);
				const committed = await request(app, fresh.evidence_digest);
				// Assert: every accepted representation finds the retained record and
				// changes reviewed evidence without approving the previously empty view.
				expect(afterPreview).toEqual(before);
				expect(fresh.state).toBe("ready");
				expect(fresh.legacy_history).toEqual([
					expect.objectContaining({ manifest, manifest_json: canonical(manifest) }),
				]);
				expect(fresh.evidence_digest).not.toBe(original.evidence_digest);
				expect(stale.status).toBe(409);
				expect(committed.status).toBe(201);
			},
		);
	});
	describe(`${backend} history write and alias guards`, () => {
		test.for(["metadata", "new-record", "new-key-alias"] as const)(
			"winning INSERT rejects post-preflight %s race",
			async (change, { f }) => {
				// Arrange: intercept the actual write, not the route preview or store preflight.
				history(f);
				if (change === "new-key-alias")
					history(f, { group: "later", device: "other", fingerprint: "8".repeat(64) });
				const pinned = await f.store.captureAuthControllerLegacyHistory({
					coordinatorId: cfg.coordinatorId,
					deviceId: subject.deviceId,
					publicKey: subject.publicKey,
					fingerprint: subject.fingerprint,
				});
				const input = review({
					...subject,
					coordinatorId: cfg.coordinatorId,
					verifiedSnapshot: { enrollmentIdentityId: null, invites: [], legacyHistory: pinned },
				});
				let changed = false;
				const gate = (query: string) => {
					if (
						changed ||
						!/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+coordinator_auth_controller_attestations\b/iu.test(
							query,
						)
					)
						return;
					changed = true;
					if (change === "metadata") changeHistory(f);
					else if (change === "new-key-alias") {
						f.db
							.prepare(`INSERT INTO enrolled_devices
						(group_id,device_id,public_key,fingerprint,enabled,created_at)
						SELECT group_id,'new-alias',?, ?,1,created_at FROM enrolled_devices WHERE device_id=?`)
							.run(`${CANONICAL_PUBLIC_KEY} alias`, "8".repeat(64), subject.deviceId);
					} else history(f, { group: "raced" });
				};
				let racing = f.store;
				if (backend === "D1")
					racing = controllerGuardedD1(sqliteD1(f.db), async (query) => gate(query));
				else {
					const prepare = f.db.prepare.bind(f.db);
					vi.spyOn(f.db, "prepare").mockImplementation((query: string) => {
						gate(query);
						return prepare(query);
					});
				}
				// Act
				const result = await racing.createAuthControllerAttestation(input);
				// Assert
				expect(changed).toBe(true);
				expect(result).toEqual({ kind: "rejected", error: "review_stale" });
				expect(
					f.db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all(),
				).toEqual([]);
				expect(f.db.prepare("SELECT * FROM coordinator_auth_link_audit_log").all()).toEqual([]);
			},
		);

		test.for([
			...ACCEPTED_ALIASES.map((key) => ({ ...key, relevant: true })),
			...MALFORMED_KEYS.map((key) => ({ ...key, relevant: false })),
			{ name: "unknown fingerprint without enrollment key", publicKey: null, relevant: false },
		])(
			"uses verified canonical key semantics for $name",
			async ({ publicKey, relevant }, { f }) => {
				// Arrange: a different device/fingerprint cannot imply key identity by itself.
				const fingerprint = "8".repeat(64);
				if (publicKey !== null)
					await enroll(
						f.store,
						review({ groupId: "alias", deviceId: "alias-device", publicKey, fingerprint }),
					);
				history(f, { device: "old-device", fingerprint });
				const before = snapshot(f);
				// Act
				const preview = await (await request(appFor(f))).json();
				// Assert
				expect(preview.state).toBe("ready");
				expect(preview.legacy_history).toHaveLength(relevant ? 1 : 0);
				expect(snapshot(f)).toEqual(before);
			},
		);
	});
	describe(`${backend} invalid history refusal`, () => {
		test.for([
			"canonical-bytes",
			"metadata",
			"malformed-json",
			"missing-fingerprint",
			"unsafe-fingerprint",
			"oversized",
			"record-cap",
		] as const)("refuses relevant %s history without mutation", async (invalid, { f }) => {
			// Arrange: retain the exact device reference so invalid evidence is relevant.
			const manifest = history(f);
			const json = corruptedJson(manifest, invalid);
			f.db.prepare("UPDATE coordinator_legacy_team_completions SET manifest_json=?").run(json);
			if (invalid === "metadata")
				f.db
					.prepare(
						"UPDATE coordinator_legacy_team_completions SET completed_at='2026-10-02T00:00:00.000Z'",
					)
					.run();
			if (invalid === "record-cap")
				for (let index = 0; index < 500; index++) history(f, { group: `cap-${index}` });
			const before = snapshot(f);
			const app = appFor(f);
			// Act
			const preview = await (await request(app)).json();
			const denied = await request(app, "b".repeat(64));
			// Assert
			expect(preview).toMatchObject({
				state: "needs_review",
				reasons: ["legacy_history_invalid"],
				legacy_history: [],
			});
			expect(preview.evidence_digest).toBeUndefined();
			expect(denied.status).toBe(409);
			expect(snapshot(f)).toEqual(before);
		});
	});
}
