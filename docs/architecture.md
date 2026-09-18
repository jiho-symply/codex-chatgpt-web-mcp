# Architecture

## Data flow

```text
                    local trust boundary
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ┌────────────┐       MCP stdio      ┌───────────────┐  │
│  │   Codex    │─────────────────────▶│ Web Proxy MCP │  │
│  │            │◀─────────────────────│               │  │
│  │ repo/shell │    response text     │ browser only  │  │
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
- fixed-origin navigation
- conversation reuse
- live model/effort picker discovery
- idempotent prompt dispatch
- persistent local turn metadata
- bounded generation polling and timeout recovery
- stronger generation completion detection
- response extraction

### ChatGPT Web

ChatGPT receives an ordinary chat message. It does not receive a repository
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

## No workspace bridge

This repository deliberately does not implement read_file, git_diff,
search_workspace, or similar tools.

Codex already has local workspace access. Duplicating that capability inside
the ChatGPT browser proxy would unnecessarily enlarge the trust boundary.
