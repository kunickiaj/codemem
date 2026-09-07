import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DRAIN_LIMIT = 20;
const DEFAULT_MAX_ENTRIES = 2000;
const RAW_EVENT_SPOOL_FULL_CODE = "raw_event_spool_full";
const SPOOL_DIRECTORY_NAME = "opencode-raw-event-spool";
const spoolWritesInFlight = new Map();

const resolveSpoolDirectory = (homeDir = homedir()) =>
  join(homeDir, ".codemem", SPOOL_DIRECTORY_NAME);

const spoolFilename = (eventId) => {
  const digest = createHash("sha256").update(String(eventId)).digest("hex");
  return `${digest}.json`;
};

const requireEventId = (envelope) => {
  const eventId = typeof envelope?.event_id === "string"
    ? envelope.event_id.trim()
    : "";
  if (!eventId) {
    throw new Error("raw event spool requires event_id");
  }
  return eventId;
};

const ensurePrivateDirectory = async (directory) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
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

  await ensurePrivateDirectory(directory);
  try {
    const existing = await readFile(destination, "utf8");
    if (existing !== bytes) {
      throw new Error("raw event spool entry conflicts with existing event_id");
    }
    await chmod(destination, 0o600);
    return { eventId, serialized: existing };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const directoryEntries = await readdir(directory, { withFileTypes: true });
  const entryCount = directoryEntries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  ).length;
  if (entryCount >= normalizedMaxEntries) {
    const error = new Error("raw event spool is full");
    error.code = RAW_EVENT_SPOOL_FULL_CODE;
    throw error;
  }

  try {
    await writeFile(temporary, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const existing = await readFile(destination, "utf8");
      if (existing !== bytes) {
        throw new Error("raw event spool entry conflicts with existing event_id");
      }
      await chmod(destination, 0o600);
      return { eventId, serialized: existing };
    }
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }

  return { eventId, serialized: bytes };
};

const writeRawEventSpoolEntry = async (options) => {
  const directory = resolveSpoolDirectory(options?.homeDir);
  const previousWrite = spoolWritesInFlight.get(directory);
  const writePromise = (previousWrite ? previousWrite.catch(() => {}) : Promise.resolve())
    .then(() => writeRawEventSpoolEntryUnlocked(options));
  const trackedWrite = writePromise.finally(() => {
    if (spoolWritesInFlight.get(directory) === trackedWrite) {
      spoolWritesInFlight.delete(directory);
    }
  });
  spoolWritesInFlight.set(directory, trackedWrite);
  return trackedWrite;
};

const removeRawEventSpoolEntry = async ({ eventId, homeDir = homedir() }) => {
  const normalizedEventId = requireEventId({ event_id: eventId });
  await rm(
    join(resolveSpoolDirectory(homeDir), spoolFilename(normalizedEventId)),
    { force: true },
  );
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

  const candidates = [];
  for (const directoryEntry of directoryEntries) {
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
  RAW_EVENT_SPOOL_FULL_CODE,
  loadRawEventSpoolEntries,
  removeRawEventSpoolEntry,
  resolveSpoolDirectory,
  writeRawEventSpoolEntry,
};
