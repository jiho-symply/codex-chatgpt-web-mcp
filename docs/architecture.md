# Architecture

## Data flow

```text
                    local trust boundary
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ┌────────────┐       MCP stdio      ┌───────────────┐  │
│  │   Codex    │─────────────────────▶│ Web Proxy MCP │  │
│  │            │◀─────────────────────│               │  │
│  │ repo/shell │ response manifest    │ browser only  │  │
│  └────────────┘                      └───────┬───────┘  │
│                                             │           │
└─────────────────────────────────────────────┼───────────┘
                                              │ Playwright
                                              ▼
                                      ┌───────────────┐
                                      │ ChatGPT Web   │
                                      │ normal chat   │
                                      └───────────────┘
```

## Component responsibilities

### Codex

Codex remains responsible for:

- repository search/read/write
- selecting prompt context
- shell execution
- patch validation and application
- tests/builds
- Git operations
- deciding whether model output is safe/useful

### MCP server

The server is responsible only for:

- persistent browser lifecycle
- ChatGPT authentication-state detection
- workspace→Project binding with Project-only-memory verification
- project-aware fixed-origin navigation
- conversation reuse
- live model/effort picker discovery
- explicit caller-provided input staging
- validated ChatGPT attachment upload
- idempotent prompt dispatch
- persistent local turn metadata
- bounded generation polling and timeout recovery
- stronger generation completion detection
- structured response extraction (text/code/writing/table/citation/file/image/preview)
- private staged asset retrieval

### ChatGPT Web

ChatGPT receives an ordinary chat message plus only the attachments explicitly staged and referenced by Codex. It does not receive a repository
connector from this project and does not know the caller's local orchestration
state unless Codex explicitly puts that information into the prompt.

## Why stdio

The default transport is MCP stdio because it:

- does not create a network listener
- inherits the local Codex process trust boundary
- avoids OAuth/token management for the local MCP hop
- is simpler to audit

## Browser profile

One persistent Chromium profile stores the website session. The MCP process
takes an atomic profile lock so two servers cannot manipulate the same profile
at once.

The profile is stored in the OS state directory, never under the user's project.

## Request serialization

ChatGPT Web is stateful. Even if the MCP client submits parallel calls, browser
operations run through a single serial queue.

This prevents:

- model selection from one request affecting another
- prompts landing in the wrong conversation
- response extraction races

## Input boundary

```text
Codex workspace access
      │
      │ explicit text/base64 only
      ▼
private CGW input staging
      │
      │ opaque input_asset_id
      ▼
ChatGPT attachment UI
```

The MCP has no arbitrary filesystem-read or directory-upload capability.
Staged input is integrity-checked again before each upload.

See [input-attachments.md](input-attachments.md).

## Workspace Project boundary

```text
local workspace identity
      │ hash locally
      ▼
opaque ws_<hex>
      │
      ▼
private CGW mapping
      │
      └── exact g-p-<id>
             │
             ▼
      ChatGPT Project
      (Project-only memory)
             │
             ├─ fresh chat
             └─ continued chat
```

The raw workspace path/remote never has to cross MCP. CGW does not search
existing Projects by name. A missing binding creates a new Project only if
Project-only memory can be selected and verified.

Fresh sends navigate to Project home; continuations use the exact Project-aware
thread URL. Project identity is carried in turn/output-asset state.

See [workspace-project-isolation.md](workspace-project-isolation.md).

## Turn lifecycle

A prompt is not tied to one long MCP call.

```text
request_id
   │ reserve locally (prompt body is not persisted)
   ▼
chatgpt_send ──▶ turn_id / generating
                    │
             ┌──────┴────────┐
             ▼               ▼
       chatgpt_wait     chatgpt_get_reply
             │               │
             └──────┬────────┘
                    ▼
          completed / stopped / error
```

The request id is persisted before browser dispatch. This intentionally favors
at-most-once delivery: after an ambiguous crash window the proxy will not
silently send the same prompt again.

See [reliability.md](reliability.md).

## Model selection

The proxy does not maintain a canonical list of ChatGPT models.

It reads the live web UI and uses:

1. stable test-id selectors when available
2. semantic ARIA labels as fallback
3. exact visible option text for requested choices

If the requested model/effort cannot be identified exactly, the request fails
rather than silently choosing another option.

## Response extraction

The adapter does not treat an assistant message as one opaque string. The DOM
extractor emits a response manifest while retaining plain text compatibility.

```text
assistant message DOM
      │
      ├─ text
      ├─ code(language, exact text)
      ├─ writing block
      ├─ table
      ├─ citation
      ├─ file ──────▶ opaque asset_id
      ├─ image ─────▶ opaque asset_id
      └─ preview
```

Asset URLs remain inside the browser adapter. An explicit retrieval request
stages bytes under the private application state directory and returns only the
local staging path plus integrity metadata.

The browser UI itself is normalized into an explicit state machine; see
[web-ui-state.md](web-ui-state.md).

## No workspace bridge

This repository deliberately does not implement read_file, git_diff,
search_workspace, or similar tools.

Codex already has local workspace access. Duplicating that capability inside
the ChatGPT browser proxy would unnecessarily enlarge the trust boundary.
