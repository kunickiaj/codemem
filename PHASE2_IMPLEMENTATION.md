# Phase 2 Implementation: Enhanced Observer Prompts

## Summary
Updated observer prompts to encourage comprehensive, narrative-style memories matching claude-mem quality.

## Changes Made

### 1. SYSTEM_IDENTITY (Lines 13-18)
**Before:** Generic "memory observer for a live coding session"
**After:** Emphasizes creating "searchable records FOR FUTURE SESSIONS" and explicitly states to record what was "BUILT/FIXED/DEPLOYED/CONFIGURED"

### 2. RECORDING_FOCUS (Lines 20-36)
**Before:** Single line about deliverables
**After:** 
- Bullet list of what to focus on (capabilities, shipped work, technical domains)
- Action verb guidance (implemented, fixed, deployed, etc.)
- **GOOD vs BAD examples** showing outcome-focused vs process-focused language
- Direct comparison: "Authentication now supports OAuth2" vs "Analyzed authentication implementation"

### 3. SKIP_GUIDANCE (Lines 38-44)
**Before:** Run-on sentence
**After:** Clean bullet list of what to skip

### 4. NEW: NARRATIVE_GUIDANCE (Lines 46-57)
**Added comprehensive guidance:**
- 6-point story structure (Context, Investigation, Learning, Implementation, Impact, Next steps)
- **Target word count: 200-800 words**
- Explicit instruction to "combine related work into cohesive narratives"
- Emphasis on specific details (file paths, function names, config values)

### 5. OUTPUT_GUIDANCE (Lines 59-63)
**Added:** "Prefer fewer, more comprehensive observations over many small ones"

### 6. OBSERVATION_SCHEMA (Lines 65-112)
**Before:** Brief schema with minimal guidance
**After:**
- XML comments with inline examples
- Detailed narrative structure with **5 sections** (Context, Investigation, Implementation, Impact, Next Steps)
- **Explicit word count target: 200-800 words**
- Guidance for each field (title, subtitle, facts, concepts)
- Examples of good vs bad titles in comments

### 7. SUMMARY_SCHEMA (Lines 114-143)
**Before:** Brief field descriptions
**After:**
- Detailed multi-line guidance for each field
- Specific questions to answer in each section
- **Target word count: 300-1000 words total**
- Explicit statement: "This summary helps future sessions understand where this work left off"

### 8. build_observer_prompt() (Lines 199-244)
**Before:** Dense concatenation with minimal spacing
**After:** Added blank lines between major sections for better readability

## Impact

### Prompt Length
- **Before:** ~2000 characters
- **After:** ~5700 characters (2.85x increase)

### Expected Memory Quality Improvements
- **Current avg:** 341 chars per memory
- **Target avg:** 500-700 chars per memory
- **Narrative depth:** From atomic events to comprehensive stories with context, investigation, learnings, and next steps

### Alignment with Claude-mem
- ✅ Explicit word count targets (matching claude-mem's comprehensive style)
- ✅ Good/bad examples (matching claude-mem's teaching approach)
- ✅ Multi-section narrative structure (matching claude-mem's depth)
- ✅ Emphasis on deliverables over process (matching claude-mem's philosophy)

## Testing
- ✅ All existing tests pass (23/23)
- ✅ Syntax validation successful
- ✅ Prompt generation verified with sample context

## Next Steps (Phase 1)
After monitoring memory quality improvements from these prompt changes:
1. Implement accumulation architecture (delayed flush strategy)
2. Add session metadata tracking
3. Enable longer work sessions to accumulate before creating memories

## Files Modified
- `opencode_mem/observer_prompts.py` (80 lines changed)

## Commit Message
```
Enhanced observer prompts for comprehensive narrative memories

Inspired by claude-mem's approach, updated observer prompts to encourage
longer, more comprehensive memories:

- Added NARRATIVE_GUIDANCE with 200-800 word target
- Enhanced OBSERVATION_SCHEMA with detailed structure
- Added good/bad examples for outcome-focused language
- Expanded SUMMARY_SCHEMA with 300-1000 word target
- Included inline XML comments with guidance

Expected impact: Increase avg memory length from 341 → 500-700 chars
by creating cohesive narratives instead of atomic observations.
```
