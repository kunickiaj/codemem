# Default-on tiered routing design

**Date:** 2026-04-21  
**Status:** Approved design  
**Bead:** `codemem-kkd9`

## Problem

codemem already has replay-driven tier routing and a partial live config surface, but
 the runtime contract is still muddy in the places that matter for making it the
 default:

- provider versus runtime responsibility is mixed together
- OpenAI transport behavior is split between Responses and legacy completions-style behavior
- Claude sidecar compatibility is treated as uncertain even though Claude CLI can select a model explicitly
- fallback behavior is underspecified, which makes default-on risky and hard to debug

The result is a half-intentional matrix: rich OpenAI routing already prefers Responses,
 simple OpenAI routing still forces the older path, and Anthropic plus Claude sidecar
 support are only partly encoded in design language.

## Goals

- Make tiered routing default-on only where codemem has an explicit safe capability contract.
- Treat access path and runtime as the primary routing capability axis, not just model vendor.
- Respect explicit user settings over built-in defaults.
- Make fallback behavior visible and deterministic.
- Standardize OpenAI-capable API paths on Responses as the default transport.
- Define the follow-up slices needed to implement and validate the policy.

## Non-goals

- No change to promotion thresholds in this design.
- No attempt to keep legacy completions-style OpenAI transport as a recommended fallback path.
- No speculative support promise for unknown custom providers that do not map cleanly to an explicit capability class.

## Recommended approach

Use **capability-safe default-on tier routing**.

Defaults should only apply when the user has not made an explicit routing choice.
 codemem should enable tiered routing by default only for provider/runtime paths with
 an explicit capability mapping. Unknown or underspecified paths should remain
 conservative until mapped.

The key design decision is that the capability boundary is primarily the
 **access path/runtime class**, not the vendor name alone.

## Core decisions

### 1. Explicit user settings always win

Configuration precedence is:

1. explicit user settings
2. capability-safe built-in defaults
3. base fallback behavior when a requested tier config cannot be honored

This applies to:

- `observer_tier_routing_enabled`
- base `observer_provider`, `observer_model`, `observer_runtime`
- tier-specific provider/model fields
- tier-specific transport and tuning fields

If the user explicitly disables tier routing, codemem leaves it off. If the user
 explicitly enables it on an unusual path, codemem should honor that intent but still
 surface any runtime downgrade clearly.

### 2. Capability is determined by access path/runtime class

The design should stop framing support as “OpenAI safe, Anthropic maybe.”

The better rule is:

- API-backed paths are eligible for default-on when codemem has an explicit provider/runtime mapping.
- Claude subscription-backed Claude Code usage is its own runtime class and should be modeled through `claude_sidecar`.

### 3. Claude sidecar is eligible for default-on tiering

`claude_sidecar` is not a permanent exception. For Claude Code Pro/Max subscription
 usage, sidecar is the required runtime path, but Claude CLI already supports
 `--model`, which gives codemem the primitive it needs to choose different simple and
 rich models intentionally.

That makes `claude_sidecar` eligible for default-on tier routing as long as:

- codemem can pass an explicit tier-selected model
- the observer prompt/response contract remains reliable on sidecar
- codemem records the actual selected tier/model/runtime for debugging

### 4. OpenAI API paths should be Responses-first

For OpenAI-capable `api_http` paths, codemem should treat **Responses** as the
 default and preferred transport.

Completions-style behavior should not remain a built-in legacy fallback in this
 design. If older transport behavior still exists in code during migration, it should
 be treated as implementation debt or explicit user override behavior, not as the
 recommended default contract.

## Capability matrix

### Default-on when the user has not made an explicit choice

#### `api_http`

- **OpenAI API/models**
  - supported
  - tiered routing default-on
  - Responses-first for simple and rich tiers

- **Anthropic API/models**
  - supported
  - tiered routing default-on
  - native Anthropic Messages path

- **Compatible API-backed custom/provider gateway paths**
  - eligible only when codemem can classify them into an explicit supported capability class
  - do not assume universal safety for arbitrary custom providers

#### `claude_sidecar`

- **Claude Code Pro/Max subscription path via Claude CLI runtime**
  - supported
  - tiered routing default-on
  - simple/rich model selection is performed via `claude --model ...`

### Not default-on by default

- unknown/custom paths without an explicit capability mapping
- paths where codemem cannot confidently select a tier-specific model/runtime
- paths where the actual runtime/model selection cannot be verified or recorded

## Fallback and diagnostics contract

Fallback should be **visible, deterministic, and narrow**.

If tier routing is enabled but the selected path cannot honor the requested tier
 config, codemem should:

1. fall back to the base observer config
2. persist what was requested versus what actually ran
3. surface the fallback reason in diagnostics

Fallback should **not** mean trying random alternate transports or providers until
 something works. Pick one intended path. If that path is unsupported, degrade to the
 known-safe base config and say so.

### Required recorded metadata

- requested tier
- requested provider
- requested runtime
- requested model
- actual provider
- actual runtime
- actual model
- actual transport class
- fallback applied: yes/no
- fallback reason, when applicable
- routing reasons from the richness decision

### Example fallback reasons

- unsupported tier override for runtime
- unknown provider capability class
- configured tier model unavailable
- Claude sidecar rejected or did not recognize the requested model
- provider-specific transport setting requested on an incompatible path

## Transport policy by capability class

### OpenAI over `api_http`

- Responses is the default transport
- tiered routing uses Responses for both tiers by default
- no built-in legacy completions fallback in the intended product contract

### Anthropic over `api_http`

- use the native Anthropic Messages path
- tier routing changes model choice, not transport family

### Claude over `claude_sidecar`

- use Claude CLI as the runtime transport
- tier routing changes the `--model` selection

## User-facing behavior

When tier routing is enabled by built-in defaults, the UI and docs should describe it
 as an automatic optimization that depends on the current provider/runtime path.

When a fallback occurs, the system should not behave like nothing happened. The user
 should be able to tell:

- which tier codemem wanted
- what actually ran
- why codemem downgraded to the base config

This is especially important for debugging sidecar/model availability issues and for
 explaining why a configured rich-tier model was not actually used.

## Rejected alternatives

### Keep default-off until every path is perfect

Rejected because the repo already has enough evidence to make explicit safe cells
 default-on, and delaying all default behavior behind the weakest edge case slows the
 useful path.

### Universal default-on with broad silent fallback

Rejected because it creates too much surprise and too much hidden complexity,
 especially across custom providers and sidecar flows.

### Continue treating OpenAI completions-style transport as a peer default

Rejected because it preserves unnecessary transport bifurcation in the mainline
 product contract while codemem already wants a clearer capability matrix and
 Responses-first stance.

## Implementation outline

1. Encode the runtime/provider capability matrix in routing/config resolution.
2. Make default-on decisions conditional on explicit-user-choice detection.
3. Switch OpenAI-capable default transport behavior to Responses-first.
4. Add Claude sidecar simple/rich model mapping and runtime reporting.
5. Persist requested-versus-actual routing metadata plus fallback reason.
6. Update tests for capability gating, transport choice, sidecar routing, and diagnostics.
7. Update user-facing docs to explain automatic default-on behavior and visible fallback behavior.

## Follow-up slices

- capability matrix and config precedence implementation
- OpenAI Responses-first cleanup
- Claude sidecar tier-routing implementation and diagnostics
- docs and settings copy refresh for the new default behavior
