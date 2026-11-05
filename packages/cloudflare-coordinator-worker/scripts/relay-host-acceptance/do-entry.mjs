// Acceptance-only Worker entry, never deployed. It re-exports the deployed Worker
// unchanged and adds one read-only RPC so the run can read a realm's engine counters.
// ensureHost() restores hibernated sockets first, as the realm's next socket event would.
import { RelayRealm as DeployedRelayRealm } from "../../src/relay-realm.ts";

export { default, RelayAdmission, RelayHealth } from "../../src/worker.ts";

export class RelayRealm extends DeployedRelayRealm {
	async harnessCounters() {
		const host = await this.ensureHost();
		return host ? host.engine.counters() : null;
	}
}
