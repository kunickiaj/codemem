import { Hono } from "hono";

interface AccountSession {
	version: 1;
	csrfToken: string;
}

/** Mounted only alongside the account request middleware. */
export function accountRoutes(getSession: () => AccountSession) {
	const app = new Hono();
	app.get("/api/account/session", (c) => c.json(getSession()));
	return app;
}
