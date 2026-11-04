import { RelayAdmission } from "../src/relay-admission.js";

/**
 * Test-only RelayAdmission with the relay switch on. Production config keeps the
 * switch off, so the pool cannot reach the real entrypoint with relay enabled.
 * Everything else, including D1 and the admission budgets, is the production path.
 */
export class RelayAdmissionEnabledTest extends RelayAdmission {
	constructor(ctx: ExecutionContext, env: Readonly<Record<string, unknown>>) {
		super(ctx, { ...env, CODEMEM_RELAY_ENABLED: "true" });
	}
}
