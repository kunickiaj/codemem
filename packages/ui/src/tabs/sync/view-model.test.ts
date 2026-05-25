import { describe, expect, it } from "vitest";

import {
	deriveCoordinatorApprovalSummary,
	deriveDuplicatePeople,
	derivePeerAuthorizedDomainsView,
	derivePeerGrantRoleMismatchView,
	derivePeerProjectNarrowingView,
	derivePeerScopeRejectionsView,
	derivePeerTrustSummary,
	derivePeerUiStatus,
	deriveSyncViewModel,
	deriveVisiblePeopleActors,
	deviceNeedsFriendlyName,
	resolveFriendlyDeviceName,
	shouldShowCoordinatorReviewAction,
	summarizeSyncRunResult,
} from "./view-model";

describe("resolveFriendlyDeviceName", () => {
	it("prefers the explicit local name first", () => {
		expect(
			resolveFriendlyDeviceName({
				localName: "Work MacBook",
				coordinatorName: "Adam laptop",
				deviceId: "12345678-1234-1234-1234-123456789abc",
			}),
		).toBe("Work MacBook");
	});

	it("falls back to coordinator display name before raw device ids", () => {
		expect(
			resolveFriendlyDeviceName({
				localName: "",
				coordinatorName: "Desk Mini",
				deviceId: "12345678-1234-1234-1234-123456789abc",
			}),
		).toBe("Desk Mini");
	});

	it("uses a short fallback when nothing friendly exists", () => {
		expect(
			resolveFriendlyDeviceName({
				deviceId: "12345678-1234-1234-1234-123456789abc",
			}),
		).toBe("12345678");
	});
});

describe("deviceNeedsFriendlyName", () => {
	it("requires naming when no local or coordinator name exists", () => {
		expect(deviceNeedsFriendlyName({ deviceId: "12345678-1234-1234-1234-123456789abc" })).toBe(
			true,
		);
	});

	it("does not require naming when a friendly label already exists", () => {
		expect(
			deviceNeedsFriendlyName({
				localName: "Work MacBook",
				deviceId: "12345678-1234-1234-1234-123456789abc",
			}),
		).toBe(false);
	});
});

describe("derivePeerUiStatus", () => {
	it("flags unauthorized peers as needing re-pairing attention", () => {
		expect(
			derivePeerUiStatus({
				has_error: true,
				last_error: "peer status failed (401: unauthorized)",
				status: { peer_state: "degraded" },
			}),
		).toBe("needs-repair");
	});

	it("treats timeout-heavy peers as offline instead of generic repair", () => {
		expect(derivePeerUiStatus({ has_error: true, status: { peer_state: "online" } })).toBe(
			"needs-repair",
		);
		expect(
			derivePeerUiStatus({
				has_error: true,
				last_error: "all addresses failed | http://x: The operation was aborted due to timeout",
				status: { peer_state: "degraded" },
			}),
		).toBe("offline");
	});

	it("maps stale peers to offline", () => {
		expect(derivePeerUiStatus({ status: { peer_state: "stale" } })).toBe("offline");
	});
});

describe("derivePeerTrustSummary", () => {
	it("prioritizes current offline state over stale unauthorized history", () => {
		expect(
			derivePeerTrustSummary({
				last_error: "peer status failed (401: unauthorized)",
				status: { peer_state: "offline" },
				has_error: false,
			}).state,
		).toBe("offline");
	});

	it("surfaces re-pairing guidance when the remote device rejects us with unauthorized", () => {
		expect(
			derivePeerTrustSummary({
				last_error: "peer status failed (401: unauthorized)",
				status: { peer_state: "degraded" },
				has_error: true,
			}),
		).toEqual({
			state: "needs-repairing",
			badgeLabel: "Needs re-pairing",
			description:
				"This device no longer accepts this one. Pair again from the other device, or remove this local record if it no longer belongs here.",
			isWarning: true,
		});
	});

	it("treats timeout-heavy device errors as offline guidance", () => {
		expect(
			derivePeerTrustSummary({
				last_error: "all addresses failed | http://x: The operation was aborted due to timeout",
				status: { peer_state: "degraded" },
				has_error: true,
			}),
		).toEqual({
			state: "offline",
			badgeLabel: "Offline",
			description:
				"This device is saved here, but none of its last known addresses are responding right now.",
			isWarning: true,
		});
	});

	it("surfaces two-way trust once sync or ping succeeds", () => {
		expect(
			derivePeerTrustSummary({ status: { sync_status: "ok", peer_state: "online" } }).state,
		).toBe("mutual-trust");
	});
});

