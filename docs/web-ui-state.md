# ChatGPT Web UI state machine

The browser adapter centralizes visible ChatGPT state into a small explicit
state machine.

## States

| State | Meaning | Automatic action |
| --- | --- | --- |
| `ready` | Composer/normal page is available | none |
| `generating` | Stop-generation control is visible | poll only |
| `paused` | Continue-generating control is visible | none |
| `auth_required` | Login/signup wall detected | stop and require user login |
| `challenge_required` | Browser verification/challenge detected | stop and require user action |
| `rate_limited` | Visible usage/rate-limit error | stop; do not bypass |
| `remote_error` | Visible retry/network/server error | stop; do not auto-retry |
| `unknown` | Required state cannot be identified confidently | fail closed where the action requires certainty |

The status result also reports whether these controls are visible:

- Stop
- Continue
- Retry
- Regenerate

The proxy **observes** Retry/Regenerate but never clicks them automatically.

## Why no automatic recovery clicks?

Automatic Continue/Retry/Regenerate can:

- create duplicate generations
- create response branches
- change the semantic meaning of a persisted `turn_id`
- consume additional quota
- hide a real service-side failure

Therefore these states are surfaced to Codex/user instead of being silently
mutated.

## Navigation rules

Production navigation is restricted to:

- `https://chatgpt.com/`
- validated `https://chatgpt.com/c/<conversation_id>`

There is no MCP tool that accepts an arbitrary URL.

Conversation mismatches fail closed with `SESSION_LOST` or
`CONVERSATION_NOT_FOUND`.

## Response completion

A turn is complete only when:

1. a newer assistant message exists;
2. the UI is not `generating`;
3. the UI is not `paused`; and
4. either an assistant Copy action is visible or response text has remained
   stable for `CGW_STABLE_MS`.

This heuristic is intentionally conservative and is independent of response
content type (plain text, code block, writing block, table, file, image, etc.).
