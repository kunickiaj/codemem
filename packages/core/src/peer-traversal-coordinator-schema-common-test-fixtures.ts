export type Value = string | number | null;
export interface Statement {
	sql: string;
	values: Value[];
}
export interface SchemaDatabase {
	run(sql: string, values?: Value[]): Promise<unknown>;
	all(sql: string, values?: Value[]): Promise<Record<string, Value>[]>;
	batch(statements: Statement[]): Promise<unknown>;
}
export interface SchemaFixture {
	db: SchemaDatabase;
	authority: string;
	now: number;
}
export type CreateFixture = () => Promise<SchemaFixture>;
export const POLICY =
	"INSERT INTO traversal_authority_policy(authority_id,policy_revision) VALUES (?1,?2)";
export const REALM =
	"INSERT INTO traversal_realms(authority_id,group_id,changed_revision) VALUES (?1,?2,?3)";
export const HEALTH =
	"INSERT INTO traversal_readiness(authority_id,scope,group_id,revision,state,observed_at_ms) VALUES (?1,?2,?3,?4,?5,?6)";

// Fixture metadata describes shape only. It grants no admission or controller provenance.
export async function seed(f: SchemaFixture) {
	await f.db.run(POLICY, [f.authority, 1]);
	await f.db.run(REALM, [f.authority, "group", 1]);
	await f.db.run(HEALTH, [f.authority, "authority", "", 1, "paused", null]);
	await f.db.run(HEALTH, [f.authority, "realm", "group", 1, "paused", null]);
}
