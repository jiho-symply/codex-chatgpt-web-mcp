# Installation

The normal install command is pinned to the immutable v0.8.1 commit `0790508bd9662c93ee917c419228d64b9192e749`. Do not replace it with `refs/heads/main.tar.gz`: `npx` keeps a separate execution cache and a floating URL can reuse stale package contents.

Normal users do not need to clone, build, or install a Playwright browser.

## Requirements

- Node.js 20+
- a ChatGPT account
- Codex CLI, Codex UI/Desktop, or a Codex IDE integration
- a supported browser:
  - Windows: Microsoft Edge or Google Chrome
  - Linux: Google Chrome or Chromium

CGW automatically finds a supported system browser. An already-installed
Playwright Chromium is used only as a fallback.

## Install with Codex

You can ask Codex to install CGW for you. Paste this into a local Codex session
that has permission to run shell commands:

```text
Install codex-chatgpt-web-mcp on this machine.

Repository:
https://github.com/jiho-symply/codex-chatgpt-web-mcp

Use the normal-user install flow, not the development/source-build flow.
Do not modify files in my current project.

1. Check that Node.js >= 20 and a supported Edge/Chrome/Chromium browser are available.
2. Run:
   npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/0790508bd9662c93ee917c419228d64b9192e749.tar.gz login
   If ChatGPT login, CAPTCHA, or 2FA needs human interaction, stop and ask me to complete it in the opened browser.
3. Register the MCP server with:
   codex mcp add chatgpt-web -- npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/0790508bd9662c93ee917c419228d64b9192e749.tar.gz mcp
4. Verify registration with:
   codex mcp list
5. Do not clone/build the repository unless the documented npx path actually fails.
6. If the current Codex session cannot see the newly added MCP server, tell me to restart Codex.

If anything fails, show me the exact failing command and error instead of guessing.
```

Codex can perform the installation and configuration steps. The two intentionally
human steps are:

- completing ChatGPT login/2FA/CAPTCHA when required;
- restarting the current Codex client if it does not hot-load a newly registered MCP server.

## Manual install

### 1. Sign in once

```bash
npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/0790508bd9662c93ee917c419228d64b9192e749.tar.gz login
```

### 2. Register with Codex

```bash
codex mcp add chatgpt-web -- npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/0790508bd9662c93ee917c419228d64b9192e749.tar.gz mcp
```

Verify:

```bash
codex mcp list
```

In the Codex terminal UI, `/mcp` also shows active MCP servers.

Codex CLI, the ChatGPT/Codex desktop app, and Codex IDE extensions share the
same Codex MCP configuration on the same host.

Official documentation:
https://developers.openai.com/docs/extend/mcp

## Codex UI / Desktop / IDE

The recommended path is still to run the same `codex mcp add ...` command once
and restart the UI client.

For UI-only configuration:

1. Open Settings → MCP Servers.
2. Add a local STDIO server named `chatgpt-web`.
3. Command: `npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/0790508bd9662c93ee917c419228d64b9192e749.tar.gz mcp`.
4. On Windows, use `npx.cmd` if the UI cannot resolve `npx`.
5. Save and restart the client.

## Windows

CGW first checks Windows' default HTTPS browser. If the default is Google Chrome
or Microsoft Edge, CGW uses that browser first. If the default browser is not a
supported Chromium browser or cannot be detected, CGW falls back to installed
Chrome/Edge.

CGW uses its own persistent automation profile, so this chooses the browser
application (Chrome vs Edge), not your normal browser profile. No WSL is required.

## Linux

CGW searches for Google Chrome/Chromium first. Normal MCP operation is headless,
but the initial ChatGPT login needs a visible browser once.

For a server without a desktop, see [headless-linux.md](headless-linux.md).

## Optional: WSL2

WSL is not required or part of the primary installation path.

If you deliberately run the Codex agent inside WSL2, treat WSL as a separate
Linux environment and install/register CGW there. Native Windows Codex and WSL
Codex use separate Codex homes by default.

Official WSL guidance:
https://developers.openai.com/docs/windows/wsl

## Browser override

Normally no configuration is needed.

Optional overrides:

```text
CGW_BROWSER_CHANNEL=chrome
CGW_BROWSER_EXECUTABLE=/absolute/path/to/browser
```

If no system browser is available, Playwright Chromium is an optional fallback:

```bash
npx playwright install chromium
```

## Diagnostics

Check the saved ChatGPT session:

```bash
npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/0790508bd9662c93ee917c419228d64b9192e749.tar.gz doctor
```

Inspect model/effort choices:

```bash
npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/0790508bd9662c93ee917c419228d64b9192e749.tar.gz models
```

Remove from Codex:

```bash
codex mcp remove chatgpt-web
```

## Development install

Only contributors need a source checkout:

```bash
git clone https://github.com/jiho-symply/codex-chatgpt-web-mcp.git
cd codex-chatgpt-web-mcp
npm install
npm run typecheck
npm test
npm run build
```

## npx cache note

If you previously ran the old floating `main.tar.gz` command, that old package may still exist in the separate npx execution cache. The pinned command above does not need that cache to be cleared because it uses a different immutable URL.

To remove old npx entries manually on Windows PowerShell:

```powershell
$npmCache = npm config get cache
Remove-Item -LiteralPath (Join-Path $npmCache "_npx") -Recurse -Force -ErrorAction SilentlyContinue
```

On newer npm versions, `npm cache npx ls` / `npm cache npx rm` may also be available.
