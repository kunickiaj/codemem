import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical } from "../../core/src/coordinator-legacy-team-completion.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import {
	completions,
	controllers,
	coordinatorId,
	db,
	exec,
	fullRecoveredRoster,
	futureGroup,
	insert,
	manifest,
	otherKey,
	recovery,
	reset,
	resolutions,
	rosterKey,
	signer,
	sourceGroup,
	state,
	timestamp,
} from "./legacy-completion-owner-proof-test-fixtures.js";

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await reset();
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
const domainDenial = /completion_(?:conflict|manifest_unavailable)/u;

it("native recovered A appends an unused slot while preserving A/B history, weak enrollment and Project actor", async () => {
	// Arrange: evidence collector and source verifier both validate real server-held rows.
	const { h, value } = await recovery();
	const before = await state({ excludeCompletion: true });
	const oldHistory = (await db.prepare(`SELECT * FROM ${completions} ORDER BY group_id`).all())
		.results;
	const started = performance.now();
	// Act
	const result = await h.complete(value);
	// Assert: no label, Project actor, grant, source or receipt gets rewritten.
	expect(result).toEqual({ status: "created", manifest: value });
	expect(h.bindCount()).toBeGreaterThan(0);
	expect(h.bindCount()).toBeLessThanOrEqual(100);
	expect(await state({ excludeCompletion: true })).toEqual(before);
	expect(
		(
			await db
				.prepare(`SELECT * FROM ${completions} WHERE group_id<>? ORDER BY group_id`)
				.bind(futureGroup)
				.all()
		).results,
	).toEqual(oldHistory);
	console.info(
		JSON.stringify({
			qualification: "native recovered INSERT",
			binds: h.bindCount(),
			elapsedMs: performance.now() - started,
		}),
	);
});

it.each(["B", "C"])("native retained A cannot authorize future owner %s", async (owner) => {
	// Arrange
	const { h } = await recovery();
	const before = await state();
	// Act
	const pending = h.complete(manifest(owner));
	// Assert
	await expect(pending).rejects.toThrow(domainDenial);
	expect(await state()).toEqual(before);
});

it.each(["missing", "revoked", "receipt mismatch"])(
	"native source %s cannot become metadata-only authority",
	async (change) => {
		// Arrange
		const { h, value } = await recovery();
		if (change === "missing") await exec(`DELETE FROM ${controllers}`);
		if (change === "revoked") await exec(`UPDATE ${controllers} SET revoked_at=?`, timestamp);
		if (change === "receipt mismatch")
			await exec(`UPDATE ${controllers} SET review_receipt_id='changed-receipt'`);
		const before = await state();
		// Act
		const pending = h.complete(value);
		// Assert
		await expect(pending).rejects.toThrow(domainDenial);
		expect(await state()).toEqual(before);
	},
);

it.each(["device", "key"])(
	"native positive recovery requires device AND canonical key, not %s alone",
	async (match) => {
		// Arrange
		const { h } = await recovery();
		const deviceId = match === "device" ? signer.deviceId : "different-device";
		const publicKey = match === "device" ? otherKey : signer.publicKey;
		await exec(
			"UPDATE enrolled_devices SET device_id=?,public_key=?,fingerprint=? WHERE group_id=?",
			deviceId,
			publicKey,
			fingerprintPublicKey(publicKey),
			futureGroup,
		);
		const before = await state();
		// Act
		const pending = h.complete(manifest("A", { deviceId, publicKey }));
		// Assert
		await expect(pending).rejects.toThrow(domainDenial);
		expect(await state()).toEqual(before);
	},
);

it.each(["device", "key"])(
	"native strong other-owner %s collision vetoes recovery",
	async (match) => {
		// Arrange: negative collisions deliberately use OR rather than the positive AND rule.
		const { h, value, source } = await recovery();
		await insert(controllers, {
			...source,
			attestation_id: "other-owner-controller",
			review_receipt_id: "other-owner-receipt",
			group_id: "other-source-group",
			identity_id: "C",
			device_id: match === "device" ? signer.deviceId : "different-device",
			public_key: match === "device" ? otherKey : signer.publicKey,
		});
		const before = await state();
		// Act
		const pending = h.complete(value);
		// Assert
		await expect(pending).rejects.toThrow(domainDenial);
		expect(await state()).toEqual(before);
	},
);

