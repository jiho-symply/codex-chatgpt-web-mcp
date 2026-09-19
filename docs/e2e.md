# Autonomous E2E testing

CGW exposes a persistent E2E runner through MCP so the calling agent does not
need to remember or manually orchestrate every test step.

## Why this exists

A long E2E sequence is a poor fit for an agent-only checklist: the agent can
lose context, stop after one failure, or resend prompts. The E2E runner keeps
the test plan inside CGW itself.

A run:

- executes in the background after one `chatgpt_e2e_start` call;
- checkpoints JSON and Markdown after every test under CGW private state;
- continues even if the Codex model stops reasoning;
- uses deterministic request IDs so duplicate sends are rejected/deduplicated;
- reports PASS / FAIL / BLOCKED / NOT_RUN per test;
- can be recovered later with `chatgpt_e2e_latest` even if the agent forgot the run ID;
- does not patch the repository;
- stops early on authentication/challenge/rate-limit blockers instead of bypassing them.

The suite sends a small number of real deterministic prompts to the user's
ChatGPT account. It reuses the supplied workspace binding and does not delete
non-test Projects.

## Covered checks

The current suite covers:

- authenticated/ready browser state;
- workspace → exact Project binding;
- verified Project-only memory;
- repeated binding idempotency;
- live model/effort capability discovery;
- request-ID deduplication;
- request-ID conflict rejection before dispatch;
- send → wait → response extraction;
- completed-turn recovery;
- structured text/code/table manifest extraction;
- staged text attachment upload and readback;
- missing-workspace rejection;
- unknown-turn rejection;
- Project isolation across real sends;
- optional explicit-current-model/effort smoke test when the current selection
  maps exactly to a visible option.

MCP launcher cold-start is tested separately in CI with
`scripts/mcp-startup-smoke.mjs`, because an already-running MCP server cannot
meaningfully test its own process startup.

## Recommended Codex prompt

After installing the build and restarting Codex:

```text
Use only the MCP server "chatgpt-web-test".

Start chatgpt_e2e_start with:
workspace_id = "ws_0123456789abcdef01234567"
workspace_name = "CGW-E2E-Test"
include_selection = true

Do not manually reproduce individual tests.
The E2E run is autonomous.

Then periodically call chatgpt_e2e_latest until the latest run is no longer
"running". Once terminal, call chatgpt_e2e_report for that run_id and summarize
the failures and recommendations.

If the run is BLOCKED by authentication/challenge/rate limit, report only that
human/account action is required. Do not bypass it.
```

If the agent forgets the run ID, `chatgpt_e2e_latest` recovers it from
persistent CGW state.

## Report files

Each run writes:

```text
<CGW_STATE_DIR>/e2e/e2e_<id>.json
<CGW_STATE_DIR>/e2e/e2e_<id>.md
```

On Windows with the default state directory these live under
`%LOCALAPPDATA%\codex-chatgpt-web-mcp\e2e`.

These are local test artifacts. They are not uploaded to ChatGPT.
