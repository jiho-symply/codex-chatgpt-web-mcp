# Turn reliability

Version 0.2 separates **sending a prompt** from **waiting for a response**.

This prevents a long ChatGPT reasoning turn from being coupled to one long MCP
request.

## Recommended flow

```text
chatgpt_send(request_id, prompt)
        │
        └── turn_id
              │
              ├── chatgpt_wait(turn_id, 30000)
              │       ├── generating → wait again later
              │       ├── completed  → response is available
              │       └── paused     → user/model action is required
              │
              ├── chatgpt_get_reply(turn_id)
              │       └── inspect immediately without sending anything
              │
              └── chatgpt_stop(turn_id)
```

`chatgpt_chat` remains as a compatibility wrapper, but long or high-reasoning
work should use the asynchronous tools.

## Idempotency

`chatgpt_send` requires a caller-provided `request_id`.

The proxy persists only:

- request id
- SHA-256 hash of the request payload
- local turn id
- ChatGPT conversation id
- assistant-message baseline count
- turn status
- requested model/effort labels
- timestamps / error code

The prompt body is **not** persisted by the turn store.

Reusing the same `request_id` with the same inputs returns the existing turn
and never sends the prompt twice.

Reusing the same `request_id` with different inputs fails with
`REQUEST_ID_CONFLICT`.

### Crash window

The request id is reserved on disk **before** the browser send.

If the process dies in the narrow interval between reservation and confirmed
browser dispatch, the turn remains `reserved`. On restart it is not
automatically re-sent, because doing so could duplicate a prompt that actually
reached ChatGPT.

This is an intentional at-most-once safety trade-off.

## Completion detection

A reply is considered complete only after:

1. an assistant message newer than the pre-send baseline exists;
2. the Stop button is gone;
3. no Continue-generating control is visible; and
4. either a Copy control is visible on the assistant message or the text has
   remained unchanged for a stability interval.

The proxy never auto-clicks Continue generating or Regenerate.

## Timeout recovery

`chatgpt_wait` uses bounded wait slices (default 30 seconds). A wait slice
expiring does not lose the turn and does not resend the prompt.

The compatibility `chatgpt_chat` wrapper returns `RESPONSE_TIMEOUT` after its
overall timeout and includes the `turnId`. Recover with:

```text
chatgpt_wait(turn_id)
chatgpt_get_reply(turn_id)
```

## Persistent turn state

Turn metadata lives under the private application state directory, outside the
workspace. Terminal records are pruned when the bounded store fills; active
turns are not silently evicted.

## Error taxonomy

| Code | Meaning |
| --- | --- |
| `AUTH_REQUIRED` | ChatGPT login is required |
| `CHALLENGE_REQUIRED` | Manual browser verification is required |
| `CONVERSATION_NOT_FOUND` | Requested conversation no longer exists |
| `SESSION_LOST` | Browser navigation did not remain on the requested conversation |
| `RATE_LIMITED` | Visible ChatGPT rate/usage limit |
| `REMOTE_ERROR` | Visible ChatGPT-side error |
| `MODEL_UNAVAILABLE` | Exact requested model is not selectable |
| `EFFORT_UNAVAILABLE` | Exact requested effort is not selectable |
| `UI_CHANGED` | Required ChatGPT UI control cannot be identified safely |
| `COMPOSER_NOT_CLEAN` | Existing draft/attachment state could not be cleared safely before send |
| `PROFILE_BUSY` | Another process owns the persistent browser profile |
| `BROWSER_NOT_INSTALLED` | Playwright Chromium is unavailable |
| `REQUEST_ID_CONFLICT` | Idempotency key was reused with different inputs |
| `REQUEST_STATE_UNKNOWN` | Crash-safe reservation exists but dispatch cannot be proven |
| `TURN_NOT_FOUND` | Unknown local turn id |
| `RESPONSE_TIMEOUT` | Wrapper timed out; turn can still be recovered |
| `GENERATION_PAUSED` | ChatGPT is waiting for Continue generating |
| `GENERATION_STOPPED` | Turn was explicitly stopped |

Website errors are detected conservatively. The proxy does not solve challenges,
auto-regenerate, or bypass rate limits.