it("native historical slot stays exact-retry-only without rewriting accepted B", async () => {
	// Arrange: old historical bytes were accepted before recovery; they remain immutable.
	const { h, value } = await recovery();
	const old = manifest("B");
	await insert(completions, {
		group_id: futureGroup,
		candidate_ref: old.candidate_ref,
		manifest_version: 1,
		manifest_json: canonical(old),
		completed_at: timestamp,
		created_at: timestamp,
	});
	const before = await state();
	// Act
	const pending = h.complete(value);
	// Assert
	await expect(pending).rejects.toMatchObject({ code: "completion_conflict" });
	expect(await h.complete(old)).toEqual({ status: "existing", manifest: old });
	expect(await state()).toEqual(before);
});

it("native recovered exact retry ignores later current ownership conflict without writes", async () => {
	// Arrange: the successful native recovered INSERT supplies the retry's actual stored bytes.
	const { h, value } = await recovery();
	expect((await h.complete(value)).status).toBe("created");
	await exec("UPDATE enrolled_devices SET identity_id='C' WHERE group_id=?", futureGroup);
	const before = await state();
	// Act
	const result = await h.complete(value);
	// Assert
	expect(result).toEqual({ status: "existing", manifest: value });
	expect(await state()).toEqual(before);
});

it("native one surviving original source works after its group and enrollment disappear", async () => {
	// Arrange: one additional same-owner receipt names a lost controller, not new authority.
	const { h, value, resolution } = await recovery();
	await insert(resolutions, {
		...resolution,
		resolution_id: "lost-second-resolution",
		source_attestation_id: "missing-second-controller",
	});
	await exec("DELETE FROM enrolled_devices WHERE group_id=?", sourceGroup);
	await exec("DELETE FROM groups WHERE group_id=?", sourceGroup);
	const before = await state({ excludeCompletion: true });
	// Act
	const result = await h.complete(value);
	// Assert
	expect(result).toEqual({ status: "created", manifest: value });
	expect(await state({ excludeCompletion: true })).toEqual(before);
});

it.each(["catalog", "binding", "source"])(
	"native winning INSERT pins a late %s change",
	async (change) => {
		// Arrange: mutate only after capture and final INSERT SQL composition.
		const { h, value, resolution } = await recovery();
		h.arm(async () => {
			if (change === "catalog")
				await exec(`CREATE INDEX late_completion_catalog ON ${resolutions}(owner_identity_id)`);
			if (change === "source")
				await exec(
					`UPDATE ${controllers} SET revoked_at=? WHERE attestation_id='original-controller'`,
					timestamp,
				);
			if (change === "binding")
				await insert("coordinator_device_ownership_bindings", {
					device_id: signer.deviceId,
					key_id: resolution.key_id,
					identity_id: "C",
					coordinator_id: coordinatorId,
					binding_id: "late-binding",
					provenance: "owner_enrollment",
					source_ref: "synthetic-birth",
					bound_at: timestamp,
				});
		});
		// Act
		const pending = h.complete(value);
		// Assert: external mutation remains, but the completion adds no rows or side effects.
		await expect(pending).rejects.toThrow(domainDenial);
		expect(h.injected()).toBe(true);
		expect(await state()).toEqual(h.afterMutation());
	},
);

