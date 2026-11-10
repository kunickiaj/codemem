import { statSync } from "node:fs";
import {
	type CoordinatorEnrollment,
	type completeCoordinatorDeviceSetup,
	LocalIdentitySupersededError,
	loadRuntimeSigningPublicKey,
	type MemoryStore,
	readAccountLinkDevice,
	type readCoordinatorSyncConfig,
} from "@codemem/core";

type CoordinatorConfig = ReturnType<typeof readCoordinatorSyncConfig>;

function readEnrollmentDeviceContext(store: MemoryStore, keysDir: string | undefined) {
	try {
		const before = statSync(store.dbPath, { bigint: true });
		const device = readAccountLinkDevice(store.dbPath);
		const signingKey = loadRuntimeSigningPublicKey(store.db, { deviceId: store.deviceId, keysDir });
		const after = statSync(store.dbPath, { bigint: true });
		if (
			!before.isFile() ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			device.deviceId !== store.deviceId ||
			signingKey !== device.publicKey
		) {
			throw new Error("device_unavailable");
		}
		return { device, fileIdentity: `${after.dev}:${after.ino}` };
	} catch {
		throw new Error("device_unavailable");
	}
}

function identityGeneration(store: MemoryStore): unknown {
	try {
		return (
			store.db
				.prepare("SELECT generation, actor_id FROM local_identity_generation WHERE id = 1")
				.get() ?? null
		);
	} catch (error) {
		// The first local Identity switch creates this table. Never create it on a read.
		if (error instanceof Error && error.message.includes("no such table")) return null;
		throw error;
	}
}

/** Pins only local context. Coordinator receipts and snapshots remain the authority. */
function captureCoordinatorEnrollmentContext(
	store: MemoryStore,
	options: {
		config: CoordinatorConfig;
		readConfig: () => CoordinatorConfig;
		keysDir: () => string | undefined;
	},
) {
	const expectedConfig = JSON.stringify(options.config);
	const capture = () => {
		store.assertLocalIdentityCurrent();
		if (
			!store.hasCurrentConfiguredIdentity() ||
			JSON.stringify(options.readConfig()) !== expectedConfig
		) {
			throw new Error("device_setup_context_changed");
		}
		const keysDir = options.keysDir();
		const { device, fileIdentity } = readEnrollmentDeviceContext(store, keysDir);
		return {
			device,
			keysDir,
			currentIdentityId: store.actorId,
			pin: JSON.stringify({
				dbPath: store.dbPath,
				dbEnv: process.env.CODEMEM_DB,
				fileIdentity,
				device,
				keysDir,
				identityId: store.actorId,
				generation: identityGeneration(store),
				config: expectedConfig,
				configPath: process.env.CODEMEM_CONFIG,
				keyStore: process.env.CODEMEM_SYNC_KEY_STORE,
				home: process.env.HOME,
			}),
		};
	};
	const initial = capture();
	return {
		...initial.device,
		keysDir: initial.keysDir,
		currentIdentityId: initial.currentIdentityId,
		assertCurrent: () => {
			try {
				if (capture().pin !== initial.pin) throw new Error("device_setup_context_changed");
			} catch (error) {
				if (error instanceof LocalIdentitySupersededError) throw error;
				throw new Error("device_setup_context_changed");
			}
		},
	};
}

interface EnrollmentSetupOptions {
	config: CoordinatorConfig;
	readConfig: () => CoordinatorConfig;
	keysDir: () => string | undefined;
	groupId: string;
	completeDeviceSetup: typeof completeCoordinatorDeviceSetup;
	listDevices: () => Promise<CoordinatorEnrollment[]>;
}

function hasOwnEnrollment(
	context: ReturnType<typeof captureCoordinatorEnrollmentContext>,
	groupId: string,
	enrollments: CoordinatorEnrollment[],
): boolean {
	return enrollments.some(
		(enrollment) =>
			enrollment.enabled === 1 &&
			enrollment.group_id === groupId &&
			enrollment.device_id === context.deviceId &&
			enrollment.public_key === context.publicKey &&
			enrollment.fingerprint === context.fingerprint &&
			enrollment.identity_id === context.currentIdentityId &&
			(enrollment.ownership_identity_id === undefined ||
				enrollment.ownership_identity_id === context.currentIdentityId),
	);
}

async function completeCurrentDeviceSetup(
	store: MemoryStore,
	context: ReturnType<typeof captureCoordinatorEnrollmentContext>,
	options: EnrollmentSetupOptions,
) {
	const setup = await options.completeDeviceSetup({
		dbPath: store.dbPath,
		keysDir: context.keysDir,
		coordinatorUrl: options.config.syncCoordinatorUrl.trim(),
		groupId: options.groupId,
		currentIdentityId: context.currentIdentityId,
		fetch: (input, init) => {
			// Recheck between the client's GET and POST as well as on receipt recovery.
			context.assertCurrent();
			return globalThis.fetch(input, init);
		},
	});
	context.assertCurrent();
	if (setup.kind !== "complete" && setup.kind !== "completed" && setup.kind !== "unsupported") {
		throw new Error("cause" in setup ? setup.cause : `device_setup_${setup.kind}`);
	}
	return setup;
}

export async function completeCoordinatorEnrollmentSetup(
	store: MemoryStore,
	options: EnrollmentSetupOptions,
): Promise<
	| { enrollments: CoordinatorEnrollment[]; assertSnapshot: () => void }
	| { failure: { stage: "complete_device_setup" | "list_devices"; error: unknown } }
> {
	let stage: "complete_device_setup" | "list_devices" = "complete_device_setup";
	try {
		const context = captureCoordinatorEnrollmentContext(store, options);
		stage = "list_devices";
		let enrollments = await options.listDevices();
		stage = "complete_device_setup";
		context.assertCurrent();
		const hasLocalRow = enrollments.some(
			(enrollment) =>
				enrollment.group_id === options.groupId && enrollment.device_id === context.deviceId,
		);
		// An unregistered operator can still reconcile other devices. The existing
		// reconciler separately requires own-device proof before adopting the local Identity.
		if (!hasLocalRow) return { enrollments, assertSnapshot: context.assertCurrent };
		if (!hasOwnEnrollment(context, options.groupId, enrollments)) {
			stage = "complete_device_setup";
			const setup = await completeCurrentDeviceSetup(store, context, options);
			if (setup.kind === "unsupported") {
				throw new Error("coordinator_upgrade_required");
			}
			stage = "list_devices";
			enrollments = await options.listDevices();
			stage = "complete_device_setup";
			context.assertCurrent();
		}
		return {
			enrollments,
			assertSnapshot() {
				context.assertCurrent();
				if (!hasOwnEnrollment(context, options.groupId, enrollments)) {
					throw new Error("device_setup_enrollment_incomplete");
				}
			},
		};
	} catch (error) {
		return { failure: { stage, error } };
	}
}
