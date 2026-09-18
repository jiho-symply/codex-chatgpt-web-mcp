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

Use for supported binary document/image inputs.

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

Binary MIME, filename extension, and file signature must agree.

ZIP/TAR/7z/RAR, executables, libraries, JAR/WAR, unknown binary, and macro-enabled
Office formats are intentionally unsupported.

### chatgpt_list_staged_inputs

Lists only explicit CGW staging records. It never discovers workspace/home files.

### chatgpt_discard_staged_input

Deletes one staged input from CGW private state.

It cannot remove a file from ChatGPT after that input has already been uploaded.

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

Text staging also blocks obvious secret material such as private-key blocks and
well-known live-token formats.

This is a guardrail, not a complete data-loss-prevention system. Codex/user
still owns the decision about what information is appropriate to upload.

## Limits

Defaults:

- text staging: 4 MiB per item
- binary input: 20 MiB per item
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
