# Tiered Observer Settings UI Design

**Status:** Approved design
**Date:** 2026-04-08
**Related bead:** `codemem-b1f7`

## Context

codemem recently added tiered observer routing configuration so extraction can use
different model settings for simple versus rich batches. The config/runtime layer
already supports these keys, but the viewer settings UI still only exposes the
single-model observer configuration.

The missing viewer support creates a bad split-brain experience:

- config files can express tiered routing
- runtime behavior can use tiered routing
- the viewer cannot inspect or edit the same settings

The UI already uses task-oriented tabs and a global `Show advanced controls`
toggle. That structure is good enough to extend, but a flat dump of all tiered
settings would make the modal harder to scan and understand.

## Goals

- Expose the full tiered observer routing config in the viewer
- Keep the default settings view understandable for users who do not want to tune
  every routing knob
- Preserve the existing task-oriented settings structure
- Keep fallback/default behavior legible so users understand when base observer
  settings still apply

## Non-Goals

- Redesign the entire settings modal
- Add new routing logic or change tier-selection thresholds
- Add provider/model validation beyond the current viewer config validation model

## Config Surface To Expose

The viewer should support the same tier-routing fields already present in config
and runtime code:

- `observer_tier_routing_enabled`
- `observer_simple_model`
- `observer_simple_temperature`
- `observer_rich_model`
- `observer_rich_temperature`
- `observer_rich_openai_use_responses`
- `observer_rich_reasoning_effort`
- `observer_rich_reasoning_summary`
- `observer_rich_max_output_tokens`

## Design Decision

Add a new **Tiered observer routing** group to the existing **Processing** tab.

This feature belongs in Processing rather than Connection because it controls how
codemem chooses extraction settings for different batch shapes, not how the base
observer authenticates or connects.

### Group structure

Inside the Processing tab, the order should be:

1. Background processing interval
2. Tiered observer routing
3. Context pack limits (advanced only, existing)

### Tiered observer routing layout

The new group should contain:

1. **Enable tiered routing** checkbox
   - Primary control for the feature
   - Short helper text explaining that codemem can route simple batches to a
     cheaper/faster model and rich batches to a higher-quality model

2. **When disabled**
   - Show a short note that codemem uses the base observer settings from the
     Connection tab
   - Hide tier-specific sections

3. **When enabled**
   - Reveal two clearly labeled subsections:
     - **Simple tier**
     - **Rich tier**

### Simple tier subsection

Default-visible fields:

- `observer_simple_model`

Advanced-only fields:

- `observer_simple_temperature`

Helper text should explain that blank values fall back to codemem's routing
defaults or the base observer settings where applicable.

### Rich tier subsection

Default-visible fields:

- `observer_rich_model`
- `observer_rich_openai_use_responses`

Advanced-only fields:

- `observer_rich_temperature`
- `observer_rich_reasoning_effort`
- `observer_rich_reasoning_summary`
- `observer_rich_max_output_tokens`

Helper text should explain that the rich tier is intended for larger or more
complex replay batches and that blank values continue to use built-in defaults.

## Progressive Disclosure Rules

To avoid overwhelming the modal:

- Tier-specific controls are hidden unless `observer_tier_routing_enabled` is on
- Tuning-heavy numeric/reasoning controls remain hidden unless `Show advanced
  controls` is on
- The most important routing choices remain visible in the default view:
  - enable/disable toggle
  - simple model
  - rich model
  - rich Responses API toggle

This keeps the feature discoverable without turning the Processing tab into a
wall of specialist tuning fields.

## UX Copy Guidance

Use concise labels and helper text that describe intent, not internal jargon.

Recommended labels:

- `Enable tiered routing`
- `Simple tier model`
- `Simple tier temperature`
- `Rich tier model`
- `Use OpenAI Responses API for rich tier`
- `Rich tier temperature`
- `Rich tier reasoning effort`
- `Rich tier reasoning summary`
- `Rich tier max output tokens`

Recommended helper themes:

- explain what the toggle does in plain language
- explain that blank values keep defaults/fallbacks
- explain that rich-tier controls apply only when routing selects the rich tier

## Data Flow Changes

The viewer stack needs matching support across three layers:

### Viewer server

Add the tiered routing keys to config route handling so `/api/config` can:

- return saved values
- include defaults where appropriate
- accept validated updates for the new fields

Validation expectations:

- booleans for `observer_tier_routing_enabled` and
  `observer_rich_openai_use_responses`
- strings for model/reasoning fields
- numeric integer/number validation for token and temperature fields following
  existing route conventions

### UI state

Extend the settings form state and config-key mapping so the UI can:

- hydrate the new values from config/effective payloads
- track dirty state correctly
- serialize only changed values back to the API

### UI rendering

Render the tier routing group in the Processing tab using the existing field,
helper text, and advanced-control patterns.

## Testing Strategy

Minimum required coverage:

### Viewer server tests

- GET `/api/config` includes tiered routing values when configured
- POST `/api/config` accepts valid tiered routing updates
- POST `/api/config` rejects invalid types for new boolean/numeric fields

### UI tests or targeted UI validation

- tier sections stay hidden when routing is off
- tier sections appear when routing is on
- advanced-only tier controls follow the existing advanced toggle
- save payload includes the newly edited tiered keys

If automated UI tests are not already practical for this surface, at minimum the
implementation should be validated with targeted viewer-server tests plus a
manual viewer sanity pass.

## Documentation Impact

Update the user-facing settings docs so the viewer no longer implies that only
single-model observer settings are editable there.

The Settings modal section should mention:

- tiered routing lives under Processing
- simple/rich tier tuning exists
- advanced controls hide the more technical routing knobs

## Rejected Alternatives

### Separate nested tab for tier routing

Rejected because it adds navigation complexity for a single feature group and
breaks the current simple task-based information architecture.

### Flat advanced-only field dump

Rejected because it hides the feature relationship between the enable toggle and
the simple/rich tier settings, making the UI harder to understand.

### Put tier routing under Connection

Rejected because routing is a processing concern. Connection already owns base
provider/runtime/auth settings and should stay focused on that job.

## Implementation Outline

1. Add config-route support for the tiered keys in `packages/viewer-server`
2. Extend settings form state and config mapping in `packages/ui`
3. Add the Tiered observer routing group to the Processing tab
4. Wire conditional visibility and advanced-only controls
5. Update tests for new config API behavior and UI state handling
6. Update `docs/user-guide.md` to describe the new settings surface
