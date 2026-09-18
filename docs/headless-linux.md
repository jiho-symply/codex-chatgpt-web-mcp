# Headless Linux

## Runtime model

Normal MCP operation is headless.

The only step that normally requires a visible browser is the initial ChatGPT
login. Authentication is then kept in the persistent browser profile.

## Install Chromium dependencies

On Debian/Ubuntu-like hosts:

```bash
npm install
npx playwright install --with-deps chromium
npm run build
```

## Initial login options

### Option A: SSH X11 forwarding

When X11 forwarding is available:

```bash
ssh -X user@server
cd codex-chatgpt-web-mcp
node dist/cli.js login
```

Complete login in the opened browser.

### Option B: temporary VNC/noVNC desktop

Create a temporary graphical session on the server, run:

```bash
node dist/cli.js login
```

Complete authentication, then shut down the temporary desktop service.

The proxy itself does not bundle or expose a VNC server because that would add
another network attack surface.

### Option C: existing graphical session on the same trusted host

Run `cgw login` once in that session, then use the same OS account/state
directory for headless MCP operation.

## Xvfb note

Xvfb by itself creates a display but does not let a remote human see it.
Therefore:

```bash
xvfb-run -a node dist/cli.js login
```

is only useful if you also have a secure way to view/interact with that display.
Do not expose an unauthenticated VNC/noVNC endpoint.

## After login

Verify headless access:

```bash
node dist/cli.js doctor
node dist/cli.js models
```

Then configure Codex.

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
