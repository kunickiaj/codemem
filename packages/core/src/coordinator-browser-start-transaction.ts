import type {
	CoordinatorAuthBrowserConfig,
	CoordinatorAuthBrowserTransactionStore,
} from "./coordinator-auth-browser-transaction-contract.js";
import { readBrowserCookie } from "./coordinator-browser-credential.js";

type ActivityStore = Pick<
	CoordinatorAuthBrowserTransactionStore,
	"readAuthBrowserTransactionActivity"
>;

/** Invalid credentials and config drift deny restart; lookup faults reach the handler's catch. */
export async function readBrowserStartTransaction(
	cookie: unknown,
	store: ActivityStore,
	config: CoordinatorAuthBrowserConfig,
): Promise<"absent" | "invalid" | "active" | "inactive"> {
	const transaction = await readBrowserCookie(cookie, "transaction");
	if (transaction.kind !== "present") return transaction.kind;
	const activity = await store.readAuthBrowserTransactionActivity(
		{ binderHash: transaction.cookieHash },
		config,
	);
	if (activity.kind === "rejected") return "invalid";
	return activity.kind;
}
