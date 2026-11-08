import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const DEFAULT_DRAIN_LIMIT = 20;
const DEFAULT_MAX_ENTRIES = 2000;
const MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES = 16 * 1024 * 1024;
const INSPECTION_READ_CHUNK_BYTES = 64 * 1024;
const REJECTED_LOCK_RECORD_MAX_BYTES = 1024;
const REJECTED_LOCK_PURPOSE = "rejected-raw-event-v1";
const RAW_EVENT_SPOOL_FULL_CODE = "raw_event_spool_full";
const RAW_EVENT_SPOOL_CONFLICT_CODE = "raw_event_spool_conflict";
const SPOOL_DIRECTORY_NAME = "opencode-raw-event-spool";
const spoolWritesInFlight = new Map();

const resolveSpoolDirectory = (homeDir = homedir()) =>
  join(homeDir, ".codemem", SPOOL_DIRECTORY_NAME);

const spoolFilename = (eventId) => {
  const digest = createHash("sha256").update(String(eventId)).digest("hex");
  return `${digest}.json`;
};

const rejectedReasons = new Map([[400, "invalid_payload"], [413, "payload_too_large"]]);
const rejectedFilename = (eventId, status, reason) =>
  `rejected-${spoolFilename(eventId).slice(0, -5)}-${status}-${reason}.json`;

const parseRejectedFilename = (name) => {
  const match = /^rejected-([a-f0-9]{64})-(400|413)-(invalid_payload|payload_too_large)\.json$/.exec(name);
  if (!match) return null;
  const status = Number(match[2]);
  if (rejectedReasons.get(status) !== match[3]) return null;
  return { digest: match[1], status, reason: match[3] };
};

const requirePrivateSpoolDirectory = async (directory) => {
  for (const path of [dirname(directory), directory]) {
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error("raw event spool requires a real directory");
    }
  }
};

// Open without following links, then inspect the opened inode before reading it.
const readRegularSpoolFile = async (path, { makePrivate = false } = {}) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error("raw event spool requires a regular file");
    const bytes = await handle.readFile();
    if (!isUtf8(bytes)) throw new Error("raw event spool requires UTF-8 JSON");
    const serialized = bytes.toString("utf8");
    if (makePrivate) {
      await handle.chmod(0o600);
      await handle.sync();
    }
    return { serialized, details };
  } finally {
    await handle.close();
  }
};

const requireMatchingIdentity = (serialized, filename) => {
  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch (error) {
    error.spoolConflict = { branch: "rejected_identity", reason: "invalid_json" };
    throw error;
  }
  let eventId;
  try {
    eventId = requireEventId(envelope);
  } catch (error) {
    error.spoolConflict = { branch: "rejected_identity", reason: "invalid_shape" };
    throw error;
  }
  if (spoolFilename(eventId) !== filename) {
    throw conflictingEntry({ branch: "rejected_identity", reason: "identity_mismatch" });
  }
};

const rejectedMetadata = (name, entry, bytes) => ({
  receipt: name,
  bytes,
  status: entry.status,
  reason: entry.reason,
});

const requireEventId = (envelope) => {
  const eventId = typeof envelope?.event_id === "string"
    ? envelope.event_id.trim()
    : "";
  if (!eventId) {
    throw new Error("raw event spool requires event_id");
  }
  return eventId;
};

