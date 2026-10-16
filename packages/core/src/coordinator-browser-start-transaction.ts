import type {
	CoordinatorAuthBrowserConfig,
	CoordinatorAuthBrowserTransactionStore,
} from "./coordinator-auth-browser-transaction-contract.js";
import { clearBrowserCookie, readBrowserCookie } from "./coordinator-browser-credential.js";

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

/** A newly admitted transaction replaces the old cookie instead of being cleared. */
export function clearInactiveStartTransaction<T extends { response: Response; outcome: string }>(
	result: T,
	activity: string,
): T {
	if (
		activity === "inactive" &&
		["link_start_page", "signin_page", "session_live"].includes(result.outcome)
	)
		result.response.headers.append("Set-Cookie", clearBrowserCookie("transaction"));
	return result;
}