describe("derivePeerScopeRejectionsView", () => {
	it("returns an empty view when nothing has been rejected", () => {
		expect(derivePeerScopeRejectionsView({}).total).toBe(0);
		expect(derivePeerScopeRejectionsView({}).badgeLabel).toBeNull();
		expect(
			derivePeerScopeRejectionsView({
				scope_rejections: { total: 0, by_reason: {} },
			}).total,
		).toBe(0);
	});

	it("renders human-readable labels and orders reasons by count desc", () => {
		const view = derivePeerScopeRejectionsView({
			scope_rejections: {
				total: 4,
				by_reason: { missing_scope: 1, stale_epoch: 3 },
				last_at: "2026-05-03T00:00:00Z",
			},
		});
		expect(view.total).toBe(4);
		expect(view.badgeLabel).toBe("4 sync rejections");
		expect(view.reasons.map((entry) => [entry.reason, entry.count])).toEqual([
			["stale_epoch", 3],
			["missing_scope", 1],
		]);
		expect(view.reasons[0]?.label).toBe("Stale or revoked membership");
		expect(view.lastAt).toBe("2026-05-03T00:00:00Z");
	});

	it("uses singular badge label when there is exactly one rejection", () => {
		const view = derivePeerScopeRejectionsView({
			scope_rejections: { total: 1, by_reason: { missing_scope: 1 } },
		});
		expect(view.badgeLabel).toBe("1 sync rejection");
	});
});

describe("derivePeerAuthorizedDomainsView", () => {
	it("labels peers with no cached Space access", () => {
		const view = derivePeerAuthorizedDomainsView({ authorized_scopes: [] });

		expect(view.total).toBe(0);
		expect(view.badgeLabel).toBe("No Space access");
		expect(view.isWarning).toBe(true);
		expect(view.emptyMessage).toContain("No Space access grants exist");
		expect(view.emptyMessage).toContain("Advanced project filters cannot send data by themselves");
	});

	it("formats authorized Spaces without exposing membership internals", () => {
		const view = derivePeerAuthorizedDomainsView({
			authorized_scopes: [
				{
					authority_type: "coordinator",
					kind: "team",
					label: "Acme Work",
					role: "member",
					scope_id: "acme-work",
				},
				{
					authority_type: "local",
					kind: "personal",
					label: "Personal Devices",
					role: "member",
					scope_id: "personal-devices",
				},
			],
		});

		expect(view.badgeLabel).toBe("2 Spaces");
		expect(view.isWarning).toBe(false);
		expect(view.domains.map((domain) => domain.label)).toEqual(["Acme Work", "Personal Devices"]);
		expect(view.domains[0]?.detail).toBe("team · coordinator · member role");
	});

	it("does not promote raw Space ids when authorized Space labels are missing", () => {
		const view = derivePeerAuthorizedDomainsView({
			authorized_scopes: [
				{ authority_type: "coordinator", role: "member", scope_id: "team-alpha-default" },
			],
		});

		expect(view.badgeLabel).toBe("1 Space");
		expect(view.domains[0]?.label).toBe("Untitled Space");
		expect(view.domains[0]?.label).not.toContain("team-alpha-default");
		expect(view.domains[0]?.detail).not.toContain("team-alpha-default");
	});
});

