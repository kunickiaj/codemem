# Bug Report: Certain Agent Frontmatter Fields Break Bedrock via OpenAI-Compatible Providers

## Summary

When using custom agents with OpenAI-compatible providers that proxy to AWS Bedrock (via LiteLLM), certain YAML frontmatter fields cause requests to fail with: `"The format of the additionalModelRequestFields field is invalid. Provide a json object for additionalModelRequestFields"`

## Environment

- **OpenCode Version**: [current version]
- **Provider**: Custom OpenAI-compatible provider (custom-gateway)
- **Backend**: AWS Bedrock (via LiteLLM)
- **Model**: `global.anthropic.claude-opus-4-5-20251101-v1:0`
- **Agent Source**: [OpenAgents](https://github.com/darrenhinde/OpenAgents)

## Root Cause

Per the [Agent documentation](https://opencode.ai/docs/agents/#additional):
> "Any other options you specify in your agent configuration will be **passed through directly** to the provider as model options."

Certain frontmatter fields are being passed to the provider and end up in the `additionalModelRequestFields` parameter sent to Bedrock. When LiteLLM serializes these fields, some get malformed, causing Bedrock to reject the request.

## Reproduction

### Working Configuration (✅)

```yaml
---
id: test-agent
name: TestAgent
description: "Test agent"
mode: primary
temperature: 0.2
tags:
  - testing
tools:
  read: true
permission:
  bash:
    "*": "deny"
---
```

### Broken Configurations (❌)

**Adding `category`:**

```yaml
---
id: test-agent
name: TestAgent
description: "Test agent"
category: core           # ❌ BREAKS
mode: primary
temperature: 0.2
---
```

**Adding `type`:**

```yaml
---
id: test-agent
name: TestAgent
description: "Test agent"
type: subagent          # ❌ BREAKS
mode: primary
---
```

**Adding `version`:**

```yaml
---
id: test-agent
name: TestAgent
description: "Test agent"
version: 1.0.0          # ❌ BREAKS
mode: primary
---
```

**Adding `author`:**

```yaml
---
id: test-agent
name: TestAgent
description: "Test agent"
author: opencode        # ❌ BREAKS
mode: primary
---
```

**Adding `dependencies`:**

```yaml
---
id: test-agent
name: TestAgent
description: "Test agent"
mode: primary
dependencies:           # ❌ BREAKS
  - subagent:foo
  - subagent:bar
---
```

**Using `permissions` (plural):**

```yaml
---
id: test-agent
name: TestAgent
description: "Test agent"
mode: primary
permissions:            # ❌ BREAKS (should be "permission" singular)
  bash:
    "*": "deny"
---
```

## Test Results

| Field | Safe? | Notes |
|-------|-------|-------|
| `id` | ✅ | Works fine |
| `name` | ✅ | Works fine |
| `description` | ✅ | Documented field |
| `mode` | ✅ | Documented field |
| `temperature` | ✅ | Documented field |
| `tags` | ✅ | Array works fine |
| `tools` | ✅ | Documented field |
| `permission` | ✅ | Documented field (singular) |
| `category` | ❌ | Breaks Bedrock |
| `type` | ❌ | Breaks Bedrock |
| `version` | ❌ | Breaks Bedrock |
| `author` | ❌ | Breaks Bedrock |
| `dependencies` | ❌ | Breaks Bedrock |
| `permissions` | ❌ | Breaks (should be `permission`) |

## Expected Behavior

One of the following:

1. **Best**: OpenCode should filter out non-standard fields before passing to the provider
2. **Good**: Document which fields are safe to use in agent frontmatter
3. **Acceptable**: Warn users when agent files contain fields that will be passed through to providers

## Actual Behavior

All frontmatter fields are passed through to the provider, causing runtime failures with certain provider/backend combinations (specifically OpenAI-compatible → LiteLLM → Bedrock).

## Impact

- Users cannot use community-created agents (like OpenAgents) with Bedrock-backed providers without manually editing all agent files
- The error message is cryptic and doesn't point to the agent configuration as the source
- No validation at agent load time - only fails at runtime

## Suggested Fix

Add a whitelist of fields that should be passed through to providers:

```typescript
const PROVIDER_PASSTHROUGH_FIELDS = [
  'temperature',
  'maxSteps',
  'model',
  'reasoningEffort',  // OpenAI reasoning models
  'textVerbosity',    // OpenAI reasoning models
  // ... other provider-specific params
];

// Filter agent config before sending to provider
const providerConfig = Object.keys(agentConfig)
  .filter(key => PROVIDER_PASSTHROUGH_FIELDS.includes(key))
  .reduce((obj, key) => ({ ...obj, [key]: agentConfig[key] }), {});
```

## Workaround

Manually remove these fields from agent YAML frontmatter:

- Remove: `category`, `type`, `version`, `author`, `dependencies`
- Change: `permissions` → `permission` (singular)
- Keep: `id`, `name`, `description`, `mode`, `temperature`, `tags`, `tools`, `permission`

## Additional Context

- This affects any OpenAI-compatible provider that uses LiteLLM to proxy to Bedrock
- Direct Anthropic API requests work fine (they likely ignore unknown fields)
- The issue is specific to how LiteLLM constructs the `additionalModelRequestFields` parameter for Bedrock's Converse API

## Related

- [OpenAgents Repository](https://github.com/darrenhinde/OpenAgents)
- [OpenCode Agent Documentation](https://opencode.ai/docs/agents/)
