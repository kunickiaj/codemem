import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	type DeviceRejoinBrowserScope,
	REJOIN_ATTEMPTS_TABLE,
	rejoinConsumedBrowserCtes,
	validRejoinBrowserScope,
} from "./coordinator-device-rejoin-browser-evidence.js";
import { REJOIN_DESTINATION_CTES } from "./coordinator-device-rejoin-destinations.js";
import {
	readDeviceRejoinLinkStorage,
	rejoinLinkEvidenceCtes,
} from "./coordinator-device-rejoin-link-evidence.js";

/**
 * Pins the account from the already verified provider callback. The caller
 * owns the token from the exact transaction it consumed before verifying OIDC.
 */
export async function pinVerifiedDeviceRejoinAccount(
	backend: Pick<AuthLinkBackend, "first" | "run" | "readAuthSchemaState">,
	input: DeviceRejoinBrowserScope & {
		claimToken: string;
		account: { issuer: string; subject: string };
	},
): Promise<boolean> {
	const {
		claimToken,
		account: { issuer, subject },
		...scope
	} = input;
	if (!validRejoinBrowserScope(scope) || issuer !== scope.issuer || !subject || !claimToken)
		return false;
	const storage = await readDeviceRejoinLinkStorage(backend);
	if (!storage) return false;
	const { sql, values } = rejoinConsumedBrowserCtes(scope, storage, {
		state: "browser_claimed",
		claimToken,
	});
	const wrote = await backend.run({
		sql: `${sql}, ${REJOIN_DESTINATION_CTES},
rejoin_link_scope AS MATERIALIZED (
 SELECT a.coordinator_id, a.identity_id, a.issuer, ? AS subject FROM checked a
), ${rejoinLinkEvidenceCtes(storage)}
UPDATE ${REJOIN_ATTEMPTS_TABLE} AS a SET state = 'oidc_verified',
 link_id = l.link_id, link_authority_kind = l.link_authority_kind, link_generation = l.link_generation
FROM checked t JOIN rejoin_link_evidence l ON l.coordinator_id = t.coordinator_id AND l.identity_id = t.identity_id
WHERE a.coordinator_id = t.coordinator_id AND a.attempt_id = t.attempt_id
 AND a.link_id IS NULL AND a.link_authority_kind IS NULL AND a.link_generation IS NULL`,
		values: [...values, subject],
	});
	return wrote === 1;
}
