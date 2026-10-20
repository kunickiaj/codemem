import { env } from "cloudflare:workers";
import { issueBrowserCookie } from "../../core/src/coordinator-browser-credential.js";
import { ownerEnrollmentStartMessage } from "../../core/src/owner-enrollment-start.js";
import defaultWorker, {
	type CloudflareCoordinatorEnv,
	type createConfiguredCloudflareCoordinatorWorker,
} from "../src/index.js";
import {
	config,
	exec,
	hash,
	NOW,
	ORIGIN,
	pendingKey,
	proof,
	seedNativeOwnerAuthority,
} from "./owner-ceremony-test-fixtures.js";

export const ADMIT = "/auth/owner/admit";
const { clientSecret: _secret, ...publicConfig } = config;
export const browserConfig = { ...publicConfig, ownerEnrollmentEnabled: true };
export const bindings: CloudflareCoordinatorEnv = {
	...env,
	CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: JSON.stringify(browserConfig),
	CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET: config.clientSecret,
	CODEMEM_COORDINATOR_BROWSER_CSRF_KEY: "11".repeat(32),
};
export type Worker = ReturnType<typeof createConfiguredCloudflareCoordinatorWorker>;
export function send(worker: Worker, init: RequestInit = {}, settings = bindings, path = ADMIT) {
	const headers = new Headers(init.headers);
	headers.set("CF-Connecting-IP", "127.0.0.1");
	return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), settings);
}
export function fields(html: string) {
	return Object.fromEntries(
		[...html.matchAll(/name="([a-z_]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
	);
}
export async function seedLink(linkId = "link-a", subject = "fixture-subject") {
	await seedNativeOwnerAuthority({
		coordinatorId: config.coordinatorId,
		issuer: config.issuer,
		revision: config.revision,
		linkId,
		subject,
		identityId: "identity-a",
		attemptId: `historical-${linkId}`,
		controllerAttestationId: `controller-${linkId}`,
		controllerReviewReceiptId: `review-${linkId}`,
		redirectUri: config.redirectUri,
		groupId: "historical-group",
		deviceId: `historical-${linkId}`,
		publicKey: "fixture-historical-key",
		fingerprint: hash("fixture-historical-key"),
		createdAtMs: NOW - 1000,
	});
	await exec(
		`INSERT INTO coordinator_auth_controller_attestations
		(attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,created_at)
		SELECT controller_attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,controller_review_receipt_id,?,'historical'
		FROM coordinator_auth_link_attempts WHERE attempt_id=?`,
		hash("reviewed-evidence"),
		`historical-${linkId}`,
	);
}

/** Reviewed historical facts only. Admission and owner start use the shipped Worker. */
export async function ownerBrowserWorkerFixture(worker: Worker = defaultWorker) {
	await seedLink();
	await exec("INSERT INTO groups (group_id,created_at) VALUES ('group-a','created')");
	await exec(
		`INSERT INTO coordinator_identity_group_grants
		(coordinator_id,identity_id,group_id,status,revision,source_kind,source_receipt_id,created_at)
		VALUES (?,'identity-a','group-a','active',1,'controller_attestation','review-link-a','created')`,
		config.coordinatorId,
	);
	const session = await issueBrowserCookie("session");
	await exec(
		`INSERT INTO coordinator_auth_sessions
		(coordinator_id,session_id,credential_hash,browser_transaction_hash,link_id,identity_id,issuer,subject,auth_config_revision,created_at_ms,expires_at_ms)
		VALUES (?,'session-a',?,?,'link-a','identity-a',?,'fixture-subject',?,?,?)`,
		config.coordinatorId,
		session.cookieHash,
		hash("session-transaction"),
		config.issuer,
		config.revision,
		NOW - 500,
		NOW - 500 + 28800000,
	);
	const key = await pendingKey();
	const start = {
		attemptId: "browser-admitted-attempt",
		deviceId: "pending-device",
		publicKey: key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	start.signature = await key.sign(
		ownerEnrollmentStartMessage(start, { ...config, origin: ORIGIN }),
	);
	const cookie = session.setCookie.split(";")[0] ?? "";
	const get = () => send(worker, { headers: { cookie } });
	const upload = (csrf: string, raw = JSON.stringify({ start })) => {
		const body = new FormData();
		body.append("csrf", csrf);
		body.append(
			"request",
			new File([raw], "capability-request.json", { type: "application/json" }),
		);
		return body;
	};
	const post = (body: BodyInit, headers: Record<string, string> = {}) =>
		send(worker, {
			method: "POST",
			headers: { cookie, origin: ORIGIN, ...headers },
			body,
		});
	const page = async () => {
		const response = await get();
		if (response.status !== 200)
			throw new Error(`Admission fixture GET: ${response.status}: ${await response.text()}`);
		return fields(await response.text()).csrf ?? "";
	};
	return { worker, start, cookie, session, get, post, upload, page };
}
