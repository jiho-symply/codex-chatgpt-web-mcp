# Codex integration

## Build first

```bash
npm install
npx playwright install chromium
npm run build
node dist/cli.js doctor
```

## Generate configuration

```bash
node dist/cli.js codex-config
```

Paste the output into:

`~/.codex/config.toml`

The generated block uses absolute paths, similar to:

```toml
[mcp_servers.chatgpt_web]
command = "/usr/bin/node"
args = ["/home/user/codex-chatgpt-web-mcp/dist/cli.js", "mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

## Suggested use

Use Codex as the orchestrator and ChatGPT as an untrusted external subagent.

For implementation work:

1. Codex identifies relevant files.
2. Codex reads those files locally.
3. Codex generates a stable request id and sends only necessary excerpts with
   `chatgpt_send`.
4. Save the returned `turn_id`; use `chatgpt_wait` in bounded slices.
5. Ask for analysis, implementation guidance, or a unified diff.
6. If an MCP/tool timeout occurs, recover the same turn with
   `chatgpt_get_reply` rather than sending again.
7. Codex validates the response locally.
8. Codex runs its own tests and Git operations.

For review:

1. Codex computes the diff locally.
2. Send the relevant diff plus test summary through `chatgpt_send`.
3. Wait/recover using the returned `turn_id`.
4. ChatGPT reviews it as ordinary text.
5. Codex decides whether any recommendation should be applied.

## Conversation reuse

The first `chatgpt_send` call without `conversation_id` starts a new chat.
The local turn later exposes the ChatGPT conversation id.

Pass that conversation id on later sends to preserve context:

```text
send 1 → turn_id = turn_... → conversation_id = abc...
send 2(conversation_id=abc...) → same ChatGPT chat
```

Do not use conversation reuse as a substitute for local state. Codex should
still own task/checkpoint state.

## Model selection

Call `chatgpt_capabilities` first when model selection matters.

Then pass the exact visible `model` and optional `effort` labels to
`chatgpt_chat`.

The proxy never silently falls back when an explicit requested choice is
unavailable.


## Timeout rule

Never retry a send merely because the MCP client timed out. Reuse the same
`request_id` or, preferably, continue from the known `turn_id`.

See [reliability.md](reliability.md).