describe("derivePeerGrantRoleMismatchView", () => {
	it("flags coordinator-discovered peers with personal or OSS grants but no work/client-like grant", () => {
		const view = derivePeerGrantRoleMismatchView({
			authorized_scopes: [
				{ label: "Personal", scope_id: "personal" },
				{ label: "OSS", scope_id: "oss" },
			],
			discovered_via_group_id: "team-alpha",
		});

		expect(view.isVisible).toBe(true);
		expect(view.badgeLabel).toBe("Review Space fit");
		expect(view.message).toContain("personal or OSS Space access");
		expect(view.message).toContain("no separate work/client-like Space access");
		expect(view.detail).toContain("advanced project filters only narrow already-authorized Spaces");
	});

	it("does not flag peers once a separate work/client-like grant is present", () => {
		const view = derivePeerGrantRoleMismatchView({
			authorized_scopes: [
				{ label: "Personal", scope_id: "personal" },
				{ label: "Work Client", scope_id: "client-work" },
			],
			discovered_via_group_id: "team-alpha",
		});

		expect(view.isVisible).toBe(false);
	});

	it("counts local work scopes as valid work/client-like grants", () => {
		const view = derivePeerGrantRoleMismatchView({
			authorized_scopes: [
				{ authority_type: "local", label: "Personal", scope_id: "personal" },
				{ authority_type: "local", label: "Work Client", scope_id: "client-work" },
			],
			discovered_via_group_id: "team-alpha",
		});

		expect(view.isVisible).toBe(false);
	});

	it("counts explicitly work-like local scope names as valid grants", () => {
		const view = derivePeerGrantRoleMismatchView({
			authorized_scopes: [
				{ authority_type: "local", label: "Personal", scope_id: "personal" },
				{ authority_type: "local", label: "Local Work", scope_id: "local-client" },
			],
			discovered_via_group_id: "team-alpha",
		});

		expect(view.isVisible).toBe(false);
	});

	it("does not treat substring matches inside work domain names as personal grants", () => {
		const view = derivePeerGrantRoleMismatchView({
			authorized_scopes: [{ label: "Acme Work", scope_id: "acme-work" }],
			discovered_via_group_id: "team-alpha",
		});

		expect(view.isVisible).toBe(false);
	});

	it("does not treat substring matches inside public-looking names as OSS grants", () => {
		const view = derivePeerGrantRoleMismatchView({
			authorized_scopes: [{ label: "Publicis Client", scope_id: "publicis-client" }],
			discovered_via_group_id: "team-alpha",
		});

		expect(view.isVisible).toBe(false);
	});

	it("does not infer role mismatches without coordinator or group context", () => {
		const view = derivePeerGrantRoleMismatchView({
			authorized_scopes: [{ label: "Personal", scope_id: "personal" }],
		});

		expect(view.isVisible).toBe(false);
	});
});

describe("derivePeerProjectNarrowingView", () => {
	it("explains project filters as narrowing instead of grants", () => {
		const view = derivePeerProjectNarrowingView({
			effective_exclude: ["personal"],
			effective_include: ["*"],
			inherits_global: true,
		});

		expect(view.summary).toBe("Global defaults. Include filter: *; Exclude filter: personal.");
		expect(view.statusLabel).toBe("Advanced filters active");
		expect(view.hasAdvancedFilters).toBe(true);
		expect(view.note).toContain("only narrow data after Space access");
		expect(view.note).toContain("never grant access to another Space");
	});

	it("treats all-project/no-exclusion defaults as no advanced filters", () => {
		const view = derivePeerProjectNarrowingView({
			effective_exclude: [],
			effective_include: ["*"],
			inherits_global: true,
		});

		expect(view.statusLabel).toBe("No advanced filters");
		expect(view.hasAdvancedFilters).toBe(false);
	});
});

