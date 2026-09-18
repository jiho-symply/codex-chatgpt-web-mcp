# Structured response manifest

Version 0.3 no longer treats a ChatGPT assistant message as only one flattened
string.

The proxy still returns `response` / `plainText` for backwards compatibility,
but it also extracts a structured `manifest`.

## Manifest shape

```json
{
  "version": 1,
  "plainText": "Explanation plus visible response text",
  "assistantIndex": 4,
  "structured": true,
  "assetCount": 1,
  "codeBlockCount": 1,
  "parts": [
    {
      "type": "text",
      "text": "Apply the following patch."
    },
    {
      "type": "code",
      "language": "diff",
      "text": "diff --git ..."
    },
    {
      "type": "file",
      "assetId": "asset_...",
      "filename": "solution.patch",
      "mime": "text/x-diff",
      "downloadable": true
    }
  ]
}
```

The order of `parts` follows the rendered assistant-message DOM as closely as
possible.

## Part types

### text

Ordinary assistant prose. UI buttons and decorative SVG are omitted.

### code

A rendered `<pre>` code block. The extractor preserves line breaks and code
text and attempts to recover the language from semantic attributes/classes.

Codex should prefer a structured `code` part over parsing code back out of the
flattened `plainText`.

### writing_block

A ChatGPT writing/artifact/canvas-style block that can be identified from
semantic/test-id markers.

Fields:

- `title`
- `text`
- `editable`

The proxy does not edit writing blocks. It only extracts their visible current
contents.

### table

A rendered HTML table with:

- headers
- rows
- a normalized Markdown representation

### citation

A citation/source element identified by semantic citation/source markup.

The proxy returns only HTTP(S) citation URLs. Citation links are metadata; they
are not automatically opened.

### image

A meaningful image in the assistant response.

The manifest exposes an opaque `assetId`, alt text, and dimensions. It does not
expose the underlying authenticated/signed image URL.

### file

A generated/downloadable file card.

The manifest exposes an opaque `assetId`, filename, and MIME hint. The file is
not automatically downloaded.

### preview

An identifiable iframe/preview panel or other rendered preview surface.

The proxy returns only visible preview metadata/text. It does not follow the
preview URL or grant arbitrary browser navigation.

## Asset retrieval

Use:

```text
chatgpt_get_asset(asset_id)
```

Only assets previously observed in a response manifest can be retrieved.

The asset is written to:

```text
<CGW_STATE_DIR>/assets/staging/
```

never directly to the Codex workspace.

The result contains:

- sanitized filename
- MIME hint
- size
- SHA-256
- local staging path

Codex decides whether to read/copy/apply the staged asset.

### URL-backed assets

The proxy accepts only:

- page-local `data:` / `blob:` assets
- HTTPS assets from ChatGPT/OpenAI/OAI content origins

It rejects arbitrary external origins even if an assistant response contains a
link to one.

### Opaque file cards

If a generated file card does not expose a safe direct URL, an explicit
`chatgpt_get_asset` call may activate that card's download control.

Browser downloads are never initiated merely by reading a response manifest.
The downloaded temporary file is size-checked, copied into the private staging
directory, hashed, and the browser temporary copy is deleted.

## Deliberate limits

The extractor is DOM-semantic rather than screenshot/OCR based.

If ChatGPT changes a component so that it can no longer be identified safely,
the content may remain available in `plainText` while the structured part is
missing. The proxy does not invent structure from visual guesses.

Live smoke tests should cover:

- plain text
- one and multiple code blocks
- diff code block
- writing block
- table
- citations
- generated file
- generated image
- preview
- combinations of the above
