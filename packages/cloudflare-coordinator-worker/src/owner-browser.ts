import {
	AuthSessionOperations,
	type BrowserCsrfKey,
	type CoordinatorBrowserOwnerEnrollmentFactory,
	type CoordinatorOwnerEnrollmentHttp,
	createCoordinatorOwnerEnrollmentHttp,
	createD1AuthLinkBackend,
	createOwnerBrowserAdmissionHandler,
	type D1DatabaseLike,
	type InMemoryRequestRateLimiter,
	type OwnerEnrollmentAdmissionKey,
} from "@codemem/core/internal/cloudflare-coordinator";

/** One lazy owner composition for early admission, HTTP, and shared callback dispatch. */
export function createOwnerBrowser(options: {
	config: unknown;
	db: D1DatabaseLike;
	csrfKey: BrowserCsrfKey;
	admissionKey: OwnerEnrollmentAdmissionKey;
	limiter: InMemoryRequestRateLimiter;
}) {
	const backend = createD1AuthLinkBackend(options.db);
	const sessions = new AuthSessionOperations(backend);
	const oidcOptions = Object.freeze({});
	let completed: CoordinatorOwnerEnrollmentHttp | undefined;
	async function getEnrollment(): Promise<CoordinatorOwnerEnrollmentHttp> {
		if (completed) return completed;
		// Do not share request-owned discovery promises across concurrent requests.
		const result = await createCoordinatorOwnerEnrollmentHttp({
			mode: "production",
			config: options.config,
			backend,
			csrfKey: options.csrfKey,
			admissionKey: options.admissionKey,
			limiter: options.limiter,
			oidcOptions,
		});
		completed ??= result;
		return completed;
	}
	const ownerEnrollment: CoordinatorBrowserOwnerEnrollmentFactory = () => getEnrollment();
	return {
		ownerEnrollment,
		admit: createOwnerBrowserAdmissionHandler({
			enabled: true,
			config: options.config,
			backend,
			csrfKey: options.csrfKey,
			admissionKey: options.admissionKey,
			limiter: options.limiter,
			readSession: sessions.readAuthSession.bind(sessions),
			getEnrollment,
		}),
	};
}
