# Release v0.2.0: Comprehensive Narrative Memories

## Overview

This release transforms opencode-mem from atomic event logging to comprehensive narrative-style memories, inspired by claude-mem's accumulation and synthesis approach.

**Key improvement:** Memories now tell complete stories of your work sessions instead of capturing disconnected snapshots.

---

## What's New

### 🎯 Comprehensive Narrative Memories

**Before (v0.1.x):**
- Avg memory length: 341 chars
- 5-10 atomic memories per session
- Each memory captured 2-5 tool events
- No narrative flow or context

**After (v0.2.0):**
- Avg memory length: 700-900 chars (target)
- 1-3 comprehensive memories per session  
- Each memory captures 10-30+ tool events
- Full narrative with context, investigation, implementation, and outcomes

**Example transformation:**

*Old style (3 separate memories):*
```
Memory 1: "Read authentication files"
Memory 2: "Modified auth.py and oauth.py"
Memory 3: "Ran test suite"
```

*New style (1 comprehensive memory):*
```
OAuth2 PKCE flow added to authentication

Context: User requested OAuth2 authentication to replace basic auth.

Investigation: Examined auth.py, oauth.py, and config/auth.yml to understand
current authentication flow. Discovered basic auth implementation with no
OAuth support...

Implementation: Added OAuth2 with PKCE flow support in auth.py. Created
OAuthHandler class with token management... Modified 5 files including
tests/test_auth.py...

Impact: System now supports OAuth2 authentication with PKCE for enhanced
security. Users can authenticate via OAuth providers...

Next steps: Add refresh token rotation, implement token revocation endpoint.
```

---

## Features

### 🔄 Accumulation Architecture (Phase 1)

**Delayed flush strategy:**
- Events accumulate for 5+ minutes of work (configurable)
- Flush triggers: explicit boundaries (/new, errors) or 5 min idle
- Removed frequent flush on compaction (was every 1-2 min)

**Session context tracking:**
- First user prompt
- Prompt count & tool count
- Work session duration
- Files modified & read
- All included in observer context

**Configuration:**
```bash
# Tune accumulation delay (default: 5 minutes)
export OPENCODE_MEM_IDLE_FLUSH_DELAY_MS=300000

# Examples:
# 10 min: 600000
# 2 min:  120000
```

### ✨ Enhanced Observer Prompts (Phase 2)

**Comprehensive guidance for LLM observer:**
- 200-800 word target for narratives
- 6-point story structure (context, investigation, learning, implementation, impact, next steps)
- GOOD vs BAD examples showing outcome-focused language
- Explicit instructions to combine related work into cohesive narratives

**Prompt improvements:**
- System identity emphasizes "FOR FUTURE SESSIONS"
- Recording focus includes action verbs and examples
- Narrative guidance with detailed structure
- Summary schema expanded to 300-1000 word target

---

## Technical Details

### Plugin Changes (.opencode/plugin/opencode-mem.js)

```javascript
// New state tracking
const sessionContext = {
  firstPrompt: null,
  promptCount: 0,
  toolCount: 0,
  startTime: null,
  filesModified: new Set(),
  filesRead: new Set(),
};

// Activity tracking
updateActivity();  // Called on prompts, assistant messages, tool executions

// Delayed flush
scheduleIdleFlush();  // Schedules flush after idle period instead of immediate
```

### Python Changes (opencode_mem/plugin_ingest.py)

```python
# Extract session context
session_context = payload.get("session_context") or {}
first_prompt = session_context.get("first_prompt")
tool_count = session_context.get("tool_count", 0)
duration_ms = session_context.get("duration_ms", 0)

# Prepend to observer prompt
observer_prompt = f"[Session context: {session_info}]\n\n{user_request}"
```

### Observer Prompts (opencode_mem/observer_prompts.py)

- Prompt length increased: ~2000 → ~5700 chars
- Added NARRATIVE_GUIDANCE with story structure
- Enhanced schemas with inline examples
- Word count targets for narratives and summaries

---

## Migration Guide

### From v0.1.x

No breaking changes! Just update:

```bash
# Using uvx (recommended)
uvx --from git+ssh://git@github.com/kunickiaj/opencode-mem.git@v0.2.0 opencode-mem

# Or with pip
pip install --upgrade git+ssh://git@github.com/kunickiaj/opencode-mem.git@v0.2.0

# Or with uv (editable install)
cd opencode-mem
git pull
git checkout v0.2.0
uv sync
```

Your existing memories remain unchanged. New memories will use the improved format.

### Configuration (Optional)

Tune accumulation delay if 5 minutes doesn't fit your workflow:

```bash
# Add to your shell profile (.bashrc, .zshrc, etc.)
export OPENCODE_MEM_IDLE_FLUSH_DELAY_MS=300000  # 5 min (default)
```

---

## Comparison with Claude-mem

| Feature | Claude-mem | Opencode-mem v0.2.0 |
|---------|------------|---------------------|
| Avg memory length | 797 chars | 700-900 chars (target) |
| Accumulation pattern | ✅ SDK worker | ✅ Plugin delayed flush |
| Session context | ✅ Via SDK | ✅ Via session tracking |
| Comprehensive narratives | ✅ Multi-paragraph | ✅ 200-800 word target |
| Good/bad examples | ✅ In prompts | ✅ In prompts |
| Word count guidance | ✅ Explicit | ✅ Explicit |

---

## Testing

All existing tests pass:
- ✅ 23/23 pytest tests
- ✅ Syntax validation (Python + JavaScript)
- ✅ Linter passes (ruff)

Manual testing recommended:
1. Do 15-20 minutes of work without `/new`
2. Wait for idle flush (watch logs: `~/.opencode-mem/plugin.log`)
3. Check `opencode-mem recent` - should see comprehensive memories
4. Verify memory includes session context and narrative structure

---

## Known Issues

None at this time. Report issues at: https://github.com/kunickiaj/opencode-mem/issues

---

## Credits

Inspired by [claude-mem](https://github.com/kunickiaj/claude-mem)'s accumulation architecture and comprehensive memory approach.

---

## What's Next

**Planned for v0.3.0:**
- Optional explicit session summary synthesis (like claude-mem's summary-hook)
- Memory quality metrics and dashboard
- Configurable memory types and filters
- Enhanced file tracking with git integration

---

## Commits in This Release

- `ff66107` Implement accumulation architecture for comprehensive memories
- `fde4051` Enhanced observer prompts for comprehensive narrative memories

**Full Changelog:** https://github.com/kunickiaj/opencode-mem/compare/v0.1.1...v0.2.0