// Only literal paths from this schema may enter diagnostics. Payload values and
// unknown property names remain private even when retained JSON is malformed.
const CONFLICT_FIELDS = {
  started_at: true,
  host_generation: true,
  capture_context: true,
  session_stream_id: true,
  session_id: true,
  stream_id: true,
  opencode_session_id: true,
  cwd: true,
  project: true,
  source: true,
  event_type: true,
  payload: { timestamp: true, _adapter: { ts: true }, _raw_spooled: true, args: true },
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const changedConflictFields = (existing, incoming, schema = CONFLICT_FIELDS, prefix = "") => {
  const fields = [];
  let other = false;
  const left = { ...existing };
  const right = { ...incoming };
  for (const [key, child] of Object.entries(schema)) {
    const path = `${prefix}${key}`;
    const differs = Object.hasOwn(left, key) !== Object.hasOwn(right, key)
      || !isDeepStrictEqual(left[key], right[key]);
    if (differs && child === true) fields.push(path);
    else if (differs && isRecord(left[key]) && isRecord(right[key])) {
      const nested = changedConflictFields(left[key], right[key], child, `${path}.`);
      fields.push(...nested.fields);
      other ||= nested.other;
    } else if (differs) {
      fields.push(path);
      other = true;
    }
    delete left[key];
    delete right[key];
  }
  return { fields, other: other || !isDeepStrictEqual(left, right) };
};

/** Delivery timestamps can change when the same host event is captured again. */
const compareEventApartFromDeliveryTime = (existingBytes, incomingBytes) => {
  if (existingBytes === incomingBytes) return null;
  try {
    const existing = JSON.parse(existingBytes);
    const incoming = JSON.parse(incomingBytes);
    if (!isRecord(existing) || !isRecord(incoming)) return { reason: "invalid_shape" };
    const withoutDeliveryTime = ({ ts_wall_ms: _wall, ts_mono_ms: _mono, ...event }) => event;
    const left = withoutDeliveryTime(existing);
    const right = withoutDeliveryTime(incoming);
    if (isDeepStrictEqual(left, right)) return null;
    return { reason: "field_mismatch", ...changedConflictFields(left, right) };
  } catch {
    // Malformed retained data is not proof that the new event is already durable.
    return { reason: "invalid_json" };
  }
};

const conflictingEntry = (diagnostic) => {
  const error = new Error("raw event spool entry conflicts with existing event_id");
  error.code = RAW_EVENT_SPOOL_CONFLICT_CODE;
  if (diagnostic) error.spoolConflict = diagnostic;
  return error;
};

const ensurePrivateDirectory = async (directory) => {
  const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if (!firstCreated) return;
  const boundary = dirname(firstCreated);
  let current = directory;
  while (true) {
    await syncDirectory(current);
    if (current === boundary) return;
    current = dirname(current);
  }
};

const writeDurableFile = async (path, contents) => {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncDirectory = async (path) => {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32"
      && ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)
    ) return;
    throw error;
  } finally {
    await handle?.close();
  }
};

const atSpoolStage = async (stage, action) => {
  try {
    return await action();
  } catch (error) {
    if (error && typeof error === "object") error.spoolStage = stage;
    throw error;
  }
};

