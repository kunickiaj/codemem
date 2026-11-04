// Bundle-only entry for check:bundle. It is never deployed or wired into src/index.ts.
// Importing the whole host surface and the realm object proves the relay graph passes the Worker import check.
import * as relayHost from "@codemem/core/internal/relay-host";

export { RelayRealm } from "../src/relay-realm.ts";

export default {
	fetch() {
		return new Response(Object.keys(relayHost).join(","), { status: 404 });
	},
};
