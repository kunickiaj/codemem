// Bundle-only entry for check:bundle. It is never deployed or wired into src/index.ts.
// Importing the whole host surface proves the relay engine graph passes the Worker import check.
import * as relayHost from "@codemem/core/internal/relay-host";

export default {
	fetch() {
		return new Response(Object.keys(relayHost).join(","), { status: 404 });
	},
};