it("native 500 distinct actual keys/devices/owners permit one recovered INSERT under default limits", async () => {
	// Arrange: 499 ordinary owners plus one recovered A; no fake key points or reduced roster.
	const { h, value } = await recovery();
	const keys = new Set([signer.publicKey]);
	const devices = new Set([signer.deviceId]);
	const owners = new Set(["A"]);
	const setupStarted = performance.now();
	const enrollments: D1PreparedStatement[] = [];
	for (let index = 1; index < 500; index++) {
		const publicKey = rosterKey(index);
		const deviceId = `roster-device-${index}`;
		const owner = `roster-owner-${index}`;
		const fingerprint = fingerprintPublicKey(publicKey);
		keys.add(publicKey);
		devices.add(deviceId);
		owners.add(owner);
		enrollments.push(
			db
				.prepare(
					"INSERT INTO enrolled_devices(group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) VALUES (?,?,?,?,?,1,?)",
				)
				.bind(futureGroup, deviceId, publicKey, fingerprint, owner, timestamp),
		);
		value.memberships.push({ identity_id: owner, role: "member" });
		value.device_decisions.push({
			device_id: deviceId,
			key_fingerprint: fingerprint,
			identity_id: owner,
			enabled: true,
			decision: "included",
		});
	}
	await db.batch(enrollments);
	expect([keys.size, devices.size, owners.size]).toEqual([500, 500, 500]);
	const setupMs = performance.now() - setupStarted;
	const before = await state({ excludeCompletion: true });
	const started = performance.now();
	// Act
	const result = await h.complete(value);
	// Assert: full supported roster reaches the real native winning statement.
	expect(result.status).toBe("created");
	expect(result.manifest.device_decisions).toHaveLength(500);
	expect(h.bindCount()).toBeGreaterThan(0);
	expect(h.bindCount()).toBeLessThanOrEqual(100);
	expect(await state({ excludeCompletion: true })).toEqual(before);
	console.info(
		JSON.stringify({
			qualification: "native 500 subjects, one recovered",
			binds: h.bindCount(),
			setupMs,
			insertMs: performance.now() - started,
		}),
	);
});

it.each(["success", "late source revocation"] as const)(
	"native full 500 recovered subjects with production-shaped IDs: %s",
	async (mode) => {
		// Arrange: 500 historical weak owners and 500 canonical owners, each with an original controller.
		const { h, value, lastSourceId, setupMs, seedStatements } = await fullRecoveredRoster();
		const before = await state({ excludeCompletion: true });
		const oldHistory = (await db.prepare(`SELECT * FROM ${completions} ORDER BY group_id`).all())
			.results;
		if (mode === "late source revocation") {
			h.arm(async () => {
				await exec(
					`UPDATE ${controllers} SET revoked_at=? WHERE attestation_id=?`,
					timestamp,
					lastSourceId,
				);
			});
		}
		const started = performance.now();
		try {
			// Act: unchanged native limits, byte cap and default per-test timeout.
			const pending = h.complete(value);
			if (mode === "success") {
				expect(await pending).toEqual({
					status: "created",
					manifest: JSON.parse(canonical(value)),
				});
				expect(await state({ excludeCompletion: true })).toEqual(before);
			} else {
				await expect(pending).rejects.toThrow(domainDenial);
				expect(h.injected()).toBe(true);
				expect(await state()).toEqual(h.afterMutation());
				expect(
					(
						await db
							.prepare(`SELECT * FROM ${completions} WHERE group_id=?`)
							.bind(futureGroup)
							.all()
					).results,
				).toEqual([]);
			}
			// Assert: no member disappears from the proof and no old history or application row is rewritten.
			expect(
				(
					await db
						.prepare(`SELECT * FROM ${completions} WHERE group_id<>? ORDER BY group_id`)
						.bind(futureGroup)
						.all()
				).results,
			).toEqual(oldHistory);
			const metrics = h.metrics();
			expect([metrics.snapshotSubjects, metrics.snapshotApproved]).toEqual([500, 500]);
			expect(metrics.snapshotBytes).toBeGreaterThan(0);
			expect(metrics.snapshotBytes).toBeLessThanOrEqual(2_000_000);
			expect(metrics.maxJsonBindBytes).toBeLessThanOrEqual(2_000_000);
			expect(metrics.parameters).toBeGreaterThan(0);
			expect(metrics.parameters).toBeLessThanOrEqual(100);
		} finally {
			console.info(
				JSON.stringify({
					qualification: "native full recovered writer-shaped roster",
					mode,
					setupMs,
					seedStatements,
					measuredOperationMs: performance.now() - started,
					...h.metrics(),
					phase: h.diagnostics().phase,
				}),
			);
		}
	},
);