describe("deriveCoordinatorApprovalSummary", () => {
	it("flags coordinator devices that need approval on this device", () => {
		expect(
			deriveCoordinatorApprovalSummary({
				device: { device_id: "peer-a", needs_local_approval: true },
				pairedLocally: false,
			}),
		).toEqual({
			state: "needs-your-approval",
			badgeLabel: "Needs your approval",
			description:
				"Another device already approved this pairing. Approve it here to finish the connection on both sides.",
			actionLabel: "Approve on this device",
		});
	});

	it("flags coordinator devices that are still waiting on the other device", () => {
		expect(
			deriveCoordinatorApprovalSummary({
				device: { device_id: "peer-a", waiting_for_peer_approval: true },
				pairedLocally: true,
			}),
		).toEqual({
			state: "waiting-for-other-device",
			badgeLabel: "Waiting on other device",
			description:
				"You already approved this pairing here. The other device still needs to approve this one before sync can work both ways.",
			actionLabel: null,
		});
	});

	it("still flags devices that need local approval after a prior local peer record exists", () => {
		expect(
			deriveCoordinatorApprovalSummary({
				device: { device_id: "peer-a", needs_local_approval: true },
				pairedLocally: true,
			}),
		).toEqual({
			state: "needs-your-approval",
			badgeLabel: "Needs your approval",
			description:
				"Another device already approved this pairing. Approve it here to finish the connection on both sides.",
			actionLabel: "Approve on this device",
		});
	});
});

describe("shouldShowCoordinatorReviewAction", () => {
	it("keeps rejoined devices actionable when reciprocal local approval is still needed", () => {
		expect(
			shouldShowCoordinatorReviewAction({
				device: {
					device_id: "peer-a",
					fingerprint: "fp-a",
					needs_local_approval: true,
				},
				pairedLocally: true,
			}),
		).toBe(true);
	});

	it("keeps already-paired devices hidden when they are only waiting on the other side", () => {
		expect(
			shouldShowCoordinatorReviewAction({
				device: {
					device_id: "peer-a",
					fingerprint: "fp-a",
					waiting_for_peer_approval: true,
				},
				pairedLocally: true,
			}),
		).toBe(false);
	});
});

