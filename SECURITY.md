# Security Policy

## Security goals

This project is intentionally narrower than a general browser-control server.

The security boundary is:

- **Codex owns local code and execution.**
- **The MCP proxy owns only an authenticated ChatGPT browser profile.**
- **ChatGPT receives only prompt text and returns only response text.**

The MCP server has no repository root input and exposes no filesystem, shell,
Git, package-manager, patch-apply, or generic navigation tool.

## Trust boundaries

### ChatGPT response

Treat every ChatGPT response as untrusted input.

A response may contain incorrect code, destructive shell commands, prompt
injection, or a malicious-looking patch. Codex must independently review and
validate it before use.

### Prompt content

Prompt text is sent to ChatGPT Web. Codex should include only the minimum
workspace context required for the task.

This proxy cannot determine whether source code is confidential. The caller is
responsible for data-minimization and policy compliance.

### Browser profile

The persistent browser profile contains authentication state and is sensitive.

- Stored outside the repository.
- Directory permissions are set to owner-only where supported.
- Never returned through MCP.
- Never printed by normal commands.
- Never accept profile contents, cookies, or tokens as prompt input.
- Do not commit or sync the state directory to an untrusted system.

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| ChatGPT gains workspace access | Impossible through this MCP surface: there is no workspace tool or mount |
| ChatGPT runs local commands | No shell/process execution tool is exposed |
| Malicious model-generated patch | Returned as text only; proxy cannot apply it |
| Cookie/token exfiltration through MCP | No cookie/storage/profile read tools exist |
| Remote MCP exposure | MCP transport is stdio only; no TCP listener |
| Arbitrary browser navigation | Navigation is fixed to `https://chatgpt.com` and validated conversation URLs |
| Concurrent chat cross-talk | Browser operations are serialized |
| Oversized prompt/response memory use | Local UTF-8 byte caps |
| UI selector ambiguity | Fail closed with `UI_CHANGED`; do not guess requested model/effort |
| CAPTCHA / login challenge | Human action required; no bypass or stealth implementation |
| Browser profile used by two processes | Atomic profile lock with stale-lock recovery |
| Browser downloads | Playwright context uses `acceptDownloads: false` |
| Website popup/new-tab surprises | Core chat workflow never follows assistant links or arbitrary navigation |

## Authentication

The application does not accept ChatGPT passwords, TOTP secrets, session
cookies, or access tokens through CLI flags, environment variables, or MCP
arguments.

`cgw login` opens an ordinary headed browser using the same persistent profile.
The user completes authentication directly with the website.

## Browser automation policy

This project uses standard Playwright APIs. It intentionally does not include:

- stealth plugins
- fingerprint spoofing
- CAPTCHA solving
- anti-bot bypass
- hidden authentication endpoint calls
- cookie injection/export utilities

If the website refuses an automated session, the proxy reports an error.

## Fixed origin

The production browser client only navigates URLs under:

`https://chatgpt.com`

The MCP protocol does not expose a URL parameter.

## Reporting a security issue

Do not include browser-profile data, cookies, passwords, private source code, or
other secrets in a public issue.

Use GitHub's private vulnerability reporting feature if enabled for this
repository, or contact the repository owner privately.
