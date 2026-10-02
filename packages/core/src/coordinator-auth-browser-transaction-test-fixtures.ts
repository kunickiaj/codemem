import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
import type {
	CoordinatorAuthBrowserConfig,
	CoordinatorAuthBrowserTransactionStartInput,
} from "./coordinator-auth-browser-transaction-contract.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { cfg, type LinkFixture } from "./coordinator-auth-link-test-fixtures.js";

export const TABLE = "coordinator_auth_browser_transactions";
export function browserCapability(
	f: LinkFixture,
	options: { clock?: () => number; changes?: number } = {},
) {
	const backend: AuthLinkBackend = {
		async first<T>({ sql, values }: AuthLinkStatement) {
			return (f.db.prepare(sql).get(...values) as T | undefined) ?? null;
		},
		async run({ sql, values }) {
			const result = f.db.prepare(sql).run(...values);
			return options.changes ?? result.changes;
		},
		async batch(statements) {
			f.db.transaction(() => {
				for (const { sql, values } of statements) f.db.prepare(sql).run(...values);
			})();
		},
	};
	return new CoordinatorAuthBrowserTransactions(backend, options.clock ?? (() => f.now));
}
export const browserConfig: CoordinatorAuthBrowserConfig = {
	...cfg,
	redirectUri: "https://coordinator.example.test/auth/callback",
};
export function hash(value: number) {
	return value.toString(16).padStart(64, "0");
}
export function materials(value = 1): CoordinatorAuthBrowserTransactionStartInput {
	return {
		purpose: "signin",
		stateHash: hash(value * 3),
		binderHash: hash(value * 3 + 1),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
}
export function transactionRows(f: LinkFixture) {
	return f.db.prepare(`SELECT * FROM ${TABLE} ORDER BY state_hash`).all() as Record<
		string,
		unknown
	>[];
}
export function seed(f: LinkFixture, count: number, createdAt = f.now, state = "pending") {
	const statement = f.db.prepare(`INSERT INTO ${TABLE}
		(coordinator_id,browser_transaction_hash,purpose,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
		VALUES (?,?,'signin',?,?,?,?,?,?,?,?,?,?)`);
	f.db.transaction(() => {
		for (let i = 1; i <= count; i++) {
			statement.run(
				browserConfig.coordinatorId,
				hash(i + 10000),
				hash(i + 20000),
				hash(i + 30000),
				browserConfig.issuer,
				browserConfig.revision,
				browserConfig.redirectUri,
				state,
				state === "pending" ? "n".repeat(43) : null,
				state === "pending" ? "p".repeat(43) : null,
				createdAt,
				createdAt + 600000,
			);
		}
	})();
}
