export const OpencodeMemPlugin = async ({ project, client, directory, worktree }) => {
  const events = []
  const maxEvents = Number.parseInt(
    process.env.OPENCODE_MEM_PLUGIN_MAX_EVENTS || "200",
    10
  )
  const maxChars = Number.parseInt(
    process.env.OPENCODE_MEM_PLUGIN_MAX_EVENT_CHARS || "8000",
    10
  )
  const cwd = worktree || directory || process.cwd()
  let sessionStartedAt = null

  const truncate = (value) => {
    if (value === undefined || value === null) {
      return null
    }
    const text = String(value)
    if (Number.isNaN(maxChars) || maxChars <= 0) {
      return ""
    }
    if (text.length <= maxChars) {
      return text
    }
    return `${text.slice(0, maxChars)}\n[opencode-mem] event truncated\n`
  }

  const safeStringify = (value) => {
    if (value === undefined || value === null) {
      return null
    }
    if (typeof value === "string") {
      return value
    }
    try {
      return JSON.stringify(value)
    } catch (err) {
      return String(value)
    }
  }

  const recordEvent = (event) => {
    events.push(event)
    if (Number.isFinite(maxEvents) && maxEvents > 0 && events.length > maxEvents) {
      events.splice(0, events.length - maxEvents)
    }
  }

  const flushEvents = async () => {
    if (!events.length) {
      return
    }
    const payload = {
      cwd,
      project: project?.root || project?.name || null,
      started_at: sessionStartedAt || new Date().toISOString(),
      events: [...events],
    }
    const input = JSON.stringify(payload)
    const proc = Bun.spawn({
      cmd: ["python", "-m", "opencode_mem.plugin_ingest"],
      cwd,
      env: process.env,
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    if (exitCode !== 0) {
      await client.app.log({
        service: "opencode-mem",
        level: "error",
        message: "Failed to ingest opencode-mem plugin events",
        extra: { exitCode, stdout, stderr },
      })
      return
    }
    events.length = 0
    sessionStartedAt = null
  }

  return {
    "session.created": async () => {
      sessionStartedAt = new Date().toISOString()
    },
    "tool.execute.after": async (input, output) => {
      const args = output?.args ?? input?.args ?? {}
      const result = output?.result ?? output?.output ?? output?.data ?? null
      const error = output?.error ?? null
      recordEvent({
        type: "tool.execute.after",
        tool: input?.tool || output?.tool || "unknown",
        args,
        result: truncate(safeStringify(result)),
        error: truncate(safeStringify(error)),
        timestamp: new Date().toISOString(),
      })
    },
    "session.idle": async () => {
      await flushEvents()
    },
    "session.error": async () => {
      await flushEvents()
    },
  }
}
