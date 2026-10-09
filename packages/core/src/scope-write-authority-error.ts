/** Current scope authority is missing; retain the capture until authority returns. */
export class ScopeWriteAuthorityError extends Error {
	constructor() {
		super("unauthorized_scope");
		this.name = "ScopeWriteAuthorityError";
	}
}