describe("summarizeSyncRunResult", () => {
	it("summarizes mixed failures without pretending they are all one-way trust", () => {
		expect(
			summarizeSyncRunResult({
				items: [
					{
						peer_device_id: "a",
						ok: false,
						error: "peer status failed (401: unauthorized)",
						opsIn: 0,
						opsOut: 0,
						addressErrors: [],
					},
					{
						peer_device_id: "b",
						ok: false,
						error: "connection refused",
						opsIn: 0,
						opsOut: 0,
						addressErrors: [],
					},
					{ peer_device_id: "c", ok: true, opsIn: 2, opsOut: 1, addressErrors: [] },
				],
			}),
		).toEqual({
			ok: false,
			message:
				"2 of 3 device sync attempts failed. Open the affected device cards for the specific errors.",
			warning: true,
		});
	});

	it("turns unauthorized sync failures into a re-pairing message", () => {
		expect(
			summarizeSyncRunResult({
				items: [
					{
						peer_device_id: "peer-a",
						ok: false,
						error: "all addresses failed | http://x: peer status failed (401: unauthorized)",
						opsIn: 0,
						opsOut: 0,
						addressErrors: [],
					},
				],
			}),
		).toEqual({
			ok: false,
			message:
				"This device no longer has two-way trust with the peer. Pair it again from the other device, or remove the stale local record if it should be gone.",
			warning: true,
		});
	});

	it("routes scope_rejected failures to the Teams Space-access message", () => {
		expect(
			summarizeSyncRunResult({
				items: [
					{
						peer_device_id: "peer-a",
						ok: false,
						error:
							"all addresses failed | http://x: peer ops push failed (403: scope_rejected:stale_epoch)",
						opsIn: 0,
						opsOut: 0,
						addressErrors: [],
					},
				],
			}),
		).toEqual({
			ok: false,
			message:
				"Sync ran, but the peer is not authorized for one or more Spaces. Review Space access for this device in Teams, then sync again.",
			warning: true,
		});
	});

	it("routes scoped sync incomplete failures to the Teams Space-access message", () => {
		expect(
			summarizeSyncRunResult({
				items: [
					{
						peer_device_id: "peer-a",
						ok: false,
						error: "scoped sync incomplete: oss=reset_required:missing_scope",
						opsIn: 2,
						opsOut: 0,
						addressErrors: [],
					},
				],
			}),
		).toEqual({
			ok: false,
			message:
				"Sync ran, but the peer is not authorized for one or more Spaces. Review Space access for this device in Teams, then sync again.",
			warning: true,
		});
	});

	it("keeps non-membership scoped sync incomplete failures generic", () => {
		expect(
			summarizeSyncRunResult({
				items: [
					{
						peer_device_id: "peer-a",
						ok: false,
						error: "scoped sync incomplete: oss=peer scoped ops fetch failed (503: unavailable)",
						opsIn: 2,
						opsOut: 0,
						addressErrors: [],
					},
				],
			}),
		).toEqual({
			ok: false,
			message: "scoped sync incomplete: oss=peer scoped ops fetch failed (503: unavailable)",
			warning: true,
		});
	});

	it("falls back to the mixed-failure summary when trust and scope failures coexist", () => {
		expect(
			summarizeSyncRunResult({
				items: [
					{
						peer_device_id: "peer-a",
						ok: false,
						error: "peer status failed (401: unauthorized)",
						opsIn: 0,
						opsOut: 0,
						addressErrors: [],
					},
					{
						peer_device_id: "peer-b",
						ok: false,
						error: "peer ops push failed (403: scope_rejected:stale_epoch)",
						opsIn: 0,
						opsOut: 0,
						addressErrors: [],
					},
					{ peer_device_id: "peer-c", ok: true, opsIn: 1, opsOut: 1, addressErrors: [] },
				],
			}),
		).toEqual({
			ok: false,
			message:
				"2 of 3 device sync attempts failed. Open the affected device cards for the specific errors.",
			warning: true,
		});
	});

	it("surfaces outbound filter diagnostics without treating them as failed sync", () => {
		expect(
			summarizeSyncRunResult({
				items: [
					{
						peer_device_id: "peer-a",
						ok: true,
						opsIn: 0,
						opsOut: 0,
						opsSkipped: 3,
						skipped_out: { reason: "project_filter", skipped_count: 3, project: "private" },
						addressErrors: [],
					},
				],
			}),
		).toEqual({
			ok: true,
			message:
				"3 outbound ops were filtered: 3 by project filter. No payload was sent for filtered data.",
			warning: true,
		});
	});

	it("splits outbound filter diagnostics by reason", () => {
		expect(
			summarizeSyncRunResult({
				items: [
					{
						peer_device_id: "peer-a",
						ok: true,
						opsIn: 0,
						opsOut: 0,
						opsSkipped: 2,
						skipped_out: { reason: "project_filter", skipped_count: 2, project: "private" },
						addressErrors: [],
					},
					{
						peer_device_id: "peer-b",
						ok: true,
						opsIn: 0,
						opsOut: 0,
						opsSkipped: 1,
						skipped_out: { reason: "visibility_filter", skipped_count: 1, visibility: "private" },
						addressErrors: [],
					},
				],
			}),
		).toEqual({
			ok: true,
			message:
				"3 outbound ops were filtered: 2 by project filter, 1 by visibility. No payload was sent for filtered data.",
			warning: true,
		});
	});
});

describe("deriveDuplicatePeople", () => {
	it("groups duplicate display names and preserves local involvement", () => {
		expect(
			deriveDuplicatePeople([
				{ actor_id: "actor-local", display_name: "Adam", is_local: true },
				{ actor_id: "actor-remote", display_name: "Adam", is_local: false },
				{ actor_id: "actor-other", display_name: "Pat", is_local: false },
			]),
		).toEqual([
			{
				displayName: "Adam",
				actorIds: ["actor-local", "actor-remote"],
				includesLocal: true,
			},
		]);
	});
});

