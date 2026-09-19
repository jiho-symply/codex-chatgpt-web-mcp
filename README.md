# codex-chatgpt-web-mcp

[한국어](README.ko-KR.md) | **English**

Use your authenticated **ChatGPT Web** account as an external reasoning, coding,
and review backend for Codex.

Codex keeps ownership of the repository, shell, Git, tests, and patch
application. ChatGPT sees only the prompts and files Codex explicitly sends.

## Install with Codex

Copy this prompt into a **local Codex session**:

```text
Install codex-chatgpt-web-mcp on this machine.

Repository:
https://github.com/jiho-symply/codex-chatgpt-web-mcp

Use the normal-user install flow, not the development/source-build flow.
Do not modify files in my current project.

1. Check that Node.js >= 20 and a supported Edge/Chrome/Chromium browser are available.
2. Install CGW once, before Codex starts the MCP server:
   npm install -g codex-chatgpt-web-mcp@latest
3. Run:
   cgw login
   If ChatGPT login, CAPTCHA, or 2FA needs human interaction, stop and ask me to complete it in the opened browser.
4. Register the already-installed MCP launcher with:
   codex mcp add chatgpt-web -- cgw mcp
5. Verify registration with:
   codex mcp list
6. Do not put `npx ... mcp` in the saved MCP command: Codex's MCP startup timeout also covers npm/network cold-start work.
7. Do not clone/build the repository unless the documented package install actually fails.
8. If the current Codex session cannot see the newly added MCP server, tell me to restart Codex.

If anything fails, show me the exact failing command and error instead of guessing.
```

Codex can perform the installation itself if it has local shell permission.
You only need to handle interactive ChatGPT login/2FA/CAPTCHA, and possibly
restart Codex once after registration.

## Manual install

Requirements: **Node.js 20+** and a local browser.

- Windows: Microsoft Edge or Google Chrome
- Linux: Google Chrome or Chromium

```bash
# Install once outside the MCP startup path
npm install -g codex-chatgpt-web-mcp@latest

# One-time ChatGPT login
cgw login

# Register the already-installed launcher
codex mcp add chatgpt-web -- cgw mcp
```

Do not register `npx -y codex-chatgpt-web-mcp@latest mcp` as the persistent
MCP command. A cold npm/network resolution can consume Codex's MCP startup
budget before CGW receives the MCP initialize request.

Verify with:

```bash
codex mcp list
```

Codex CLI, the ChatGPT/Codex desktop app, and Codex IDE integrations on the same
host share the same MCP configuration. UI-only setup and platform details are
in [docs/installation.md](docs/installation.md).

## Use cases

- **Second-opinion coding/review** — send a diff, implementation, or test result
  to ChatGPT while Codex remains the orchestrator.
- **Long reasoning** — delegate a difficult analysis and recover the same turn
  without resending the prompt after timeouts.
- **File/document analysis** — explicitly attach source, logs, PDF, Office
  documents, CSV/JSON/YAML, screenshots, and images.
- **Structured outputs** — receive code blocks, tables, citations, generated
  files/images, and other response parts as a structured manifest.
- **Workspace-isolated context** — each local workspace can use its own
  `CGW-...` ChatGPT Project created with Project-only memory.

## How it works

```text
Codex ── MCP / stdio ──▶ CGW ── browser ──▶ ChatGPT Web
  │                                          │
  ├─ repo / shell / Git / tests              └─ explicit prompt/files only
  └─ validates and applies results
```

Key behavior:

- one persistent authenticated browser profile, stored outside repositories;
- Windows and Linux system-browser auto-detection;
- `CGW-` prefix for newly created workspace Projects;
- explicit input staging — no arbitrary workspace file reader;
- async `send → wait → get_reply` flow with idempotent request IDs;
- structured response extraction for text/code/files/images/tables/citations;
- generated assets are staged privately before Codex decides what to do with them;
- no shell, Git, patch-apply, arbitrary URL navigation, cookie export, CAPTCHA
  bypass, or stealth capability is exposed to ChatGPT.

## Documentation

Detailed documentation is kept out of this README:

- [Documentation index](docs/README.md)
- [Installation and platform details](docs/installation.md)
- [Codex integration](docs/codex.md)
- [Architecture](docs/architecture.md)
- [Workspace → Project isolation](docs/workspace-project-isolation.md)
- [Input attachments](docs/input-attachments.md)
- [Structured responses](docs/response-manifest.md)
- [Reliability / async turns](docs/reliability.md)
- [Autonomous E2E testing](docs/e2e.md)
- [Security model](SECURITY.md)

## Notes

- This is ChatGPT Web browser automation, not the official ChatGPT API.
- Initial ChatGPT login is intentionally interactive.
- ChatGPT Web UI changes can break selectors; ambiguous UI states fail closed.
- Content explicitly uploaded through CGW is sent to the user's ChatGPT account
  and is subject to ChatGPT retention/settings.
- ChatGPT output is untrusted; Codex should validate code and files before use.

## License

[MIT](LICENSE)
