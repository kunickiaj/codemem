/**
 * Committed proof only: future finalization must insert it atomically with the
 * winning attempt, account link, and audit row. No request-to-proof writer lives here.
 * References are logical, and revocation retains this immutable proof forever.
 * This leaf schema is not installed automatically when an existing store opens.
 */
export const COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS = [
	`
CREATE TABLE IF NOT EXISTS coordinator_auth_device_claims (
  claim_id TEXT PRIMARY KEY NOT NULL CHECK(
    typeof(claim_id) = 'text' AND length(claim_id) BETWEEN 1 AND 256
    AND claim_id = trim(claim_id) AND instr(claim_id, char(0)) = 0),
  coordinator_id TEXT NOT NULL CHECK(
    typeof(coordinator_id) = 'text' AND length(coordinator_id) BETWEEN 1 AND 256
    AND coordinator_id = trim(coordinator_id) AND instr(coordinator_id, char(0)) = 0),
  identity_id TEXT NOT NULL CHECK(
    typeof(identity_id) = 'text' AND length(identity_id) BETWEEN 1 AND 256
    AND identity_id = trim(identity_id) AND instr(identity_id, char(0)) = 0),
  group_id TEXT NOT NULL CHECK(
    typeof(group_id) = 'text' AND length(group_id) BETWEEN 1 AND 256
    AND group_id = trim(group_id) AND instr(group_id, char(0)) = 0),
  device_id TEXT NOT NULL CHECK(
    typeof(device_id) = 'text' AND length(device_id) BETWEEN 1 AND 256
    AND device_id = trim(device_id) AND instr(device_id, char(0)) = 0),
  public_key TEXT NOT NULL CHECK(
    typeof(public_key) = 'text' AND length(public_key) BETWEEN 1 AND 4096
    AND length(trim(replace(replace(public_key, char(13), ''), char(10), ''))) > 0
    AND instr(public_key, char(0)) = 0),
  fingerprint TEXT NOT NULL CHECK(
    typeof(fingerprint) = 'text' AND length(fingerprint) = 64
    AND fingerprint NOT GLOB '*[^a-f0-9]*' AND instr(fingerprint, char(0)) = 0),
  key_id TEXT NOT NULL CHECK(
    typeof(key_id) = 'text' AND length(key_id) = 64
    AND key_id NOT GLOB '*[^a-f0-9]*' AND instr(key_id, char(0)) = 0),
  attempt_id TEXT NOT NULL CHECK(
    typeof(attempt_id) = 'text' AND length(attempt_id) BETWEEN 1 AND 256
    AND attempt_id = trim(attempt_id) AND instr(attempt_id, char(0)) = 0),
  issuer TEXT NOT NULL CHECK(
    typeof(issuer) = 'text' AND length(trim(issuer)) > 0
    AND issuer = trim(issuer) AND instr(issuer, char(0)) = 0),
  auth_config_revision TEXT NOT NULL CHECK(
    typeof(auth_config_revision) = 'text' AND length(auth_config_revision) = 64
    AND auth_config_revision NOT GLOB '*[^a-f0-9]*' AND instr(auth_config_revision, char(0)) = 0),
  created_at_ms INTEGER NOT NULL CHECK(
    typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (coordinator_id, identity_id),
  UNIQUE (coordinator_id, device_id),
  UNIQUE (coordinator_id, key_id),
  UNIQUE (coordinator_id, attempt_id)
) WITHOUT ROWID;
`,
	`
-- REPLACE's implicit deletes may skip DELETE triggers when recursive triggers are off.
-- Check every unique identifier before conflict handling, including UPSERT DO NOTHING.
CREATE TRIGGER IF NOT EXISTS coordinator_auth_device_claims_insert_collision
BEFORE INSERT ON coordinator_auth_device_claims
WHEN EXISTS (
  SELECT 1 FROM coordinator_auth_device_claims
  WHERE claim_id = NEW.claim_id OR (coordinator_id = NEW.coordinator_id AND (
    identity_id = NEW.identity_id OR device_id = NEW.device_id
    OR key_id = NEW.key_id OR attempt_id = NEW.attempt_id
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'auth_device_claim_collision');
END;
`,
	`
CREATE TRIGGER IF NOT EXISTS coordinator_auth_device_claims_immutable_update
BEFORE UPDATE ON coordinator_auth_device_claims
BEGIN
  SELECT RAISE(ABORT, 'auth_device_claim_immutable');
END;
`,
	`
CREATE TRIGGER IF NOT EXISTS coordinator_auth_device_claims_immutable_delete
BEFORE DELETE ON coordinator_auth_device_claims
BEGIN
  SELECT RAISE(ABORT, 'auth_device_claim_immutable');
END;
`,
] as const;

