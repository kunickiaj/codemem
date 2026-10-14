import { Hono } from "hono";
import type { AccountContextReader } from "../account/context.js";
import { type AccountStatusOptions, readAccountStatus } from "../account/status.js";

export function accountStatusRoutes(
	options: AccountStatusOptions & { readContext: AccountContextReader },
): Hono {
	const app = new Hono();
	app.get("/api/account/link-status", async (c) => {
		try {
			const query = new URL(c.req.url).searchParams;
			const length = c.req.header("Content-Length");
			if (
				[...query.keys()].some((key) => key !== "group_id") ||
				query.getAll("group_id").length > 1 ||
				c.req.raw.body !== null ||
				(length !== undefined && length !== "0") ||
				c.req.header("Transfer-Encoding") !== undefined
			)
				return c.json({ error: "account_invalid_request" }, 400);
			const result = await readAccountStatus(
				options,
				query.get("group_id") ?? undefined,
				c.req.raw.signal,
			);
			if ("error" in result)
				return c.json(result, result.error === "account_group_not_configured" ? 400 : 503);
			return c.json(result);
		} catch {
			return c.json({ error: "account_internal_error" }, 500);
		}
	});
	return app;
}
