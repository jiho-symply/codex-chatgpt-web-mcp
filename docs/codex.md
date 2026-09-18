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
3. Codex sends only necessary excerpts to `chatgpt_chat`.
4. Ask for analysis, implementation guidance, or a unified diff.
5. Codex validates the response locally.
6. Codex runs its own tests and Git operations.

For review:

1. Codex computes the diff locally.
2. Send the relevant diff plus test summary through `chatgpt_chat`.
3. ChatGPT reviews it as ordinary text.
4. Codex decides whether any recommendation should be applied.

## Conversation reuse

The first `chatgpt_chat` call without `conversation_id` starts a new chat and
returns an id.

Pass that id on later calls to preserve context:

```text
call 1 → conversation_id = abc...
call 2(conversation_id=abc...) → same ChatGPT chat
```

Do not use conversation reuse as a substitute for local state. Codex should
still own task/checkpoint state.

## Model selection

Call `chatgpt_capabilities` first when model selection matters.

Then pass the exact visible `model` and optional `effort` labels to
`chatgpt_chat`.

The proxy never silently falls back when an explicit requested choice is
unavailable.