export const COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL =
	COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS.join("\n");

const quoteSql = (value: string) => `'${value.replaceAll("'", "''")}'`;
const proofDefinitions = COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS.map((statement) =>
	statement.replace(/^(?:\s|--[^\n]*\n)*/u, "").replace(/;\s*$/u, ""),
);
// Frozen DDL only, not a SQL parser. Protect known literals before removing layout;
// unknown literals retain their quotes and cannot match a protected literal token.
const proofLiterals = [...new Set(proofDefinitions.join("\n").match(/'(?:[^']|'')*'/gu))];
function canonicalProofSql(
	expression: string,
	literals: readonly string[] = proofLiterals,
): string {
	let sql = expression;
	for (const [index, literal] of literals.entries())
		sql = `replace(${sql}, ${quoteSql(literal)}, 'literal_${index}')`;
	return `rtrim(replace(replace(replace(replace(replace(${sql}, 'IF NOT EXISTS', ''), ' ', ''), char(10), ''), char(13), ''), char(9), ''), char(59))`;
}

/** Same effective-definition checks for SQLite, D1 readiness and explicit cutover. */
export function authSchemaDefinitionCheck(
	definition: string,
	options: { auxiliaryObjects?: number; literals?: readonly string[] } = {},
) {
	definition = definition.replace(/^(?:\s|--[^\n]*\n)*/u, "").replace(/;\s*$/u, "");
	// Headers of this repository's frozen declarations only, not a DDL parser.
	const header = /^CREATE (TABLE|TRIGGER|(?:UNIQUE )?INDEX)(?: IF NOT EXISTS)? (\w+)/u.exec(
		definition,
	);
	if (!header?.[1] || !header[2]) throw new Error("auth_device_claim_definition_invalid");
	// Encode the known ASCII DDL so trigger-body semicolons cannot split cutover statements.
	const hex = [...definition]
		.map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
		.join("");
	let auxiliaryCheck = "";
	if (options.auxiliaryObjects !== undefined)
		auxiliaryCheck = ` AND (SELECT count(*) FROM sqlite_master WHERE tbl_name = ${quoteSql(header[2])} COLLATE NOCASE AND type IN ('index','trigger') AND sql IS NOT NULL) = ${options.auxiliaryObjects}`;
	const literals = options.literals ?? [...new Set(definition.match(/'(?:[^']|'')*'/gu))];
	return {
		name: header[2],
		matches: `EXISTS (SELECT 1 FROM sqlite_master WHERE type = ${quoteSql(header[1].toLowerCase().replace("unique ", ""))} AND name = ${quoteSql(header[2])} COLLATE NOCASE AND ${canonicalProofSql("sql", literals)} = ${canonicalProofSql(`CAST(X'${hex}' AS TEXT)`, literals)}${auxiliaryCheck})`,
	};
}
export const authDeviceClaimDefinitionChecks = (auxiliaryObjects = 3) =>
	proofDefinitions.map((definition, index) =>
		authSchemaDefinitionCheck(definition, {
			auxiliaryObjects: index === 0 ? auxiliaryObjects : undefined,
			literals: proofLiterals,
		}),
	);
export const AUTH_DEVICE_CLAIM_DEFINITION_CHECKS = authDeviceClaimDefinitionChecks();

/**
 * Database columns for an already committed proof, not an authorization input.
 * public_key retains exact enrollment bytes (including PEM line endings);
 * key_id is the canonical SHA-256 key ID, not the PEM fingerprint. Both hashes
 * and auth_config_revision use the lowercase 64-hex format of link capture.
 * CHECKs validate storage shape only; finalization must verify all authority.
 */
export interface CoordinatorAuthDeviceClaimRow {
	readonly claim_id: string;
	readonly coordinator_id: string;
	readonly identity_id: string;
	readonly group_id: string;
	readonly device_id: string;
	readonly public_key: string;
	readonly fingerprint: string;
	readonly key_id: string;
	readonly attempt_id: string;
	readonly issuer: string;
	readonly auth_config_revision: string;
	readonly created_at_ms: number;
}
