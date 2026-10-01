This patch makes observer Settings easier to configure and verifies that saved connection choices stay separate. It also fixes OpenCode 2 model selection during cold startup.

## Highlights

- **Clear connection choices:** Choose an OpenCode account, an API key, a local Claude session, or a local Codex session. API-key mode does not use cached subscription sign-ins, and OpenCode-account mode does not silently fall back to a direct API key. Missing credentials or an unavailable service produce a visible error.
- **Model settings:** Settings shows the actual defaults and puts Simple and Rich tier models together. OpenAI/Codex uses `gpt-6-luna` for Simple and untiered defaults, and `gpt-5.6-terra` for Rich. Saved model choices and hidden values remain intact. The misleading model check was removed; a suggested model does not guarantee account access.
- **Save and apply feedback:** Settings distinguishes saved changes from changes active in the running observer and shows restart guidance only when needed. Automatic connection choices remain automatic when saved. Reverting a connection draft restores active tier routing without overwriting explicit routing choices or other drafts.
- **Custom providers:** Auto provider inference accepts mixed-case provider prefixes while retaining the configured provider ID. OpenCode and direct custom-provider requests strip matching prefixes without changing model-ID case; direct requests still apply configured model-ID mappings.
- **OpenCode 2 startup:** codemem retries the exact pre-generation model-selection rejection that can occur before the service's model catalog is ready. Retries keep the selected provider and model, stop after six requests, and wait at most 7.75 seconds in total. Other errors and uncertain generation outcomes are not retried by this compatibility path.

## Compatibility and upgrade

Legacy `api_http` and omitted runtime settings keep their previous routing until you explicitly change the connection. Unrelated Settings edits do not migrate your credentials or account choice.

Install the matching 0.46.2 packages, then restart the viewer and agent host when safe. An already-running viewer does not switch builds automatically. This release does not claim to fix every queued-event failure; inspect observer status if a backlog remains.