describe("deriveVisiblePeopleActors", () => {
	it("hides unresolved zero-device duplicates of the local person from the people list", () => {
		expect(
			deriveVisiblePeopleActors({
				actors: [
					{ actor_id: "actor-local", display_name: "Adam", is_local: true },
					{ actor_id: "actor-shadow", display_name: "Adam", is_local: false },
					{ actor_id: "actor-other", display_name: "Pat", is_local: false },
				],
				peers: [],
				duplicatePeople: [
					{
						displayName: "Adam",
						actorIds: ["actor-local", "actor-shadow"],
						includesLocal: true,
					},
				],
			}),
		).toEqual({
			visibleActors: [
				{ actor_id: "actor-local", display_name: "Adam", is_local: true },
				{ actor_id: "actor-other", display_name: "Pat", is_local: false },
			],
			hiddenLocalDuplicateCount: 1,
		});
	});

	it("keeps duplicate rows visible when the non-local duplicate already owns devices", () => {
		expect(
			deriveVisiblePeopleActors({
				actors: [
					{ actor_id: "actor-local", display_name: "Adam", is_local: true },
					{ actor_id: "actor-remote", display_name: "Adam", is_local: false },
				],
				peers: [{ actor_id: "actor-remote" }],
				duplicatePeople: [
					{
						displayName: "Adam",
						actorIds: ["actor-local", "actor-remote"],
						includesLocal: true,
					},
				],
			}),
		).toEqual({
			visibleActors: [
				{ actor_id: "actor-local", display_name: "Adam", is_local: true },
				{ actor_id: "actor-remote", display_name: "Adam", is_local: false },
			],
			hiddenLocalDuplicateCount: 0,
		});
	});
});

describe("deriveSyncViewModel", () => {
	it("creates attention items for duplicates and device issues that need review", () => {
		const view = deriveSyncViewModel({
			actors: [
				{ actor_id: "actor-local", display_name: "Adam", is_local: true },
				{ actor_id: "actor-remote", display_name: "Adam", is_local: false },
			],
			peers: [
				{
					peer_device_id: "peer-1",
					name: "",
					has_error: true,
					last_error: "all addresses failed",
					status: { peer_state: "degraded" },
					fingerprint: "fp-old",
				},
			],
			coordinator: {
				discovered_devices: [
					{
						device_id: "peer-1",
						display_name: "",
						stale: false,
						fingerprint: "fp-new",
					},
					{
						device_id: "peer-2",
						display_name: "Desk Mini",
						stale: false,
						fingerprint: "fp-2",
					},
				],
			},
		});

		expect(view.summary).toEqual({
			connectedDeviceCount: 0,
			seenOnTeamCount: 2,
			offlineTeamDeviceCount: 0,
		});
		expect(view.attentionItems.map((item) => item.kind)).toEqual([
			"possible-duplicate-person",
			"device-needs-repair",
		]);
		expect(view.attentionItems[1]).toMatchObject({
			title: "peer-1 needs review",
		});
	});

	it("hides duplicate-person attention when the user already marked them as different people", () => {
		const view = deriveSyncViewModel({
			actors: [
				{ actor_id: "actor-local", display_name: "Adam", is_local: true },
				{ actor_id: "actor-remote", display_name: "Adam", is_local: false },
			],
			duplicatePersonDecisions: {
				"actor-local::actor-remote": "different-people",
			},
		});

		expect(view.duplicatePeople).toEqual([]);
		expect(view.attentionItems).toEqual([]);
	});

	it("does not count a stale coordinator record as offline when the paired peer is actively connected", () => {
		const view = deriveSyncViewModel({
			peers: [
				{
					peer_device_id: "peer-1",
					status: { peer_state: "online", fresh: true, sync_status: "ok" },
				},
			],
			coordinator: {
				discovered_devices: [
					{
						device_id: "peer-1",
						display_name: "Desk Mini",
						stale: true,
						fingerprint: "fp-1",
					},
				],
			},
		});

		expect(view.summary).toEqual({
			connectedDeviceCount: 1,
			seenOnTeamCount: 1,
			offlineTeamDeviceCount: 0,
		});
	});
});

describe("shouldShowCoordinatorReviewAction", () => {
	it("allows fresh unpaired discovered devices without a visible fingerprint", () => {
		expect(
			shouldShowCoordinatorReviewAction({
				device: { device_id: "peer-1", stale: false },
				pairedLocally: false,
			}),
		).toBe(true);
	});
});
