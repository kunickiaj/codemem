import { statSync } from "node:fs";
import {
	fingerprintPublicKey,
	LocalIdentitySupersededError,
	loadRuntimeSigningPublicKey,
	type MemoryStore,
	readAccountLinkDevice,
	readCodememConfigFile,
	type readCoordinatorSyncConfig,
} from "@codemem/core";

export type CoordinatorEnrollmentConfig = Pick<
	ReturnType<typeof readCoordinatorSyncConfig>,
	"syncEnabled" | "syncCoordinatorUrl" | "syncCoordinatorGroups" | "syncCoordinatorAdminSecret"
>;
interface EnrollmentSetupOptions {
	config: CoordinatorEnrollmentConfig;
	readConfig: () => CoordinatorEnrollmentConfig;
	keysDir: () => string | undefined;
	groupId: string;
}

function readLocalDevice(store: MemoryStore, keysDir: string | undefined) {
	try {
		const before = statSync(store.dbPath, { bigint: true });
		const device = readAccountLinkDevice(store.dbPath);
		const key = loadRuntimeSigningPublicKey(store.db, { deviceId: store.deviceId, keysDir });
		const after = statSync(store.dbPath, { bigint: true });
		if (
			!before.isFile() ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			device.deviceId !== store.deviceId ||
			!key ||
			fingerprintPublicKey(key) !== device.fingerprint
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
		// The first switch creates this table. A read must not create it.
		if (error instanceof Error && error.message.includes("no such table")) return null;
		throw error;
	}
}

function currentOperationConfig(store: MemoryStore, options: EnrollmentSetupOptions) {
	store.assertLocalIdentityCurrent();
	const config = options.readConfig();
	if (
		!store.hasCurrentConfiguredIdentity() ||
		config.syncEnabled !== options.config.syncEnabled ||
		config.syncCoordinatorAdminSecret !== options.config.syncCoordinatorAdminSecret ||
		config.syncCoordinatorUrl !== options.config.syncCoordinatorUrl ||
		JSON.stringify(config.syncCoordinatorGroups) !==
			JSON.stringify(options.config.syncCoordinatorGroups)
	) {
		throw new Error("device_setup_context_changed");
	}
	return config;
}

export function captureCoordinatorEnrollmentContext(
	store: MemoryStore,
	options: EnrollmentSetupOptions,
) {
	const capture = () => {
		const config = currentOperationConfig(store, options);
		const { dbPath, deviceId, actorId } = store;
		const keysDir = options.keysDir();
		const { device, fileIdentity } = readLocalDevice(store, keysDir);
		return {
			dbPath,
			deviceId,
			identityId: actorId,
			keysDir,
			groupId: options.groupId,
			coordinatorUrl: config.syncCoordinatorUrl,
			fingerprint: device.fingerprint,
			pin: JSON.stringify([
				dbPath,
				device,
				actorId,
				keysDir,
				fileIdentity,
				identityGeneration(store),
				readCodememConfigFile().actor_id,
				process.env.CODEMEM_DB,
				process.env.CODEMEM_CONFIG,
				process.env.HOME,
				process.env.CODEMEM_SYNC_KEY_STORE,
				process.env.CODEMEM_ACTOR_ID,
				process.env.CODEMEM_DEVICE_ID,
			]),
		};
	};
	const initial = capture();
	const assertCurrent = () => {
		try {
			const current = capture();
			if (current.pin === initial.pin) return;
		} catch (error) {
			if (error instanceof LocalIdentitySupersededError) throw error;
		}
		throw new Error("device_setup_context_changed");
	};
	return { ...initial, assertCurrent };
}
