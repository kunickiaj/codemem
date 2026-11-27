import { Hono } from "hono";
import {
	TEAM_SETUP_ROUTE_PREFIX,
	type TeamSetupRoutesOptions,
	teamSetupRoutes,
} from "./team-setup.js";

/** The parts of the background reconciliation a test harness drives. */
export interface SettleableReconciliation {
	refresh: () => Promise<void>;
}

/**
 * Runs one background reconciliation pass before each summary read, waiting up to a
 * second for it, then serves the summary. Tests about what the coordinator says use this to keep the old
 * reconcile-then-respond order; tests about the background timing use
 * `teamSetupRoutes` directly.
 */
export function reconcileBeforeSummaryReads(
	app: Hono,
	reconciliation: () => SettleableReconciliation | null,
): Hono {
	const wrapper = new Hono();
	wrapper.use(TEAM_SETUP_ROUTE_PREFIX, async (c, next) => {
		// A pass waits for a draft or finish route changing the same candidate. Don't
		// let a test that reads the summary during such a route wait for it forever.
		const pass = c.req.method === "GET" ? reconciliation()?.refresh() : undefined;
		if (pass) await Promise.race([pass, new Promise((resolve) => setTimeout(resolve, 1_000))]);
		await next();
	});
	wrapper.route("/", app);
	return wrapper;
}

/** `teamSetupRoutes`, with a reconciliation pass before each summary read. */
export function teamSetupRoutesReconcilingOnRead(options: TeamSetupRoutesOptions): Hono {
	let reconciliation: SettleableReconciliation | null = null;
	const app = teamSetupRoutes({
		...options,
		registerReconciliation: (registered) => {
			reconciliation = registered;
			options.registerReconciliation?.(registered);
		},
	});
	return reconcileBeforeSummaryReads(app, () => reconciliation);
}
