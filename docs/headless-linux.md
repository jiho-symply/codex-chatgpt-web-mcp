# Headless Linux

## Runtime model

Normal MCP operation is headless.

The only step that normally requires a visible browser is the initial ChatGPT
login. Authentication is then kept in the persistent browser profile.

## Browser requirement

CGW uses an installed system Chrome/Chromium browser by default. No repository
clone/build is required for normal use.

If the host has no supported browser, install Chrome/Chromium using the normal
OS/package-manager method. Playwright Chromium remains an optional fallback:

```bash
npx playwright install --with-deps chromium
```

## Initial login options

### Option A: SSH X11 forwarding

When X11 forwarding is available:

```bash
ssh -X user@server
npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/refs/heads/main.tar.gz login
```

Complete login in the opened browser.

### Option B: temporary VNC/noVNC desktop

Create a temporary graphical session on the server, run:

```bash
npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/refs/heads/main.tar.gz login
```

Complete authentication, then shut down the temporary desktop service.

The proxy itself does not bundle or expose a VNC server because that would add
another network attack surface.

### Option C: existing graphical session on the same trusted host

Run `npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/refs/heads/main.tar.gz login` once in that session, then use the same OS account/state
directory for headless MCP operation.

## Xvfb note

Xvfb by itself creates a display but does not let a remote human see it.
Therefore:

```bash
xvfb-run -a npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/refs/heads/main.tar.gz login
```

is only useful if you also have a secure way to view/interact with that display.
Do not expose an unauthenticated VNC/noVNC endpoint.

## After login

Verify headless access:

```bash
npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/refs/heads/main.tar.gz doctor
npx -y https://github.com/jiho-symply/codex-chatgpt-web-mcp/archive/refs/heads/main.tar.gz models
```

Then register Codex as described in [installation.md](installation.md).

## State directory

By default the state/profile directory follows the host OS convention. For a
dedicated server account, you may set:

```bash
export CGW_STATE_DIR="$HOME/.local/state/codex-chatgpt-web-mcp"
```

Keep this directory private. It contains the authenticated browser profile.

## Docker

The included Dockerfile is suitable for headless operation after an
authenticated profile is available in the mounted `/data` state directory.

The container does not solve the interactive login problem by design.
