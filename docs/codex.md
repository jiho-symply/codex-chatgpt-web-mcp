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

1. Codex derives a stable opaque `workspace_id = ws_<hex>` locally. Never send
   the raw workspace path or Git remote.
2. Call `chatgpt_bind_workspace` once for that id. Repeated calls reopen the
   same exact Project; they do not reconfigure Project memory settings.
3. Codex identifies relevant files.
4. Codex reads those files locally.
5. Codex generates a stable request id and sends only necessary excerpts with
   `chatgpt_send`, including the same `workspace_id`.
6. Save the returned `turn_id`; use `chatgpt_wait` in bounded slices.
7. Ask for analysis, implementation guidance, or a unified diff.
8. If an MCP/tool timeout occurs, recover the same turn with
   `chatgpt_get_reply` rather than sending again.
9. Codex validates the response locally.
10. Codex runs its own tests and Git operations.

For review:

1. Codex computes the diff locally.
2. Send the relevant diff plus test summary through `chatgpt_send`.
3. Wait/recover using the returned `turn_id`.
4. ChatGPT reviews it as ordinary text.
5. Codex decides whether any recommendation should be applied.

## Workspace Project binding

Project isolation is required by default.

A suggested local fingerprint strategy is to normalize workspace identity
information locally, hash it locally with SHA-256, and pass only a prefix such
as `ws_<24 hex>`. The path/remote used to derive the digest stays local to
Codex.

Use `naming_mode=anonymous` when even the workspace display name should not be
visible in ChatGPT.

CGW does not add Project instructions.

See [workspace-project-isolation.md](workspace-project-isolation.md).

## Conversation reuse

The first `chatgpt_send` call without `conversation_id` but with a bound
`workspace_id` starts a new chat inside that workspace's Project.
The local turn later exposes the ChatGPT conversation id.

Pass that conversation id on later sends to preserve context:

```text
send 1(workspace_id=ws_...) → Project home → conversation_id = abc...
send 2(workspace_id=ws_..., conversation_id=abc...) → same Project thread
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


## Structured response handling

When a turn result contains `manifest`, prefer its structured parts over
re-parsing the flattened `response` string.

Recommended coding behavior:

1. use `code` parts directly for code/diff content;
2. treat `writing_block` as document text, not executable code;
3. convert/use `table` from its structured rows/Markdown representation;
4. treat citations as metadata only;
5. retrieve a `file` or `image` only when it is needed, using its
   `assetId`;
6. read the returned private staging path locally and independently validate
   bytes before copying anything into a workspace.

Never assume a generated `.patch` or code file is safe merely because ChatGPT
created it.


## Input attachments

For small relevant excerpts, inline text in the prompt is usually simplest.

For larger source files, logs, structured data, documents, or screenshots:

1. Codex reads/selects the material using its own workspace capabilities.
2. Use `chatgpt_stage_text` for UTF-8/code/log/data text. Use
   `chatgpt_stage_blob` only for small binary inputs (up to 1 MiB), and use a
   blob slot for larger supported document/image files.
3. Keep the returned `input_asset_id`.
4. Pass only the intended ids in `input_asset_ids` on `chatgpt_send`.
5. After upload, remember that local CGW TTL/discard controls only local staging,
   not copies already uploaded to ChatGPT.

Do not attempt to give CGW a workspace path. The absence of a path-based upload
API is an intentional security boundary.

See [input-attachments.md](input-attachments.md).
