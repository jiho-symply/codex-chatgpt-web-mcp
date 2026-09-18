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
| Arbitrary local-file exfiltration | Input tools never accept filesystem paths; only caller-provided text/base64 bytes can enter private staging |
| Secret/credential attachment | Sensitive filenames, obvious private-key/token material, archives/executables and unknown binary are rejected before staging |
| Staged-input tampering | SHA-256, size, regular-file and symlink checks run again immediately before browser upload |
| Stale staged input | Private input staging expires automatically by TTL; expiry is local only and does not imply remote ChatGPT deletion |
| Cookie/token exfiltration through MCP | No cookie/storage/profile read tools exist |
| Remote MCP exposure | MCP transport is stdio only; no TCP listener |
| Arbitrary browser navigation | Navigation is fixed to `https://chatgpt.com` and validated conversation URLs |
| Concurrent chat cross-talk | Browser operations are serialized |
| Duplicate prompt after timeout/retry | Caller request id is reserved before dispatch; same id+payload is deduplicated and different payload conflicts |
| Crash between local reservation and send confirmation | Fail-safe at-most-once behavior: ambiguous `reserved` turns are never auto-re-sent |
| Long generation coupled to one MCP timeout | Persistent turn metadata + bounded wait slices + reply recovery |
| Oversized prompt/response memory use | Local UTF-8 byte caps |
| UI selector ambiguity | Fail closed with `UI_CHANGED`; do not guess requested model/effort |
| CAPTCHA / login challenge | Human action required; no bypass or stealth implementation |
| Browser profile used by two processes | Atomic profile lock with stale-lock recovery |
| Browser downloads | Downloads are allowed only so an explicit `chatgpt_get_asset` call can retrieve an observed file card; outputs are size-capped, hashed, and staged under private proxy state rather than the workspace |
| Website popup/new-tab surprises | Core chat workflow never follows assistant links or arbitrary navigation |
| Model-generated external asset link | Asset retrieval accepts only page-local data/blob or approved ChatGPT/OpenAI/OAI HTTPS origins; arbitrary external origins are rejected |
| Opaque generated-file control | It is clicked only after explicit `chatgpt_get_asset` on a previously observed manifest asset; temporary download is size-checked, staged, hashed, then deleted |

## Turn state

The reliability layer persists only turn metadata outside the workspace:
request id, SHA-256 request payload hash, conversation/turn identifiers, model
labels, status, timestamps, and error code. It does **not** persist prompt or
response bodies.

Turn-state files use owner-only permissions where supported and reject
symlinked state files.

## Explicit input staging

The proxy has no caller-selected local path/directory/repository upload API.

Codex must explicitly provide text/base64 bytes, or use a CGW-created one-time
binary write slot. A slot exposes only a destination path inside CGW's private
input inbox; CGW still never receives a caller-selected source path. Staged
input files live under private application state, use owner-only permissions
where supported, are size/integrity checked, and expire automatically.

The sensitive-input detector is a guardrail, not a complete DLP system. The
caller remains responsible for minimizing source/data sent to ChatGPT.

Once `input_asset_ids` are passed to `chatgpt_send`/`chatgpt_chat`, those
bytes are uploaded to ChatGPT Web. Local staging deletion or TTL cleanup does
not delete already-uploaded content from the ChatGPT account/service.

## Structured response extraction

Response parsing is DOM-semantic, not screenshot/OCR based. Code blocks,
writing blocks, tables, citations, files, images, and previews are extracted
only when the rendered assistant-message DOM can identify them. Unknown
structure is not guessed; flattened visible text remains available.

Generated asset source URLs are not exposed through MCP. Only opaque asset ids
are returned in manifests.

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
