# Phase 1 Implementation: Accumulation Architecture

## Summary
Implemented delayed flush strategy to accumulate events during work sessions, creating comprehensive memories instead of atomic snapshots.

## Changes Made

### 1. Plugin Accumulation State (.opencode/plugin/opencode-mem.js)

**Added state tracking (after line 142):**
- `idleFlushDelayMs` - Configurable delay (default 5 min, env: `OPENCODE_MEM_IDLE_FLUSH_DELAY_MS`)
- `lastActivityTime` - Tracks last user/tool activity
- `idleFlushTimeout` - Timeout handle for scheduled flush
- `sessionContext` - Tracks session metadata:
  - `firstPrompt` - Initial user request
  - `promptCount` - Number of prompts in session
  - `toolCount` - Number of tool executions
  - `startTime` - Session start timestamp
  - `filesModified` - Set of modified file paths
  - `filesRead` - Set of read file paths

**Added helper functions:**
- `resetSessionContext()` - Clears session tracking
- `updateActivity()` - Updates activity timestamp and clears pending flush
- `scheduleIdleFlush()` - Schedules delayed flush after idle period

### 2. Updated Flush Strategy

**NEW BEHAVIOR:**
- **Flush immediately on:**
  - `session.error` - Error boundary
  - `/new` command - Explicit session reset
  - `session.created` - Session boundary

- **Flush with delay on:**
  - `session.idle` - Schedule flush after 5 min idle (configurable)

- **REMOVED flush triggers:**
  - `session.compacted` (too frequent)
  - `session.compacting` (too frequent)
  - `experimental.session.compacting` (too frequent)

**OLD BEHAVIOR:**
Flushed immediately on every idle/compaction (every 1-2 minutes)

### 3. Enhanced flushEvents() Function

**Additions:**
- Calculates session duration
- Includes `session_context` in payload with:
  - first_prompt, prompt_count, tool_count
  - duration_ms
  - files_modified[], files_read[]
- Enhanced logging with session metrics
- Calls `resetSessionContext()` after successful flush

### 4. Event Handler Updates

**Message events:**
- Calls `updateActivity()` on prompts and assistant messages
- Tracks `firstPrompt` and `promptCount` in sessionContext
- Schedules idle flush instead of immediate flush

**Tool events:**
- Calls `updateActivity()` on every tool execution
- Increments `toolCount`
- Tracks file paths from read/write/edit tools

### 5. Python Ingest Updates (opencode_mem/plugin_ingest.py)

**Additions:**
- Extracts `session_context` from payload
- Stores session_context in session metadata
- Builds human-readable session summary
- Prepends session context to observer prompt:
  ```
  [Session context: 3 prompts; 15 tool executions; ~8.5 minutes of work; Modified: foo.py, bar.ts]
  
  User request: Add OAuth authentication
  ```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_MEM_IDLE_FLUSH_DELAY_MS` | 300000 (5 min) | Delay before flushing after idle |

**Examples:**
```bash
# 10 minute accumulation
export OPENCODE_MEM_IDLE_FLUSH_DELAY_MS=600000

# 2 minute accumulation (more frequent memories)
export OPENCODE_MEM_IDLE_FLUSH_DELAY_MS=120000
```

## Impact

### Before (Atomic Mode)
- Flush every 1-2 minutes on compaction/idle
- 3-10 separate memories per work session
- Each memory sees 2-5 tool events
- No session context or narrative flow

### After (Accumulation Mode)
- Flush after 5+ minutes idle (or explicit boundaries)
- 1-3 comprehensive memories per work session
- Each memory sees 10-30+ tool events
- Full session context: prompts, duration, files, work flow

### Example Timeline

**Atomic mode (before):**
```
0:00 - User: "Add OAuth"
0:30 - Read 3 files → FLUSH (memory 1: "Read auth files")
2:00 - Edit 2 files → FLUSH (memory 2: "Modified auth code")  
4:00 - Run tests → FLUSH (memory 3: "Ran tests")
Result: 3 disconnected memories
```

**Accumulation mode (after):**
```
0:00 - User: "Add OAuth"
0:30 - Read 3 files
2:00 - Edit 2 files
4:00 - Run tests
5:00 - idle detected
10:00 - Still idle → FLUSH (memory 1: comprehensive narrative covering all work)
Result: 1 comprehensive memory with full story
```

## Alignment with Claude-mem

✅ **Accumulation strategy** - Both systems now collect many tool observations before creating memories  
✅ **Session context** - Plugin tracks session metadata like claude-mem's SDK sessions  
✅ **Delayed synthesis** - Memories created after meaningful work period, not immediately  
✅ **Configurable timing** - Idle delay is tunable like claude-mem's worker timing

## Testing

- ✅ All tests pass (23/23)
- ✅ Syntax validation (JS + Python)
- ✅ Linter passes (ruff)

**Manual testing needed:**
1. Do 10+ minutes of work without hitting /new
2. Wait for idle flush (5 min after last activity)
3. Check `opencode-mem recent` - should see 1 comprehensive memory with session context
4. Verify memory includes multiple prompts/tools/files

## Files Modified

- `.opencode/plugin/opencode-mem.js` (~100 lines changed)
  - Added accumulation state tracking
  - Updated flush strategy
  - Enhanced event handlers
  - Added session context tracking

- `opencode_mem/plugin_ingest.py` (~40 lines changed)
  - Extract session_context from payload
  - Build session summary for observer
  - Store session metadata

## Commit Message

```
Implement accumulation architecture for comprehensive memories

Adopted claude-mem's accumulation pattern: collect events over 5+ minute
work sessions instead of flushing immediately on every idle/compaction.

Plugin changes:
- Track session context (prompts, tools, duration, files)
- Delayed flush strategy (5 min idle, configurable)
- Remove frequent flush triggers (compacted, compacting)
- Activity tracking with updateActivity()

Python ingest changes:
- Extract and use session_context from plugin
- Prepend session summary to observer prompt
- Store session metadata

Expected impact: Reduce memories per session from 5-10 → 1-3, with
each memory covering complete work narratives instead of atomic events.

Config: OPENCODE_MEM_IDLE_FLUSH_DELAY_MS (default 300000ms / 5 min)
```

## Next Steps

1. **Test in real usage** - Monitor memory quality over next few days
2. **Tune idle delay** - Adjust if 5 min is too long/short
3. **Phase 3 (optional)** - Add explicit session summary synthesis step
4. **Monitor metrics:**
   - Avg memory length (target: 700+ chars)
   - Memories per session (target: 1-3)
   - Session context quality

## Rollback Plan

If accumulation causes issues:
```bash
# Revert to immediate flush mode by setting to 0
export OPENCODE_MEM_IDLE_FLUSH_DELAY_MS=0
```

Or revert git commits:
```bash
git revert HEAD~1  # Phase 1
git revert HEAD~2  # Phase 2
```
