import { spawn as nodeSpawn } from "node:child_process";

const KILL_GRACE_MS = 5_000;

const collectOutput = (proc) => {
  const output = { stdout: "", stderr: "" };
  // Guard stdio access: a hard spawn failure (ENOENT) can hand back null
  // streams, and a synchronous null-deref here would reject the promise
  // that callers await for a resolved { exitCode, stdout, stderr }.
  if (proc.stdout) proc.stdout.on("data", (chunk) => { output.stdout += chunk; });
  if (proc.stderr) proc.stderr.on("data", (chunk) => { output.stderr += chunk; });
  // Absorb async stream errors (e.g. EPIPE when the child exits mid-write,
  // or a spawn failure surfacing on a pipe). Without these handlers an
  // unhandled stream "error" event would crash the host process. The
  // child-level proc.once("error") still resolves the promise.
  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
    if (stream && typeof stream.on === "function") stream.on("error", () => {});
  }
  return output;
};

/** Write and close stdin; returns a failure result, or null when stdin is closed. */
const writeStdin = (proc, stdinText) => {
  const fail = (step, error) => {
    try { proc.kill(); } catch { /* ignore */ }
    return { exitCode: 1, stdout: "", stderr: `stdin ${step} failed: ${String(error)}` };
  };
  if (typeof stdinText === "string") {
    try {
      proc.stdin.write(stdinText);
    } catch (error) {
      return fail("write", error);
    }
  }
  try {
    proc.stdin.end();
  } catch (error) {
    return fail("close", error);
  }
  return null;
};

/** SIGTERM now, SIGKILL after a grace period; `clear` cancels the pending SIGKILL. */
const createTerminator = (proc) => {
  let killTimer = null;
  return {
    terminate: () => {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      }, KILL_GRACE_MS);
      if (killTimer.unref) killTimer.unref();
    },
    clear: () => {
      if (killTimer) clearTimeout(killTimer);
    },
  };
};

const settleOnExit = (proc, { output, signal, timeoutMs, resolve }) => {
  const terminator = createTerminator(proc);
  const state = { timedOut: false, aborted: false, settled: false };
  let timer = null;
  const onAbort = () => {
    state.aborted = true;
    terminator.terminate();
  };
  const finish = (result) => {
    if (state.settled) return;
    state.settled = true;
    if (timer) clearTimeout(timer);
    terminator.clear();
    signal?.removeEventListener("abort", onAbort);
    resolve(result);
  };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      state.timedOut = true;
      terminator.terminate();
    }, timeoutMs);
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  proc.once("exit", (exitCode) => {
    if (state.aborted) {
      finish({ exitCode: null, stdout: output.stdout, stderr: "aborted", aborted: true });
      return;
    }
    finish({
      exitCode: state.timedOut ? null : exitCode,
      stdout: output.stdout,
      stderr: state.timedOut ? "timeout" : output.stderr,
    });
  });
  proc.once("error", (err) => {
    finish({ exitCode: 1, stdout: "", stderr: String(err) });
  });
};

/**
 * Run one command and resolve `{ exitCode, stdout, stderr }`; never rejects.
 * `exitCode` is null after a timeout (`stderr: "timeout"`) or an abort
 * (`stderr: "aborted"`, `aborted: true`). Abort and timeout send SIGTERM,
 * then SIGKILL if the child is still running five seconds later. `defaults`
 * supplies cwd and timeoutMs when `options` leaves them undefined.
 */
export const runChildCommand = (cmd, options = {}, defaults = {}) => {
  const {
    cwd = defaults.cwd,
    env = process.env,
    signal = null,
    stdinText = null,
    timeoutMs = defaults.timeoutMs,
  } = options;
  const [command, ...args] = cmd;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "aborted", aborted: true });
      return;
    }
    const proc = nodeSpawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const output = collectOutput(proc);
    const stdinFailure = writeStdin(proc, stdinText);
    if (stdinFailure) {
      resolve(stdinFailure);
      return;
    }
    settleOnExit(proc, { output, signal, timeoutMs, resolve });
  });
};
