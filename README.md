# codex-chatgpt-web-mcp

[한국어](README.ko-KR.md) | **English**

> **Codex owns the workspace. The proxy owns the browser. ChatGPT only sees the conversation.**

A local, browser-backed MCP server that lets Codex use your authenticated
ChatGPT Web session as a reasoning, coding, and review backend.

Unlike workspace-bridge designs, this project does **not** connect ChatGPT to
your repository. Codex is the MCP client. The MCP server controls an isolated
ChatGPT browser session and returns normal assistant responses to Codex.

## Architecture

```text
┌──────────────────────────────┐
│            Codex             │
│                              │
│ workspace / shell / git      │
│ context selection / patches  │
│ tests / execution            │
└──────────────┬───────────────┘
               │ MCP over stdio
               ▼
┌──────────────────────────────┐
│    codex-chatgpt-web-mcp     │
│                              │
│ fixed ChatGPT navigation     │
│ persistent browser profile   │
│ model / effort selection     │
│ conversation management      │
│ response extraction          │
└──────────────┬───────────────┘
               │ Playwright
               ▼
┌──────────────────────────────┐
│       ChatGPT Web            │
│                              │
│ sees prompt text only        │
│ no repo / shell / MCP access │
└──────────────────────────────┘
```

The proxy has no workspace mount, no Git operations, no shell tool, and no
generic browser-navigation MCP tool. It only navigates the fixed ChatGPT Web
origin.

## Security properties

- **Workspace isolation by architecture** — ChatGPT never receives repository
  access through this MCP server. Codex chooses exactly what text to send.
- **No execution capability** — ChatGPT responses are untrusted text. The proxy
  cannot apply patches, run commands, install packages, or modify Git state.
- **Local stdio transport** — the MCP server opens no TCP listener.
- **Persistent browser profile is private state** — stored outside projects
  with owner-only permissions where the OS supports them.
- **No credential API** — there is no MCP tool to read cookies, tokens,
  passwords, local storage, or the browser profile.
- **No stealth/evasion code** — the implementation uses standard Playwright.
  It does not attempt to bypass anti-bot, CAPTCHA, login, or service controls.
- **Fixed origin** — browser automation is restricted to `https://chatgpt.com`.
- **Serialized requests** — one browser profile is used by one request at a
  time to prevent cross-conversation races.
- **Bounded I/O** — prompt and response sizes are capped locally.

See [SECURITY.md](SECURITY.md) for the threat model.

## MCP tools

### `chatgpt_status`

Checks whether the persistent browser session is authenticated and whether the
ChatGPT composer is usable.

### `chatgpt_capabilities`

Reads the live model/effort picker choices visible to the signed-in account.
The web UI is the source of truth; model names are not hard-coded.

### `chatgpt_chat`

Sends a prompt to a new or existing ChatGPT conversation.

Inputs include:

- `prompt`
- optional `conversation_id`
- optional exact `model` label
- optional exact `effort` label
- optional timeout

The returned `conversation_id` can be reused on the next call.

## Quick start

Requirements:

- Node.js 20+
- a ChatGPT account you are authorized to use
- a graphical session for the **initial manual login**
- headless Chromium is sufficient after the browser profile is authenticated

```bash
git clone https://github.com/jiho-symply/codex-chatgpt-web-mcp.git
cd codex-chatgpt-web-mcp

npm install
npx playwright install chromium
npm run build

# Initial login: this intentionally opens a real browser.
node dist/cli.js login

# Verify the persisted session works headlessly.
node dist/cli.js doctor
```

On Linux servers you may need:

```bash
npx playwright install --with-deps chromium
```

See [docs/headless-linux.md](docs/headless-linux.md) for initial-login options
such as SSH X11 forwarding or a temporary VNC/noVNC desktop.

## Connect to Codex

Run:

```bash
node dist/cli.js codex-config
```

It prints a TOML block using the current absolute executable path. Add the
result to `~/.codex/config.toml`.

Equivalent shape:

```toml
[mcp_servers.chatgpt_web]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/codex-chatgpt-web-mcp/dist/cli.js", "mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

Then Codex can call `chatgpt_chat` as a subagent without giving ChatGPT direct
workspace access.

See [docs/codex.md](docs/codex.md).

## Typical coding workflow

Codex remains the orchestrator:

```text
1. Codex searches/reads the repository.
2. Codex selects only the relevant context.
3. Codex calls chatgpt_chat with the task + selected context.
4. ChatGPT returns analysis, code, or a unified diff as ordinary text.
5. Codex treats the response as untrusted.
6. Codex validates any patch locally, runs tests, and decides what to apply.
7. Codex may send the resulting diff/test summary back for review.
```

ChatGPT does not need to know that Codex is the caller.

## Model and effort selection

Use the live account-specific picker:

```bash
node dist/cli.js models
```

Or let Codex call `chatgpt_capabilities`.

The proxy attempts semantic/test-id based discovery first and fails closed when
it cannot identify a requested option. It does not silently substitute another
model or effort level.

Because ChatGPT Web changes over time, UI selectors can break. A selector
failure returns `UI_CHANGED` instead of guessing.

## Headless operation

The MCP command is headless by default.

The initial login is deliberately manual: this project does not accept account
passwords or automate CAPTCHA/2FA. Once authenticated, the persistent profile
can be reused by headless Chromium on the same trusted machine.

For servers without a desktop, use one of the documented temporary display
methods for the first login, then remove the display service.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `CGW_STATE_DIR` | OS state directory | Browser profile + local state root |
| `CGW_HEADLESS` | `true` for MCP/doctor | Run browser without a visible window |
| `CGW_BROWSER_CHANNEL` | bundled Chromium | Optional Playwright browser channel such as `chrome` |
| `CGW_TIMEOUT_MS` | `180000` | Default ChatGPT generation timeout |

There is intentionally no configurable remote origin.

## Docker

A Dockerfile is included for **headless operation after a profile has been
authenticated**. Persist `/data` as a private volume.

The preferred deployment is still a local MCP process launched directly by
Codex because stdio keeps the trust boundary simple.

## Limitations

- This is browser automation, not an official ChatGPT API.
- ChatGPT Web UI changes can break selectors.
- An initial interactive login is required.
- ChatGPT may reject or challenge automated browser sessions; this project does
  not bypass those controls.
- Codex is responsible for minimizing sensitive code sent in prompts.
- ChatGPT responses may contain unsafe or incorrect code and must be reviewed
  before execution.
- A website subscription, availability, and usage limits remain governed by
  the service itself.

## Disclaimer

Unofficial community project. Not affiliated with or endorsed by OpenAI.

Users are responsible for complying with applicable service terms and their
organization's policies.

## License

[MIT](LICENSE)
