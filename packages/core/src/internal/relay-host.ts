// Host-neutral relay surface for non-Node hosts such as a Durable Object.
// Keep `ws`, `node:http`, and the Node WebSocket runtime out of this graph.
export {
	RELAY_ADDRESS_PENDING_SOCKETS,
	RelayAddressAllowances,
	relayAddressKey,
} from "../relay-address-allowance.js";
export {
	createRelayCoordinatorClient,
	type RelayCoordinatorClientOptions,
} from "../relay-coordinator-client.js";
export {
	createExclusiveWriterRelayQuota,
	createSqliteRelayQuota,
	initializeRelayQuotaSchema,
	provisionLocalRelayQuota,
	RELAY_QUOTA_MAX_SHARDS,
	type RelayQuotaDatabase,
	type RelayQuotaProfile,
	relayQuotaShardProfile,
	type SqliteRelayQuotaPort,
	setRelayQuotaEnabled,
	tightenRelayQuota,
} from "../relay-quota-sqlite.js";
export {
	createRelayServer,
	type RelayQuotaPort,
	type RelayServerLimits,
	type RelayServerOptions,
	type RelayServerSocket,
	type RelaySocketEvents,
} from "../relay-server.js";
export {
	type RelayServerDiagnostic,
	sanitizeRelayServerDiagnostic,
} from "../relay-server-diagnostics.js";
export {
	RELAY_RESTORE_GUARD_MS,
	type RelayRegistrationSnapshot,
} from "../relay-server-restore.js";
export {
	relayAudienceId,
	relayAuthorityId,
	relayBodyDigest,
	relayRealmId,
} from "../relay-service-proof.js";
