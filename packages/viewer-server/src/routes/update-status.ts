import {
	getUpdateStatus as defaultGetUpdateStatus,
	detectInstallKind,
	type GetUpdateStatusOptions,
	type UpdateStatus,
	VERSION,
} from "@codemem/core";
import { Hono } from "hono";

export interface UpdateStatusRoutesOptions {
	getUpdateStatus?: (options: GetUpdateStatusOptions) => Promise<UpdateStatus>;
}

export function updateStatusRoutes(options: UpdateStatusRoutesOptions = {}) {
	const getUpdateStatus = options.getUpdateStatus ?? defaultGetUpdateStatus;
	const app = new Hono();

	app.get("/api/update-status", async (c) => {
		try {
			const installKind = detectInstallKind({
				entryPath: process.argv[1] ?? "",
				env: process.env,
			});
			const status = await getUpdateStatus({
				currentVersion: VERSION,
				installKind,
			});
			return c.json(status);
		} catch {
			return c.json({ error: "Update status unavailable." }, 503);
		}
	});

	return app;
}
