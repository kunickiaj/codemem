import { randomUUID } from "node:crypto";
import { CodememNotifications } from "../../rpc.js";

const DEFAULT_MAX_NOTICES = 32;
const DEFAULT_REGISTRATION_TIMEOUT_MS = 250;

const resolvePositiveInteger = (value, fallback) =>
  Number.isSafeInteger(value) && value > 0 ? value : fallback;

const disposeLateRegistration = (registrationTask) => {
  void registrationTask
    .then((registration) => registration.dispose())
    .catch(() => {
      // Timed-out advisory registration cleanup is best-effort.
    });
};

const registerWithinTimeout = async (context, handlers, timeoutMs) => {
  const registrationTask = Promise.resolve().then(() =>
    context.rpc.register(CodememNotifications, handlers)
  );
  let timeout;
  const timeoutTask = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    timeout.unref?.();
  });
  const result = await Promise.race([
    registrationTask.then(
      (registration) => ({ status: "registered", registration }),
      () => ({ status: "failed" })
    ),
    timeoutTask,
  ]);
  clearTimeout(timeout);
  if (result.status === "timeout") disposeLateRegistration(registrationTask);
  return result.status === "registered" ? result.registration : null;
};

export const createNotificationBacklog = ({
  maxNotices = DEFAULT_MAX_NOTICES,
  createID = randomUUID,
} = {}) => {
  const notices = [];
  const limit = Number.isSafeInteger(maxNotices) && maxNotices > 0 ? maxNotices : DEFAULT_MAX_NOTICES;
  let buffering = true;

  return {
    push({ message, variant }) {
      const notice = { id: createID(), message, variant };
      if (!buffering) return notice;
      notices.push(notice);
      while (notices.length > limit) notices.shift();
      return notice;
    },
    drain() {
      buffering = false;
      return notices.splice(0, notices.length);
    },
  };
};

export const registerV2NotificationBridge = async (context, options = {}) => {
  if (typeof context?.rpc?.register !== "function") {
    return { notify: null, registration: null };
  }

  const backlog = createNotificationBacklog(options);
  const registrationTimeoutMs = resolvePositiveInteger(
    options.registrationTimeoutMs,
    DEFAULT_REGISTRATION_TIMEOUT_MS
  );
  const registration = await registerWithinTimeout(
    context,
    { drain: async () => ({ notices: backlog.drain() }) },
    registrationTimeoutMs
  );
  if (!registration) {
    return { notify: null, registration: null };
  }

  let active = true;
  return {
    notify: async (input) => {
      if (!active) return;
      const notice = backlog.push(input);
      try {
        void Promise.resolve(registration.events.emit("notice", notice)).catch(() => {
          // Replay remains available when live publication fails.
        });
      } catch {
        // Replay remains available when live publication throws synchronously.
      }
    },
    registration: {
      async dispose() {
        active = false;
        try {
          await registration.dispose();
        } catch {
          // Notification cleanup must not fail the server plugin lifecycle.
        }
      },
    },
  };
};
