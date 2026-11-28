// The peer loads only the selected build's compiled modules and dependencies.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, action, coordinator] = process.argv.slice(2);
const load = (pkg) => import(pathToFileURL(join(root, "packages", pkg, "dist/index.js")));
const core = await load("core");
const store = new core.MemoryStore(process.env.CODEMEM_DB);
if (action === "inspect-cache") {
	try {
		const [expected, ...scopes] = process.argv.slice(5);
		assert.ok(expected === "present" || expected === "absent");
		const members = store.db
			.prepare(`SELECT device_id,public_key FROM sync_device
			UNION ALL SELECT peer_device_id,public_key FROM sync_peers`)
			.all();
		assert.equal(members.length, 2);
		for (const scopeId of scopes)
			for (const member of members) {
				const result = core.getEffectiveCachedScopeAuthorization(store.db, {
					scopeId,
					deviceId: member.device_id,
					expectedPublicKey: member.public_key,
				});
				assert.equal(result.authorized, expected === "present");
			}
	} finally {
		store.close();
	}
} else if (action === "refresh") {
	try {
		const result = await core.refreshScopeMembershipCache(store.db, {
			groupIds: ["fixture-group"],
			remoteUrl: coordinator,
			keysDir: process.env.CODEMEM_KEYS_DIR,
			dbPath: process.env.CODEMEM_DB,
		});
		assert.equal(result.status, "stale");
		assert.equal(result.groups.length, 1);
		assert.equal(result.groups[0].groupId, "fixture-group");
		assert.match(result.groups[0].error, /ECONNREFUSED|fetch failed|connection refused/i);
	} finally {
		store.close();
	}
} else {
	assert.equal(action, "serve");
	const { createSyncApp } = await load("viewer-server");
	const require = createRequire(join(root, "packages/viewer-server/package.json"));
	const { serve } = require("@hono/node-server");
	const app = createSyncApp({ storeFactory: () => store });
	const marker = "offline-proof-synthetic-body:";
	const record = (text) => {
		if (text.includes(marker)) appendFileSync(join(process.env.HOME, "wire-count"), "1");
	};
	const server = serve(
		{
			fetch: async (request) => {
				if (request.method === "POST") record(await request.clone().text());
				const response = await app.fetch(request);
				record(await response.clone().text());
				return response;
			},
			hostname: "127.0.0.1",
			port: 0,
		},
		({ port }) => process.send({ port }),
	);
	process.on("disconnect", () => server.close(() => store.close()));
}
