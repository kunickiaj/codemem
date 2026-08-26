import {
	canonicalWorkspaceIdentity,
	fingerprintPublicKey,
	getLegacyTeamSetupDraft,
	legacyTeamCandidateId,
	MemoryStore,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import { __teamSetupTestHooks, teamSetupRoutes } from "./team-setup.js";

function createRouteStore(): { store: MemoryStore; close: () => void } {
	const store = new MemoryStore(":memory:");
	return { store, close: () => store.close() };
}

describe("Team setup roster loading", () => {
	it("reuses successful summary snapshots until the cache expires", async () => {
		let now = 1_000;
		const snapshots = [{ groupId: "group-alpha" }] as never;
		const source = vi.fn(async () => snapshots);
		const load = __teamSetupTestHooks.createCachedSnapshotLoader(source, 30_000, () => now);

		await expect(Promise.all([load(), load()])).resolves.toEqual([snapshots, snapshots]);
		await expect(load()).resolves.toBe(snapshots);
		expect(source).toHaveBeenCalledTimes(1);

		now += 30_000;
		await expect(load()).resolves.toBe(snapshots);
		expect(source).toHaveBeenCalledTimes(2);
	});

	it("retries summary snapshot loading after a failure", async () => {
		const snapshots = [{ groupId: "group-alpha" }] as never;
		const source = vi
			.fn<() => Promise<typeof snapshots>>()
			.mockRejectedValueOnce(new Error("temporarily unavailable"))
			.mockResolvedValueOnce(snapshots);
		const load = __teamSetupTestHooks.createCachedSnapshotLoader(source, 30_000);

		await expect(load()).rejects.toThrow("temporarily unavailable");
		await expect(load()).resolves.toBe(snapshots);
		expect(source).toHaveBeenCalledTimes(2);
	});

	it("retries an in-flight summary after invalidation", async () => {
		let resolveFirst: ((snapshots: never) => void) | undefined;
		const staleSnapshots = [{ groupId: "stale" }] as never;
		const freshSnapshots = [{ groupId: "fresh" }] as never;
		const source = vi
			.fn<() => Promise<typeof freshSnapshots>>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockResolvedValue(freshSnapshots);
		const load = __teamSetupTestHooks.createCachedSnapshotLoader(source, 30_000);

		const staleLoad = load();
		load.invalidate();
		const freshLoad = load();
		resolveFirst?.(staleSnapshots);

		await expect(staleLoad).resolves.toBe(freshSnapshots);
		await expect(freshLoad).resolves.toBe(freshSnapshots);
		await expect(load()).resolves.toBe(freshSnapshots);
		expect(source).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ configuredTimeoutS: 17, expectedTimeoutS: 17 },
		{ configuredTimeoutS: 0, expectedTimeoutS: 1 },
	])("uses normalized coordinator settings with timeout $expectedTimeoutS", async ({
		configuredTimeoutS,
		expectedTimeoutS,
	}) => {
		const publicKey = "public-key-a";
		const listGroups = vi.fn(async () => [
			{
				group_id: "group-alpha",
				display_name: "Migration Team",
				archived_at: null,
				created_at: "2026-08-24T00:00:00.000Z",
			},
		]);
		const listDevices = vi.fn(async () => [
			{
				group_id: "group-alpha",
				device_id: "device-a",
				public_key: publicKey,
				fingerprint: fingerprintPublicKey(publicKey),
				identity_id: null,
				display_name: "Laptop",
				enabled: 1,
				created_at: "2026-08-24T00:00:00.000Z",
			},
		]);

		const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
			readConfig: () => ({
				...readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "localhost:8787/",
				syncCoordinatorGroups: ["group-alpha"],
				syncCoordinatorAdminSecret: "private-admin-secret",
				syncCoordinatorTimeoutS: configuredTimeoutS,
			}),
			listGroups,
			listDevices,
		});

		expect(snapshots[0]?.coordinatorId).toBe("http://localhost:8787");
		expect(listGroups).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteUrl: "http://localhost:8787",
				timeoutS: expectedTimeoutS,
			}),
		);
		expect(listDevices).toHaveBeenCalledWith(
			expect.objectContaining({
				remoteUrl: "http://localhost:8787",
				timeoutS: expectedTimeoutS,
			}),
		);
	});

	it("canonicalizes equivalent coordinator URLs while preserving non-root paths", () => {
		expect(__teamSetupTestHooks.normalizedCoordinatorId("HTTP://LOCALHOST:80/")).toBe(
			"http://localhost",
		);
		expect(
			__teamSetupTestHooks.normalizedCoordinatorId("HTTPS://EXAMPLE.COM:443/coordinator/"),
		).toBe("https://example.com/coordinator");
		expect(__teamSetupTestHooks.normalizedCoordinatorId("https://example.com/other")).toBe(
			"https://example.com/other",
		);
		expect(__teamSetupTestHooks.normalizedCoordinatorId("http://[")).toBeNull();
		expect(__teamSetupTestHooks.normalizedCoordinatorId("ftp://example.com")).toBeNull();
		expect(__teamSetupTestHooks.normalizedCoordinatorId("http://user@localhost:8787")).toBeNull();
	});

	it("uses normalization only for matching and preserves configured candidate identity", async () => {
		const { store, close } = createRouteStore();
		const configuredCoordinatorId = "HTTP://LOCALHOST:80";
		const now = "2026-08-26T00:00:00.000Z";
		try {
			store.db
				.prepare(
					`INSERT INTO replication_scopes(
					 scope_id, label, kind, authority_type, coordinator_id, group_id,
					 membership_epoch, status, created_at, updated_at
					 ) VALUES ('configured-scope', 'Configured', 'team', 'coordinator',
					 'http://localhost', 'configured', 1, 'active', ?, ?)`,
				)
				.run(now, now);
			const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
				{
					readConfig: () => ({
						...readCoordinatorSyncConfig({}),
						syncCoordinatorUrl: `${configuredCoordinatorId}/`,
						syncCoordinatorGroups: ["configured"],
						syncCoordinatorAdminSecret: "private-admin-secret",
					}),
					listGroups: async () => [
						{
							group_id: "configured",
							display_name: "Configured",
							archived_at: null,
							created_at: now,
						},
					],
					listDevices: async () => [],
				},
				{},
				() => store,
			);

			expect(snapshots).toEqual([
				expect.objectContaining({
					groupId: "configured",
					coordinatorId: configuredCoordinatorId,
				}),
			]);
		} finally {
			close();
		}
	});

	it("keeps configured candidates when local scope evidence cannot be read", async () => {
		const now = "2026-08-26T00:00:00.000Z";
		const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
			{
				readConfig: () => ({
					...readCoordinatorSyncConfig({}),
					syncCoordinatorUrl: "http://localhost:8787",
					syncCoordinatorGroups: ["configured"],
					syncCoordinatorAdminSecret: "private-admin-secret",
				}),
				listGroups: async () => [
					{
						group_id: "configured",
						display_name: "Configured",
						archived_at: null,
						created_at: now,
					},
				],
				listDevices: async () => [],
			},
			{},
			() => {
				throw new Error("scope store unavailable");
			},
		);

		expect(snapshots).toEqual([
			expect.objectContaining({
				groupId: "configured",
				coordinatorId: "http://localhost:8787",
			}),
		]);
	});

	it("preserves no-config emptiness while partial and empty complete config fail closed", async () => {
		const base = readCoordinatorSyncConfig({});
		const dependencies = {
			readConfig: () => ({
				...base,
				syncCoordinatorUrl: "",
				syncCoordinatorGroups: [],
				syncCoordinatorAdminSecret: "",
			}),
			listGroups: vi.fn(async () => []),
			listDevices: vi.fn(async () => []),
		};

		await expect(
			__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(dependencies),
		).resolves.toEqual([]);
		dependencies.readConfig = () => ({
			...base,
			syncCoordinatorUrl: "http://localhost:8787",
			syncCoordinatorGroups: [],
			syncCoordinatorAdminSecret: "",
		});
		await expect(
			__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(dependencies),
		).rejects.toThrow("team_setup_roster_unavailable");
		dependencies.readConfig = () => ({
			...base,
			syncCoordinatorUrl: "http://localhost:8787",
			syncCoordinatorGroups: [],
			syncCoordinatorAdminSecret: "private-admin-secret",
		});
		await expect(
			__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(dependencies),
		).rejects.toThrow("team_setup_roster_unavailable");
		expect(dependencies.listGroups).not.toHaveBeenCalled();
	});

	it("discovers configured and active locally evidenced groups without inferring membership", async () => {
		const { store, close } = createRouteStore();
		const coordinatorId = "http://localhost:8787";
		const rawCoordinatorId = "localhost:8787/";
		const now = "2026-08-26T00:00:00.000Z";
		try {
			const insertScope = store.db.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES (?, ?, 'team', ?, ?, ?, 1, ?, ?, ?)`,
			);
			insertScope.run(
				"scope-sre",
				"SRE",
				"coordinator",
				rawCoordinatorId,
				"sre",
				"active",
				now,
				now,
			);
			insertScope.run(
				"scope-sre-duplicate",
				"SRE duplicate",
				"coordinator",
				rawCoordinatorId,
				" sre ",
				"active",
				now,
				now,
			);
			insertScope.run(
				"scope-unrelated-inactive",
				"Unrelated",
				"coordinator",
				coordinatorId,
				"unrelated",
				"inactive",
				now,
				now,
			);
			insertScope.run(
				"scope-unrelated-local",
				"Unrelated",
				"local",
				coordinatorId,
				"unrelated",
				"active",
				now,
				now,
			);
			insertScope.run(
				"scope-unrelated-other",
				"Unrelated",
				"coordinator",
				"http://other-coordinator:8787",
				"unrelated",
				"active",
				now,
				now,
			);
			insertScope.run(
				"scope-malformed-coordinator",
				"Malformed coordinator",
				"coordinator",
				"http://[",
				"malformed-only",
				"active",
				now,
				now,
			);
			store.db
				.prepare(
					`INSERT INTO replication_scopes(
					 scope_id, label, kind, authority_type, coordinator_id, group_id,
					 membership_epoch, status, created_at, updated_at
					 ) VALUES ('scope-managed-only', 'Managed only', 'managed_project', 'coordinator',
					 ?, 'managed-only', 1, 'active', ?, ?)`,
				)
				.run(rawCoordinatorId, now, now);
			const projectIdentity = canonicalWorkspaceIdentity({ project: "sre-project" }).value;
			const sessionId = Number(
				store.db
					.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'sre-project')")
					.run(now).lastInsertRowid,
			);
			store.db
				.prepare(
					`INSERT INTO memory_items(
					 session_id, kind, title, body_text, active, created_at, updated_at,
					 visibility, project, scope_id
					 ) VALUES (?, 'discovery', 'SRE Project', 'body', 1, ?, ?, 'shared',
					 'sre-project', 'scope-sre')`,
				)
				.run(sessionId, now, now);
			store.db
				.prepare(
					`INSERT INTO project_scope_mappings(
					 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
					 ) VALUES (?, ?, 'scope-sre', 1000, 'test', ?, ?)`,
				)
				.run(projectIdentity, projectIdentity, now, now);

			const groups = [
				{ group_id: "nerdworld", display_name: "Nerdworld", archived_at: null, created_at: now },
				{ group_id: "sre", display_name: "SRE", archived_at: null, created_at: now },
				{
					group_id: "managed-only",
					display_name: "Managed only",
					archived_at: null,
					created_at: now,
				},
				{
					group_id: "malformed-only",
					display_name: "Malformed coordinator",
					archived_at: null,
					created_at: now,
				},
				{ group_id: "unrelated", display_name: "Unrelated", archived_at: null, created_at: now },
			];
			const listDevices = vi.fn(async ({ groupId }: { groupId: string }) => {
				const count = groupId === "sre" ? 6 : 1;
				return Array.from({ length: count }, (_, index) => {
					const publicKey = `${groupId}-public-key-${index}`;
					return {
						group_id: groupId,
						device_id: `${groupId}-device-${index}`,
						public_key: publicKey,
						fingerprint: fingerprintPublicKey(publicKey),
						identity_id: null,
						display_name: `${groupId} device ${index + 1}`,
						enabled: groupId === "sre" && index === count - 1 ? 0 : 1,
						created_at: now,
					};
				});
			});
			const app = teamSetupRoutes({
				getStore: () => store,
				snapshotLoaderDependencies: {
					readConfig: () => ({
						...readCoordinatorSyncConfig({}),
						syncCoordinatorUrl: coordinatorId,
						syncCoordinatorGroups: ["nerdworld"],
						syncCoordinatorAdminSecret: "private-admin-secret",
					}),
					listGroups: async () => groups,
					listDevices,
				},
			});

			const response = await app.request("/api/sync/team-setup/v1");
			expect(response.status).toBe(200);
			const summary = (await response.json()) as {
				candidates: Array<{
					candidateRef: string;
					displayName: string;
					deviceCount: number;
					projectCount: number;
				}>;
			};
			expect(summary.candidates.map((candidate) => candidate.displayName).toSorted()).toEqual([
				"Nerdworld",
				"SRE",
			]);
			expect(summary.candidates.some((candidate) => candidate.displayName === "Unrelated")).toBe(
				false,
			);
			expect(summary.candidates.some((candidate) => candidate.displayName === "Managed only")).toBe(
				false,
			);
			expect(
				summary.candidates.some((candidate) => candidate.displayName === "Malformed coordinator"),
			).toBe(false);
			const sreCandidate = summary.candidates.find((candidate) => candidate.displayName === "SRE");
			expect(sreCandidate?.candidateRef).toBe(legacyTeamCandidateId(rawCoordinatorId, "sre"));
			expect(sreCandidate?.deviceCount).toBe(6);
			expect(sreCandidate?.projectCount).toBe(1);
			const sreDraft = getLegacyTeamSetupDraft(store.db, sreCandidate?.candidateRef ?? "");
			expect(sreDraft?.devices).toHaveLength(6);
			expect(sreDraft?.projects).toEqual([expect.objectContaining({ displayName: "sre-project" })]);
			expect(sreDraft?.devices.every((device) => device.decision === "unresolved")).toBe(true);
			expect(sreDraft?.devices.every((device) => device.targetIdentityId === null)).toBe(true);
			expect(sreDraft?.devices.filter((device) => !device.enabled)).toHaveLength(1);
			const detail = await app.request(
				`/api/sync/team-setup/v1/${legacyTeamCandidateId(rawCoordinatorId, "sre")}`,
			);
			expect(detail.status).toBe(200);
			expect(store.db.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get()).toBe(
				0,
			);
			expect(listDevices.mock.calls.map(([input]) => input.groupId).toSorted()).toEqual([
				"nerdworld",
				"sre",
				"sre",
			]);
		} finally {
			close();
		}
	});

	it("prioritizes configured groups and deterministically truncates excess scope evidence", async () => {
		const { store, close } = createRouteStore();
		const coordinatorId = "http://localhost:8787";
		const now = "2026-08-26T00:00:00.000Z";
		try {
			const insertScope = store.db.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES (?, ?, 'team', 'coordinator', ?, ?, 1, 'active', ?, ?)`,
			);
			insertScope.run(
				"scope-configured-overlap",
				"Configured overlap",
				coordinatorId,
				"configured-00",
				now,
				now,
			);
			for (let index = 0; index < 40; index += 1) {
				const suffix = index.toString().padStart(2, "0");
				insertScope.run(
					`scope-evidenced-${suffix}`,
					`Evidenced ${index}`,
					coordinatorId,
					`evidenced-${suffix}`,
					now,
					now,
				);
			}
			let configuredGroups = Array.from(
				{ length: 13 },
				(_, index) => `configured-${index.toString().padStart(2, "0")}`,
			);
			const config = {
				...readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: coordinatorId,
				get syncCoordinatorGroups() {
					return configuredGroups;
				},
				syncCoordinatorAdminSecret: "private-admin-secret",
			};
			const evidencedGroups = Array.from({ length: 40 }, (_, index) => {
				const suffix = index.toString().padStart(2, "0");
				return `evidenced-${suffix}`;
			});
			const remoteGroups = [...configuredGroups, ...evidencedGroups].map((groupId) => ({
				group_id: groupId,
				display_name: groupId,
				archived_at: null,
				created_at: now,
			}));
			const dependencies = {
				readConfig: () => config,
				listGroups: vi.fn(async () => remoteGroups),
				listDevices: vi.fn(async () => []),
			};

			const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
				dependencies,
				{},
				() => store,
			);
			expect(snapshots.map((snapshot) => snapshot.groupId)).toEqual([
				...configuredGroups,
				...Array.from(
					{ length: 12 },
					(_, index) => `evidenced-${index.toString().padStart(2, "0")}`,
				),
			]);
			configuredGroups = Array.from({ length: 26 }, (_, index) => `configured-${index}`);
			await expect(
				__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
					dependencies,
					{},
					() => store,
				),
			).rejects.toThrow("team_setup_roster_unavailable");
		} finally {
			close();
		}
	});

	it("finds equivalent coordinator evidence within the bounded distinct-coordinator lookup", async () => {
		const { store, close } = createRouteStore();
		const coordinatorId = "http://localhost:8787";
		const now = "2026-08-26T00:00:00.000Z";
		try {
			const insertScope = store.db.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES (?, ?, 'team', 'coordinator', ?, ?, 1, 'active', ?, ?)`,
			);
			for (let index = 0; index < 99; index += 1) {
				insertScope.run(
					`scope-foreign-${index}`,
					`Foreign ${index}`,
					`http://foreign-${index}.example.invalid`,
					`foreign-${index}`,
					now,
					now,
				);
			}
			for (let index = 0; index < 101; index += 1) {
				insertScope.run(
					`scope-blank-group-${index}`,
					`Blank group ${index}`,
					`http://blank-group-${index}.example.invalid`,
					" ",
					now,
					now,
				);
			}
			insertScope.run("scope-equivalent", "SRE", "LOCALHOST:8787/", "sre", now, now);
			const dependencies = {
				readConfig: () => ({
					...readCoordinatorSyncConfig({}),
					syncCoordinatorUrl: coordinatorId,
					syncCoordinatorGroups: ["configured"],
					syncCoordinatorAdminSecret: "private-admin-secret",
				}),
				listGroups: vi.fn(async () => [
					{
						group_id: "configured",
						display_name: "Configured",
						archived_at: null,
						created_at: now,
					},
					{
						group_id: "sre",
						display_name: "SRE",
						archived_at: null,
						created_at: now,
					},
				]),
				listDevices: vi.fn(async () => []),
			};

			const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
				dependencies,
				{},
				() => store,
			);
			expect(snapshots.map((snapshot) => snapshot.groupId)).toEqual(["configured", "sre"]);
			expect(snapshots[1]?.coordinatorId).toBe("LOCALHOST:8787/");
			insertScope.run(
				"scope-foreign-overflow",
				"Foreign overflow",
				"http://foreign-overflow.example.invalid",
				"foreign-overflow",
				now,
				now,
			);
			await expect(
				__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
					dependencies,
					{},
					() => store,
				),
			).resolves.toEqual([
				expect.objectContaining({
					groupId: "configured",
					coordinatorId,
				}),
			]);
		} finally {
			close();
		}
	});

	it("omits an evidence-only group with ambiguous equivalent coordinator identities", async () => {
		const { store, close } = createRouteStore();
		const coordinatorId = "http://localhost:8787";
		const now = "2026-08-26T00:00:00.000Z";
		try {
			const insertScope = store.db.prepare(
				`INSERT INTO replication_scopes(
				 scope_id, label, kind, authority_type, coordinator_id, group_id,
				 membership_epoch, status, created_at, updated_at
				 ) VALUES (?, 'SRE', 'team', 'coordinator', ?, 'sre', 1, 'active', ?, ?)`,
			);
			insertScope.run("scope-sre-raw", "localhost:8787/", now, now);
			insertScope.run("scope-sre-canonical", coordinatorId, now, now);
			const listDevices = vi.fn(async () => []);

			const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
				{
					readConfig: () => ({
						...readCoordinatorSyncConfig({}),
						syncCoordinatorUrl: coordinatorId,
						syncCoordinatorGroups: ["configured"],
						syncCoordinatorAdminSecret: "private-admin-secret",
					}),
					listGroups: async () => [
						{
							group_id: "configured",
							display_name: "Configured",
							archived_at: null,
							created_at: now,
						},
						{
							group_id: "sre",
							display_name: "SRE",
							archived_at: null,
							created_at: now,
						},
					],
					listDevices,
				},
				{},
				() => store,
			);

			expect(snapshots.map((snapshot) => snapshot.groupId)).toEqual(["configured"]);
			expect(listDevices).toHaveBeenCalledTimes(1);
		} finally {
			close();
		}
	});

	it.each([
		"https://private.example.invalid/person",
		"/Users/private/person",
		"host.internal",
		"Person identity-secret-id",
		"Person ＩＤＥＮＴＩＴＹ－ＳＥＣＲＥＴ－ＩＤ",
		"ssh-rsa AAAAB3Nza private material",
	])("redacts unsafe active identity label %s", (label) => {
		expect(__teamSetupTestHooks.safeChoiceLabel(label, "Person", ["identity-secret-id"])).toBe(
			"Person",
		);
	});

	it("keeps bounded human identity labels", () => {
		expect(__teamSetupTestHooks.safeChoiceLabel("  Alex Example  ", "Person", ["actor-a"])).toBe(
			"Alex Example",
		);
	});

	it("adds a stable opaque disambiguator to redacted labels", () => {
		expect(
			__teamSetupTestHooks.safeChoiceLabel(
				"private.example.invalid",
				"Person",
				[],
				"legacy-team-viewer-identity-ref-v1:abcdef",
			),
		).toBe("Person abcdef");
	});

	it("adds stable opaque disambiguators when safe labels collide", () => {
		expect(
			__teamSetupTestHooks.disambiguateChoiceLabels(
				[
					{ displayName: "Alex Example", identityRef: "identity-ref-abcdef" },
					{ displayName: "alex example", identityRef: "identity-ref-123456" },
					{ displayName: "Blair Example", identityRef: "identity-ref-fedcba" },
				],
				(choice) => choice.identityRef,
			),
		).toEqual([
			{ displayName: "Alex Example abcdef", identityRef: "identity-ref-abcdef" },
			{ displayName: "alex example 123456", identityRef: "identity-ref-123456" },
			{ displayName: "Blair Example", identityRef: "identity-ref-fedcba" },
		]);
	});

	it("extends opaque disambiguators until final labels are globally unique", () => {
		expect(
			__teamSetupTestHooks.disambiguateChoiceLabels(
				[
					{ displayName: "Alex", identityRef: "identity-ref-xxabcdef" },
					{ displayName: "Alex", identityRef: "identity-ref-yyabcdef" },
					{ displayName: "Alex abcdef", identityRef: "identity-ref-zzzzzzzz" },
				],
				(choice) => choice.identityRef,
			),
		).toEqual([
			{ displayName: "Alex xxabcdef", identityRef: "identity-ref-xxabcdef" },
			{ displayName: "Alex yyabcdef", identityRef: "identity-ref-yyabcdef" },
			{ displayName: "Alex abcdef", identityRef: "identity-ref-zzzzzzzz" },
		]);
	});

	it("terminates when full-ref disambiguators collide with original labels", () => {
		expect(
			__teamSetupTestHooks.disambiguateChoiceLabels(
				[
					{ displayName: "Alex", identityRef: "a" },
					{ displayName: "Alex", identityRef: "b" },
					{ displayName: "Alex a", identityRef: "c" },
					{ displayName: "Alex a-1-1", identityRef: "d" },
				],
				(choice) => choice.identityRef,
			),
		).toEqual([
			{ displayName: "Alex a-1-2", identityRef: "a" },
			{ displayName: "Alex b", identityRef: "b" },
			{ displayName: "Alex a", identityRef: "c" },
			{ displayName: "Alex a-1-1", identityRef: "d" },
		]);
	});

	it("preserves oversized-roster errors for a direct candidate load", async () => {
		const coordinatorId = "http://localhost:8787";
		const groupId = "group-alpha";
		await expect(
			__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
				{
					readConfig: () => ({
						...readCoordinatorSyncConfig({}),
						syncCoordinatorUrl: coordinatorId,
						syncCoordinatorGroups: [groupId],
						syncCoordinatorAdminSecret: "private-admin-secret",
					}),
					listGroups: vi.fn(async () => [
						{
							group_id: groupId,
							display_name: "Migration Team",
							archived_at: null,
							created_at: "2026-08-24T00:00:00.000Z",
						},
					]),
					listDevices: vi.fn(async () => {
						throw new Error("coordinator_response_too_large");
					}),
				},
				{ candidateRef: legacyTeamCandidateId(coordinatorId, groupId) },
			),
		).rejects.toThrow("legacy_team_setup_roster_too_large");
	});

	it("keeps healthy summary candidates when another group roster is unavailable", async () => {
		const publicKey = "public-key-healthy";
		const listDevices = vi.fn(async ({ groupId }: { groupId: string }) => {
			if (groupId === "group-unavailable") throw new Error("private coordinator failure");
			return [
				{
					group_id: groupId,
					device_id: "device-healthy",
					public_key: publicKey,
					fingerprint: fingerprintPublicKey(publicKey),
					identity_id: null,
					display_name: "Healthy laptop",
					enabled: 1,
					created_at: "2026-08-24T00:00:00.000Z",
				},
			];
		});

		const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
			readConfig: () => ({
				...readCoordinatorSyncConfig({}),
				syncCoordinatorUrl: "http://localhost:8787",
				syncCoordinatorGroups: ["group-healthy", "group-unavailable"],
				syncCoordinatorAdminSecret: "private-admin-secret",
			}),
			listGroups: async () => [
				{
					group_id: "group-healthy",
					display_name: "Healthy Team",
					archived_at: null,
					created_at: "2026-08-24T00:00:00.000Z",
				},
				{
					group_id: "group-unavailable",
					display_name: "Unavailable Team",
					archived_at: null,
					created_at: "2026-08-24T00:00:00.000Z",
				},
			],
			listDevices,
		});

		expect(snapshots).toEqual([
			expect.objectContaining({ groupId: "group-healthy", displayName: "Healthy Team" }),
		]);
		expect(listDevices).toHaveBeenCalledTimes(2);
	});

	it.each([
		"archived",
		"deleted",
	])("treats a sole %s configured group as authoritative absence", async (state) => {
		const { store, close } = createRouteStore();
		const coordinatorId = "http://localhost:8787";
		const groupId = "group-absent";
		const listDevices = vi.fn(async () => []);
		try {
			const app = teamSetupRoutes({
				getStore: () => store,
				snapshotLoaderDependencies: {
					readConfig: () => ({
						...readCoordinatorSyncConfig({}),
						syncCoordinatorUrl: coordinatorId,
						syncCoordinatorGroups: [groupId],
						syncCoordinatorAdminSecret: "private-admin-secret",
					}),
					listGroups: async () =>
						state === "archived"
							? [
									{
										group_id: groupId,
										display_name: "Archived Team",
										archived_at: "2026-08-26T00:00:00.000Z",
										created_at: "2026-08-24T00:00:00.000Z",
									},
								]
							: [],
					listDevices,
				},
			});
			const summary = await app.request("/api/sync/team-setup/v1");
			expect(summary.status).toBe(200);
			expect(await summary.json()).toEqual({ version: 1, candidates: [] });
			const detail = await app.request(
				`/api/sync/team-setup/v1/${legacyTeamCandidateId(coordinatorId, groupId)}`,
			);
			expect(detail.status).toBe(404);
			expect(await detail.json()).toEqual({ error: "team_setup_confirmation_stale" });
			expect(listDevices).not.toHaveBeenCalled();
		} finally {
			close();
		}
	});

	it("fails safely when the sole current group metadata is malformed", async () => {
		await expect(
			__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith({
				readConfig: () => ({
					...readCoordinatorSyncConfig({}),
					syncCoordinatorUrl: "http://localhost:8787",
					syncCoordinatorGroups: ["group-malformed"],
					syncCoordinatorAdminSecret: "private-admin-secret",
				}),
				listGroups: async () => [
					{
						group_id: "group-malformed",
						display_name: 42 as unknown as string,
						archived_at: null,
						created_at: "2026-08-24T00:00:00.000Z",
					},
				],
				listDevices: vi.fn(async () => []),
			}),
		).rejects.toThrow("team_setup_roster_unavailable");
	});

	it("fails closed when the requested candidate roster is unavailable", async () => {
		const coordinatorId = "http://localhost:8787";
		const groupId = "group-unavailable";

		await expect(
			__teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
				{
					readConfig: () => ({
						...readCoordinatorSyncConfig({}),
						syncCoordinatorUrl: coordinatorId,
						syncCoordinatorGroups: [groupId],
						syncCoordinatorAdminSecret: "private-admin-secret",
					}),
					listGroups: async () => [
						{
							group_id: groupId,
							display_name: "Unavailable Team",
							archived_at: null,
							created_at: "2026-08-24T00:00:00.000Z",
						},
					],
					listDevices: async () => {
						throw new Error("private coordinator failure");
					},
				},
				{ candidateRef: legacyTeamCandidateId(coordinatorId, groupId) },
			),
		).rejects.toThrow("team_setup_roster_unavailable");
	});

	it("rejects mapping-choice responses that cannot include every opaque choice", () => {
		expect(() => __teamSetupTestHooks.requireCompleteMappingChoices(21, 500)).toThrow(
			"legacy_team_setup_roster_too_large",
		);
		expect(() => __teamSetupTestHooks.requireCompleteMappingChoices(20, 500)).not.toThrow();
	});

	it("loads only the requested candidate roster", async () => {
		const coordinatorId = "http://localhost:8787";
		const targetGroupId = "group-alpha";
		const unrelatedGroupId = "group-beta";
		const listDevices = vi.fn(async () => []);

		const snapshots = await __teamSetupTestHooks.loadConfiguredLegacyTeamGroupSnapshotsWith(
			{
				readConfig: () => ({
					...readCoordinatorSyncConfig({}),
					syncCoordinatorUrl: `${coordinatorId}/`,
					syncCoordinatorGroups: [targetGroupId, unrelatedGroupId],
					syncCoordinatorAdminSecret: "private-admin-secret",
				}),
				listGroups: async () => [
					{
						group_id: targetGroupId,
						display_name: "Migration Team",
						archived_at: null,
						created_at: "2026-08-24T00:00:00.000Z",
					},
					{
						group_id: unrelatedGroupId,
						display_name: "Archived Team",
						archived_at: "2026-08-23T00:00:00.000Z",
						created_at: "2026-08-22T00:00:00.000Z",
					},
				],
				listDevices,
			},
			{ candidateRef: legacyTeamCandidateId(coordinatorId, targetGroupId) },
		);

		expect(snapshots).toEqual([
			expect.objectContaining({ groupId: targetGroupId, displayName: "Migration Team" }),
		]);
		expect(listDevices).toHaveBeenCalledTimes(1);
		expect(listDevices).toHaveBeenCalledWith(expect.objectContaining({ groupId: targetGroupId }));
	});
});
