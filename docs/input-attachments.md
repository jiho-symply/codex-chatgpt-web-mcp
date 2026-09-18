# Explicit input attachments

Version 0.4 adds a one-way input staging boundary between Codex and ChatGPT Web.

The proxy still has **no arbitrary filesystem-read tool**. Codex must explicitly
provide the bytes/text it wants to send.

## Flow

```text
Codex
  │
  ├─ chatgpt_stage_text(content, filename)
  │          or
  ├─ chatgpt_stage_blob(base64, filename, mime)
  │
  ▼
private CGW input staging
  │
  └─ input_asset_id
          │
          ▼
chatgpt_send(..., input_asset_ids=[...])
          │
          ▼
ChatGPT Web attachment UI
```

Staging alone does **not** upload anything to ChatGPT.

## MCP tools

### chatgpt_stage_text

Use for:

- source code
- diffs / patches represented as text
- build/test logs
- Markdown / TXT
- CSV / TSV
- JSON / JSONL
- XML
- YAML
- TOML
- SQL
- other UTF-8 text

The tool accepts only caller-provided content. It does not accept a local file
path.

### chatgpt_stage_blob

Use only for small supported binary document/image inputs (up to 1 MiB) when
passing base64 through the MCP call is practical.

Current allowlist:

| Type | Extensions |
| --- | --- |
| PDF | .pdf |
| Word OpenXML | .docx |
| PowerPoint OpenXML | .pptx |
| Excel OpenXML | .xlsx |
| legacy Excel | .xls |
| PNG | .png |
| JPEG | .jpg, .jpeg |
| GIF | .gif |

Binary MIME and filename extension must agree, and CGW performs a basic magic
signature check. For Office OpenXML files this confirms a ZIP container; CGW is
not an Office-format validator or malware scanner.

ZIP/TAR/7z/RAR, executables, libraries, JAR/WAR, unknown binary, and macro-enabled
Office formats are intentionally unsupported.

### chatgpt_create_blob_slot / chatgpt_commit_blob_slot

For larger binary files, avoid sending large base64 through a model/tool call.

1. Call `chatgpt_create_blob_slot(filename, mime)`.
2. CGW returns a short-lived `slot_id` and one private `writePath` under
   CGW's input inbox.
3. Codex copies/writes only the intended bytes to that exact path.
4. Call `chatgpt_commit_blob_slot(slot_id)`.
5. CGW checks regular-file/symlink status, expiry, size limit, extension/MIME,
   and basic file signature, then computes SHA-256 once while staging the final
   input asset.

The slot expires after 15 minutes and is cleaned automatically. This is not an
arbitrary path API: CGW creates the destination and never receives a
caller-selected source path.

### CLI-only staging maintenance

Listing/discarding staged inputs is intentionally kept out of the MCP tool
catalog. Use:

```text
cgw inputs
cgw discard-input <input_asset_id>
```

This keeps maintenance operations out of Codex's routine tool-selection surface.

## Sending attachments

`chatgpt_send` and `chatgpt_chat` accept:

```json
{
  "input_asset_ids": [
    "input_...",
    "input_..."
  ]
}
```

The proxy resolves only those opaque ids to its own private staging files.

Before browser upload it verifies:

- record still exists and has not expired
- file is a regular non-symlink file
- file byte size matches metadata
- SHA-256 still matches
- per-turn attachment count limit
- total attachment byte limit

If an attachment cannot be confirmed in the ChatGPT composer, the prompt is not
sent and the call fails with `UPLOAD_UNCONFIRMED`.

## Privacy boundary

Uploading an input through `chatgpt_send` sends those bytes to ChatGPT Web.

Depending on the user's ChatGPT account and service settings, uploaded files may
remain associated with the ChatGPT conversation/account. Therefore:

- stage only the minimum necessary material
- do not stage secrets/credentials
- do not treat CGW's local TTL as deletion from ChatGPT
- use account/service controls separately when remote deletion is required

## Sensitive-input policy

The proxy blocks credential-like filenames such as:

- .env / .env.*
- credentials*
- secret / secrets*
- private-key-style files
- .npmrc / .pypirc / .netrc / .git-credentials
- .pem / .key / .p12 / .pfx / keystore files
- service-account-style JSON names

Text staging hard-blocks actual private-key blocks. Broad token-looking strings
are not hard-blocked because source code, documentation, and test fixtures can
legitimately contain them. This is not a DLP scanner.

This is a guardrail, not a complete data-loss-prevention system. Codex/user
still owns the decision about what information is appropriate to upload.

## Limits

Defaults:

- text staging: 4 MiB per item
- base64 `stage_blob`: 1 MiB per item
- committed binary slot: 20 MiB per item
- one-time binary write slot: 15 minute expiry
- combined input attachments per turn: 50 MiB
- attachments per turn: 10
- local staging TTL: 24 hours

TTL is configurable with:

```bash
CGW_INPUT_TTL_HOURS=24
```

Allowed range: 1-168 hours.

Expired local staging records/files are cleaned automatically on normal input
operations and MCP startup.

## Why no path-based API?

This project intentionally does not implement:

```text
chatgpt_upload_file("/home/user/project/file")
```

or directory/repository upload APIs.

That would turn the browser proxy into a filesystem capability. Instead Codex,
which already owns workspace access, reads a file itself and explicitly passes
only the intended contents/bytes across the MCP boundary.
