import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { revocationHarness, revocationInput } from "../../core/src/coordinator-device-revocation-test-harness.js";
import { JOIN_NOW } from "../../core/src/coordinator-join-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { type LifecycleFixture, registerOwnershipWriterLifecycle } from "../../core/src/shared-ownership-writer-lifecycle-test-harness.js";
import { disposeNativeAuthFixture } from "./owner-ceremony-test-fixtures.js";

describe("native D1 cross-writer lifecycle (pool fixture, not cold restart)", () => {
  const test = revocationHarness(async use => {
    await env.COORDINATOR_DB.prepare("DROP TABLE IF EXISTS coordinator_device_ownership_bindings").run();
    const migration = env.TEST_MIGRATIONS.find(entry => entry.name === "0028_add_device_ownership_bindings.sql");
    if (!migration) throw new Error("Missing ownership fixture migration");
    await env.COORDINATOR_DB.batch(migration.queries.map(sql => env.COORDINATOR_DB.prepare(sql)));
    vi.useFakeTimers(); vi.setSystemTime(new Date(JOIN_NOW));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const names = await env.COORDINATOR_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name").all<{name: string}>();
    const f: LifecycleFixture = {
      store: new D1CoordinatorStore(env.COORDINATOR_DB), input: revocationInput("ownership-native"), tables: names.results.map(row => row.name),
      exec: async (sql, ...values) => { await env.COORDINATOR_DB.prepare(sql).bind(...values).run(); },
      rows: async table => {
        if (!f.tables.includes(table)) throw new Error("Unknown lifecycle fixture table");
        const orderBy = ({
          coordinator_auth_device_claims: "claim_id",
          coordinator_owner_enrollment_qualifications: "qualification_id",
          coordinator_legacy_owner_resolutions: "coordinator_id, resolution_id",
        } as Record<string, string>)[table] ?? "rowid";
        return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all()).results;
      },
    };
    try {
      await use(f);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore(); vi.useRealTimers();
      await disposeNativeAuthFixture();
      await env.COORDINATOR_DB.batch(["DELETE FROM coordinator_identity_group_grants", "DELETE FROM coordinator_bootstrap_grants", "DELETE FROM coordinator_join_requests", "DELETE FROM coordinator_invites", "DELETE FROM coordinator_device_revocations", "DELETE FROM enrolled_devices", "DELETE FROM groups WHERE group_id LIKE 'ownership-native%'"].map(sql => env.COORDINATOR_DB.prepare(sql)));
    }
  });
  registerOwnershipWriterLifecycle(test);
});