const readExistingEntry = async (directory, destination, bytes, eventId) => {
  try {
    return await atSpoolStage("existing_entry", async () => {
      const existing = await readFile(destination, "utf8");
      const mismatch = compareEventApartFromDeliveryTime(existing, bytes);
      if (mismatch) throw conflictingEntry({ branch: "active_comparison", ...mismatch });
      await chmod(destination, 0o600);
      await syncDirectory(directory);
      return { eventId, serialized: existing };
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
};

const readRejectedEntry = async (directory, name, eventId) => {
  try {
    const entry = await readRegularSpoolFile(join(directory, name), { makePrivate: true });
    requireMatchingIdentity(entry.serialized, spoolFilename(eventId));
    return entry;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const readMatchingRejectedEntry = async (directory, eventId, bytes) => {
  let existing = null;
  for (const [status, reason] of rejectedReasons) {
    const entry = await readRejectedEntry(directory, rejectedFilename(eventId, status, reason), eventId);
    if (!entry) continue;
    const mismatch = compareEventApartFromDeliveryTime(entry.serialized, bytes);
    if (mismatch) throw conflictingEntry({ branch: "rejected_comparison", ...mismatch });
    existing = { eventId, serialized: entry.serialized };
  }
  if (existing) await syncDirectory(directory);
  return existing;
};

const requireSpoolCapacity = async (directory, maxEntries) =>
  atSpoolStage("capacity", async () => {
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    const entryCount = directoryEntries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json"),
    ).length;
    if (entryCount < maxEntries) return;
    const error = new Error("raw event spool is full");
    error.code = RAW_EVENT_SPOOL_FULL_CODE;
    throw error;
  });

const publishSpoolEntry = async (temporary, destination, bytes) => {
  try {
    await atSpoolStage("temporary_write", () => writeDurableFile(temporary, bytes));
    await atSpoolStage("publish", async () => {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await readFile(destination, "utf8");
        const mismatch = compareEventApartFromDeliveryTime(existing, bytes);
        if (mismatch) throw conflictingEntry({ branch: "publish_comparison", ...mismatch });
        await chmod(destination, 0o600);
      }
      await chmod(destination, 0o600);
    });
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
};

const writeRawEventSpoolEntryUnlocked = async ({
  envelope,
  serialized,
  homeDir = homedir(),
  maxEntries = DEFAULT_MAX_ENTRIES,
}) => {
  const eventId = requireEventId(envelope);
  const directory = resolveSpoolDirectory(homeDir);
  const bytes = typeof serialized === "string" ? serialized : JSON.stringify(envelope);
  const normalizedMaxEntries = Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.trunc(maxEntries)
    : DEFAULT_MAX_ENTRIES;
  const destination = join(directory, spoolFilename(eventId));
  const temporary = join(
    directory,
    `.${spoolFilename(eventId)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await atSpoolStage("directory", () => ensurePrivateDirectory(directory));
  const existing = await readExistingEntry(directory, destination, bytes, eventId);
  const rejected = await atSpoolStage("existing_entry", () =>
    readMatchingRejectedEntry(directory, eventId, bytes));
  if (rejected || existing) return rejected || existing;
  await requireSpoolCapacity(directory, normalizedMaxEntries);
  await publishSpoolEntry(temporary, destination, bytes);
  await atSpoolStage("directory_sync", () => syncDirectory(directory));

  return { eventId, serialized: bytes };
};

const serializeSpoolMutation = (directory, action) => {
  const previousWrite = spoolWritesInFlight.get(directory);
  const writePromise = (previousWrite ? previousWrite.catch(() => {}) : Promise.resolve())
    .then(action);
  const trackedWrite = writePromise.finally(() => {
    if (spoolWritesInFlight.get(directory) === trackedWrite) {
      spoolWritesInFlight.delete(directory);
    }
  });
  spoolWritesInFlight.set(directory, trackedWrite);
  return trackedWrite;
};

const writeRawEventSpoolEntry = async (options) =>
  serializeSpoolMutation(resolveSpoolDirectory(options?.homeDir), () =>
    writeRawEventSpoolEntryUnlocked(options));

const requireSameInode = async (path, expected) => {
  const actual = await lstat(path);
  if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw conflictingEntry();
  }
};

const publishRejectedEntry = async (directory, source, destination, active) => {
  await requireSameInode(source, active.details);
  try {
    await link(source, destination);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const retained = await readRegularSpoolFile(destination, { makePrivate: true });
  if (retained.serialized !== active.serialized) {
    throw conflictingEntry();
  }
  // Both names must survive a crash before removing the active name.
  await atSpoolStage("rejected_directory_sync", () => syncDirectory(directory));
  await requireSameInode(destination, retained.details);
  await requireSameInode(source, active.details);
  await atSpoolStage("rejected_unlink", () => rm(source));
  await atSpoolStage("rejected_final_sync", () => syncDirectory(directory));
  return retained;
};

const retainRejectedRawEventSpoolEntryUnlocked = async ({ eventId, status, reason, homeDir }) => {
  const normalizedEventId = requireEventId({ event_id: eventId });
  if (!rejectedReasons.has(status) || rejectedReasons.get(status) !== reason) {
    throw new Error("unsupported raw event rejection");
  }
  const directory = resolveSpoolDirectory(homeDir);
  await requirePrivateSpoolDirectory(directory);
  await chmod(directory, 0o700);
  const name = rejectedFilename(normalizedEventId, status, reason);
  const source = join(directory, spoolFilename(normalizedEventId));
  let active;
  try {
    active = await readRegularSpoolFile(source, { makePrivate: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const retained = await readRejectedEntry(directory, name, normalizedEventId);
    if (!retained) throw error;
    await syncDirectory(directory);
    return rejectedMetadata(name, { status, reason }, retained.details.size);
  }
  requireMatchingIdentity(active.serialized, spoolFilename(normalizedEventId));
  for (const [otherStatus, otherReason] of rejectedReasons) {
    if (otherStatus === status) continue;
    const other = await readRejectedEntry(directory,
      rejectedFilename(normalizedEventId, otherStatus, otherReason), normalizedEventId);
    if (other) throw conflictingEntry();
  }
  const retained = await publishRejectedEntry(directory, source, join(directory, name), active);
  return rejectedMetadata(name, { status, reason }, retained.details.size);
};

const retainRejectedRawEventSpoolEntry = async (options) =>
  serializeSpoolMutation(resolveSpoolDirectory(options?.homeDir), async () => {
    const digest = spoolFilename(requireEventId({ event_id: options.eventId })).slice(0, -5);
    const lock = await acquireRejectedSpoolLock(resolveSpoolDirectory(options.homeDir), digest);
    let outcome;
    try {
      outcome = { retained: await retainRejectedRawEventSpoolEntryUnlocked(options) };
    } catch (error) {
      outcome = { error };
    }
    try {
      await releaseRejectedSpoolLock(lock);
    } catch {
      if ("retained" in outcome) return { ...outcome.retained, lock: "release_failed" };
      try {
        Object.defineProperty(outcome.error, "lock", {
          value: "release_failed", enumerable: true, configurable: true, writable: true,
        });
      } catch {
        // Preserve the primary failure even when it is frozen or is a thrown primitive.
      }
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.retained;
  });

class RawEventSpoolInspectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RawEventSpoolInspectionError";
    this.code = code;
  }
}

const inspectionFailure = () => new RawEventSpoolInspectionError(
  "inspection_failed", "Could not inspect retained events. Files were left untouched.",
);

const requireInspectionRegularFile = (details) => {
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new RawEventSpoolInspectionError("unsafe_entry", "Receipt must name a regular file.");
  }
};

const openRejectedEntryForInspection = async (path) => {
  const expected = await lstat(path);
  requireInspectionRegularFile(expected);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    // lstat also rejects links where O_NOFOLLOW is unavailable. Check both the
    // opened file and its current name before reading any private bytes.
    for (const actual of [await handle.stat(), await lstat(path)]) {
      requireInspectionRegularFile(actual);
      if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
        throw new RawEventSpoolInspectionError("unsafe_entry", "Receipt changed while opening. Retry inspection.");
      }
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
};

const readWithinInspectionLimit = async (handle, maxBytes, { position = null } = {}) => {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.alloc(Math.min(INSPECTION_READ_CHUNK_BYTES, maxBytes + 1 - total));
    const offset = position === null ? null : position + total;
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maxBytes) return null;
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return null;
};

const inspectOpenedRejectedEntry = async (handle, receipt, entry, maxBytes) => {
  const before = await handle.stat();
  requireInspectionRegularFile(before);
  const metadata = rejectedMetadata(receipt, entry, before.size);
  if (before.size > maxBytes) return { ...metadata, validation: "read_limit_exceeded" };
  const bytes = await readWithinInspectionLimit(handle, maxBytes);
  const after = await handle.stat();
  if (!bytes || after.size > maxBytes) {
    return { ...metadata, bytes: after.size, validation: "read_limit_exceeded" };
  }
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    return { ...metadata, validation: "changed_during_read" };
  }
  try {
    if (!isUtf8(bytes)) return { ...metadata, validation: "invalid" };
    const serialized = bytes.toString("utf8");
    requireMatchingIdentity(serialized, `${entry.digest}.json`);
    return { ...metadata, validation: "valid", serialized };
  } catch {
    return { ...metadata, validation: "invalid" };
  }
};

const inspectRejectedRawEventSpoolEntry = async ({
  receipt, homeDir = homedir(), maxBytes = MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES,
}) => {
  const entry = typeof receipt === "string" ? parseRejectedFilename(receipt) : null;
  if (!entry) {
    throw new RawEventSpoolInspectionError("invalid_receipt", "Use a receipt from capture list-rejected.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES) {
    throw new RawEventSpoolInspectionError("invalid_limit", "Inspection limit must be between 1 byte and 16 MiB.");
  }
  let handle;
  try {
    const directory = resolveSpoolDirectory(homeDir);
    await requirePrivateSpoolDirectory(directory);
    handle = await openRejectedEntryForInspection(join(directory, receipt));
    return await inspectOpenedRejectedEntry(handle, receipt, entry, maxBytes);
  } catch (error) {
    if (error instanceof RawEventSpoolInspectionError) throw error;
    if (error?.code === "ENOENT") {
      throw new RawEventSpoolInspectionError("receipt_not_found", "Retained receipt was not found. Run capture list-rejected again.");
    }
    throw inspectionFailure();
  } finally {
    await handle?.close().catch(() => {});
  }
};

const sameFileSnapshot = (actual, expected) => actual.isFile()
  && !actual.isSymbolicLink()
  && actual.dev === expected.dev && actual.ino === expected.ino
  && actual.size === expected.size
  && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs;

const rejectedLockError = (code) => new RawEventSpoolInspectionError(
  code, "Retained event lock is unavailable. Stop capture before repairing its lock.",
);

const classifyExistingRejectedLock = async (path, digest) => {
  let handle;
  try {
    handle = await openRejectedEntryForInspection(path);
    const before = await handle.stat();
    if (before.size > REJECTED_LOCK_RECORD_MAX_BYTES) throw rejectedLockError("lock_repair_required");
    const bytes = await readWithinInspectionLimit(handle, REJECTED_LOCK_RECORD_MAX_BYTES);
    if (!bytes || !isUtf8(bytes) || !sameFileSnapshot(await handle.stat(), before)
      || !sameFileSnapshot(await lstat(path), before)) throw rejectedLockError("lock_repair_required");
    const record = JSON.parse(bytes.toString("utf8"));
    if (!record || Object.keys(record).sort().join() !== "digest,pid,purpose,token,version"
      || record.purpose !== REJECTED_LOCK_PURPOSE || record.version !== 1 || record.digest !== digest
      || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || typeof record.token !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.token)) {
      throw rejectedLockError("lock_repair_required");
    }
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return "lock_repair_required";
    }
    return "lock_busy";
  } catch {
    return "lock_repair_required";
  } finally {
    await handle?.close().catch(() => {});
  }
};

const acquireRejectedSpoolLock = async (directory, digest) => {
  await requirePrivateSpoolDirectory(directory);
  const path = join(directory, `.rejected-${digest}.lock`);
  let handle;
  try {
    handle = await open(path, "wx+", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw rejectedLockError(await classifyExistingRejectedLock(path, digest));
    throw rejectedLockError("lock_failed");
  }
  try {
    const serialized = JSON.stringify({
      purpose: REJECTED_LOCK_PURPOSE, version: 1, digest, pid: process.pid, token: randomUUID(),
    });
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    const details = await handle.stat();
    requireInspectionRegularFile(details);
    await requirePrivateSpoolDirectory(directory);
    if (!sameFileSnapshot(await lstat(path), details)) throw rejectedLockError("lock_repair_required");
    return { directory, path, handle, serialized, details };
  } catch {
    // An incomplete or unverifiable named lock needs manual repair, never age-based removal.
    await handle.close().catch(() => {});
    throw rejectedLockError("lock_repair_required");
  }
};

const assertRejectedSpoolLock = async (lock) => {
  await requirePrivateSpoolDirectory(lock.directory);
  const bytes = await readWithinInspectionLimit(lock.handle, REJECTED_LOCK_RECORD_MAX_BYTES, { position: 0 });
  if (!bytes || bytes.toString("utf8") !== lock.serialized
    || !sameFileSnapshot(await lock.handle.stat(), lock.details)
    || !sameFileSnapshot(await lstat(lock.path), lock.details)) {
    throw rejectedLockError("lock_release_failed");
  }
};

const releaseRejectedSpoolLock = async (lock) => {
  try {
    await assertRejectedSpoolLock(lock);
    await rm(lock.path);
    await syncDirectory(lock.directory);
  } catch {
    throw rejectedLockError("lock_release_failed");
  } finally {
    await lock.handle.close().catch(() => {});
  }
};

const deliveryAcknowledgement = async (deliver, serialized) => {
  let result;
  try {
    result = await deliver({ serialized });
  } catch {
    return { delivery: "unacknowledged", cleanup: "not_attempted", reason: "delivery_failed" };
  }
  try {
    const isRecord = result && typeof result === "object" && !Array.isArray(result);
    const keys = isRecord ? Reflect.ownKeys(result).sort().join() : "";
    const acknowledged = isRecord ? Object.getOwnPropertyDescriptor(result, "acknowledged")?.value : undefined;
    const acknowledgement = isRecord ? Object.getOwnPropertyDescriptor(result, "acknowledgement")?.value : undefined;
    if (result === false || (keys === "acknowledged" && acknowledged === false)) {
      return { delivery: "unacknowledged", cleanup: "not_attempted", reason: "delivery_rejected" };
    }
    if (keys === "acknowledged,acknowledgement" && acknowledged === true
      && ["queued", "ingested"].includes(acknowledgement)) {
      return { delivery: "accepted", acknowledgement };
    }
  } catch {
    // An exception while inspecting the result does not confirm delivery.
  }
  return { delivery: "unacknowledged", cleanup: "not_attempted", reason: "invalid_acknowledgement" };
};

const finishRecoveredSnapshot = async (snapshot, lock, { keepReceipt }) => {
  let current;
  try {
    await requirePrivateSpoolDirectory(snapshot.directory);
    current = await openRejectedEntryForInspection(snapshot.path);
    if (!sameFileSnapshot(await snapshot.handle.stat(), snapshot.details)
      || !sameFileSnapshot(await current.stat(), snapshot.details)) return "changed";
    const bytes = await readWithinInspectionLimit(current, MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES);
    if (!bytes?.equals(Buffer.from(snapshot.serialized, "utf8"))
      || createHash("sha256").update(bytes).digest("hex") !== snapshot.digest
      || !sameFileSnapshot(await current.stat(), snapshot.details)
      || !sameFileSnapshot(await lstat(snapshot.path), snapshot.details)) return "changed";
  } catch (error) {
    if (error instanceof RawEventSpoolInspectionError || ["ENOENT", "ELOOP"].includes(error?.code)) return "changed";
    return "failed";
  } finally {
    await current?.close().catch(() => {});
  }
  try {
    await assertRejectedSpoolLock(lock);
    if (!sameFileSnapshot(await lstat(snapshot.path), snapshot.details)) return "changed";
    if (keepReceipt === true) return "kept";
    await rm(snapshot.path);
  } catch {
    return "failed";
  }
  try {
    await syncDirectory(snapshot.directory);
    return "removed";
  } catch {
    return "uncertain";
  }
};

const deliverRejectedSnapshot = async ({ directory, receipt, entry, deliver, keepReceipt }, lock) => {
  let handle;
  try {
    const path = join(directory, receipt);
    handle = await openRejectedEntryForInspection(path);
    const details = await handle.stat();
    const inspection = await inspectOpenedRejectedEntry(handle, receipt, entry, MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES);
    if (inspection.validation !== "valid") {
      return { delivery: "not_attempted", cleanup: "not_attempted", reason: inspection.validation };
    }
    if (!sameFileSnapshot(await handle.stat(), details) || !sameFileSnapshot(await lstat(path), details)) {
      return { delivery: "not_attempted", cleanup: "not_attempted", reason: "changed_during_read" };
    }
    const snapshot = { directory, path, handle, details, serialized: inspection.serialized,
      digest: createHash("sha256").update(inspection.serialized, "utf8").digest("hex") };
    const delivery = await deliveryAcknowledgement(deliver, snapshot.serialized);
    if (delivery.delivery !== "accepted") return delivery;
    return { ...delivery, cleanup: await finishRecoveredSnapshot(snapshot, lock, { keepReceipt }) };
  } finally {
    await handle?.close().catch(() => {});
  }
};

const recoveryFailure = (error) => {
  const safeCodes = ["lock_busy", "lock_repair_required", "lock_failed", "unsafe_entry"];
  let reason = "inspection_failed";
  if (error instanceof RawEventSpoolInspectionError && safeCodes.includes(error.code)) reason = error.code;
  if (error?.code === "ENOENT") reason = "receipt_not_found";
  return { delivery: "not_attempted", cleanup: "not_attempted", reason };
};

const recoverRejectedEntryUnlocked = async (options) => {
  let lock;
  let result;
  try {
    lock = await acquireRejectedSpoolLock(options.directory, options.entry.digest);
    result = await deliverRejectedSnapshot(options, lock);
  } catch (error) {
    result = recoveryFailure(error);
  }
  if (!lock) return { ...result, lock: "not_acquired" };
  try {
    await releaseRejectedSpoolLock(lock);
    return { ...result, lock: "released" };
  } catch {
    return { ...result, lock: "release_failed" };
  }
};

const recoverRejectedRawEventSpoolEntry = async ({ receipt, homeDir = homedir(), deliver, keepReceipt } = {}) => {
  const entry = typeof receipt === "string" ? parseRejectedFilename(receipt) : null;
  if (!entry || typeof deliver !== "function") {
    return { delivery: "not_attempted", cleanup: "not_attempted", lock: "not_acquired",
      reason: entry ? "invalid_delivery" : "invalid_receipt" };
  }
  try {
    const directory = resolveSpoolDirectory(homeDir);
    return await serializeSpoolMutation(directory, () =>
      recoverRejectedEntryUnlocked({ directory, receipt, entry, deliver, keepReceipt }));
  } catch (error) {
    return { ...recoveryFailure(error), lock: "not_acquired" };
  }
};

const listRejectedEntries = async ({ homeDir, validation }) => {
  const directory = resolveSpoolDirectory(homeDir);
  let names;
  try {
    await requirePrivateSpoolDirectory(directory);
    names = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const candidate of names) {
    const entry = parseRejectedFilename(candidate.name);
    if (!candidate.isFile() || !entry) continue;
    try {
      if (validation === "metadata") {
        const details = await lstat(join(directory, candidate.name));
        if (details.isFile()) {
          entries.push({ ...rejectedMetadata(candidate.name, entry, details.size), validation: "not_checked" });
        }
        continue;
      }
      const retained = await readRegularSpoolFile(join(directory, candidate.name));
      requireMatchingIdentity(retained.serialized, `${entry.digest}.json`);
      entries.push(rejectedMetadata(candidate.name, entry, retained.details.size));
    } catch {
      // Invalid or concurrently removed files expose no payload or filesystem details.
    }
  }
  return entries.sort((left, right) => left.receipt.localeCompare(right.receipt));
};

const listRejectedRawEventSpoolEntries = async ({ homeDir = homedir(), validation = "payload" } = {}) => {
  if (!["metadata", "payload"].includes(validation)) {
    throw new RawEventSpoolInspectionError("invalid_validation", "Unsupported inspection mode.");
  }
  try {
    return await listRejectedEntries({ homeDir, validation });
  } catch (error) {
    if (validation === "payload") throw error;
    throw inspectionFailure();
  }
};

const removeRawEventSpoolEntry = async ({ eventId, homeDir = homedir() }) => {
  const normalizedEventId = requireEventId({ event_id: eventId });
  await rm(
    join(resolveSpoolDirectory(homeDir), spoolFilename(normalizedEventId)),
    { force: true },
  );
};

const findActiveSpoolCandidates = async (directory, directoryEntries) => {
  const candidates = [];
  for (const directoryEntry of directoryEntries) {
    if (parseRejectedFilename(directoryEntry.name)) continue;
    if (!directoryEntry.isFile() || !directoryEntry.name.endsWith(".json")) {
      continue;
    }
    const path = join(directory, directoryEntry.name);
    try {
      const details = await stat(path);
      candidates.push({ path, mtimeMs: details.mtimeMs, name: directoryEntry.name });
    } catch {
      // A concurrently removed entry needs no recovery attempt.
    }
  }
  candidates.sort(
    (left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
  );
  return candidates;
};

const loadRawEventSpoolEntries = async ({
  homeDir = homedir(),
  limit = DEFAULT_DRAIN_LIMIT,
} = {}) => {
  const directory = resolveSpoolDirectory(homeDir);
  let directoryEntries;
  try {
    directoryEntries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { entries: [], corruptCount: 0 };
    }
    throw error;
  }

  const candidates = await findActiveSpoolCandidates(directory, directoryEntries);

  const entries = [];
  let corruptCount = 0;
  const normalizedLimit = Number.isFinite(limit) && limit > 0
    ? Math.trunc(limit)
    : 0;
  for (const candidate of candidates) {
    if (entries.length >= normalizedLimit) {
      break;
    }
    try {
      const serialized = await readFile(candidate.path, "utf8");
      const envelope = JSON.parse(serialized);
      const eventId = requireEventId(envelope);
      if (candidate.name !== spoolFilename(eventId)) {
        corruptCount += 1;
        continue;
      }
      entries.push({ eventId, envelope, serialized });
    } catch {
      corruptCount += 1;
    }
  }

  return { entries, corruptCount };
};

export {
  DEFAULT_DRAIN_LIMIT,
  DEFAULT_MAX_ENTRIES,
  inspectRejectedRawEventSpoolEntry,
  listRejectedRawEventSpoolEntries,
  loadRawEventSpoolEntries,
  MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES,
  RAW_EVENT_SPOOL_CONFLICT_CODE,
  RAW_EVENT_SPOOL_FULL_CODE,
  RawEventSpoolInspectionError,
  recoverRejectedRawEventSpoolEntry,
  removeRawEventSpoolEntry,
  resolveSpoolDirectory,
  retainRejectedRawEventSpoolEntry,
  writeRawEventSpoolEntry,
};
