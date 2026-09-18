# Workspace → ChatGPT Project isolation

Version 0.5 binds each local Codex workspace to one exact ChatGPT Project and
uses that Project as the default destination for new chats.

The goal is to add **ChatGPT-side context/memory isolation** without giving
ChatGPT or the browser proxy any workspace filesystem capability.

## Why Projects

A normal ChatGPT chat is scoped only by its conversation id. That prevents CGW
from mixing two local turn records, but it does not itself create a
workspace-specific ChatGPT memory boundary.

With workspace Project isolation:

```text
local workspace A                       local workspace B
       │                                       │
       │ opaque ws_<hash>                      │ opaque ws_<hash>
       ▼                                       ▼
ChatGPT Project A                        ChatGPT Project B
(Project-only memory)                    (Project-only memory)
 ├─ fresh implementation chat             ├─ fresh implementation chat
 ├─ review chat                           └─ debugging chat
 └─ debugging chat
```

CGW does not place Codex/MCP instructions in the Project. The Project is used as
a context-isolation container only.

## Workspace identity

CGW accepts only an opaque id:

```text
ws_<12-64 hexadecimal characters>
```

Example:

```text
ws_8d836fa94e80b7ef21014b10
```

Do **not** pass:

- an absolute workspace path
- a Git remote URL
- an account/repository URL
- a filesystem identifier containing private path components

The intended workflow is for Codex to derive the fingerprint locally, for
example from normalized workspace identity data, hash it locally, and pass only
the opaque digest to CGW.

The raw inputs to that fingerprint never need to cross the MCP boundary.

## Binding

Call:

```text
chatgpt_bind_workspace(
    workspace_id,
    workspace_name?,
    naming_mode?
)
```

If a local binding already exists, CGW reopens/verifies that **exact** Project.

If no binding exists, CGW creates a new Project. It never silently adopts a
same-name Project from the user's existing ChatGPT account.

The local mapping is stored under CGW private state:

```text
<CGW_STATE_DIR>/projects/workspace-projects.json
```

It stores the opaque workspace id and the exact ChatGPT Project id/URL, not the
workspace path or Git remote.

## Project naming

Two modes are available.

### workspace-name

Default:

```text
<workspace display name> · <short workspace hash>
```

For example:

```text
vm-placement · 8d836f
```

The display name is visible in ChatGPT, so use this mode only when revealing
that name is acceptable.

### anonymous

```text
Workspace <short workspace hash>
```

For example:

```text
Workspace 8d836fa94e80
```

Use anonymous naming when the local repository/workspace name itself is
sensitive.

## Project-only memory gate

CGW does not create a Project and then assume its memory mode.

During **new Project creation**, CGW must:

1. open ChatGPT's New Project UI;
2. fill the chosen Project name;
3. locate the visible Project-only-memory choice;
4. explicitly select it;
5. verify the control reports Project-only selected;
6. only then commit Project creation;
7. verify the resulting Project id and usable Project-bound composer;
8. only then persist the local workspace binding.

If the current ChatGPT UI/account does not expose a Project-only-memory choice,
or if the selection cannot be verified, binding fails with
`PROJECT_MEMORY_UNAVAILABLE` / `PROJECT_MEMORY_UNVERIFIED`.

CGW deliberately does not fall back to a default-memory Project.

## Sending

Version 0.5 requires `workspace_id` on sends by default.

For a new turn without `conversation_id`:

```text
workspace_id
   ↓
exact locally bound Project
   ↓
Project home
   ↓
fresh chat inside that Project
```

For a continuation with `conversation_id`:

```text
workspace_id + conversation_id
   ↓
/g/<exact_project_id>/c/<conversation_id>
```

Before typing, CGW verifies:

- the Project id in the active ChatGPT URL matches the local binding;
- a usable composer exists;
- if the composer visibly names its Project, that name is consistent with the
  binding.

After sending, it verifies the resulting thread still belongs to the same
Project.

A mismatch fails closed with `PROJECT_DESTINATION_MISMATCH`.

## Fresh chat semantics

Entering a Project can navigate away from an existing Project thread. Therefore
CGW treats these operations differently:

- **no conversation_id** → go to the exact Project home and create a fresh chat;
- **conversation_id present** → reopen that exact existing thread in the bound
  Project.

Simply noticing that the current browser tab belongs to the same Project is not
enough to reuse an old thread for a fresh send.

## Missing or deleted Projects

If a locally bound Project disappears from ChatGPT, CGW does not search for a
replacement by name.

The operation fails instead. This prevents an unrelated same-name Project from
silently becoming the destination for a workspace.

The user may explicitly unbind the local mapping and create a new binding.

## Unbinding

`chatgpt_unbind_workspace` deletes only CGW's local mapping.

It **does not delete the remote ChatGPT Project**.

Remote Project deletion is intentionally left to the user through ChatGPT's UI.

## Turn and asset identity

Workspace/project identity is carried through the async turn lifecycle:

```text
request_id
workspace_id
project_id
conversation_id
turn_id
```

The request idempotency hash includes `workspace_id`, so the same request id
cannot be reused against a different workspace without a conflict.

Generated file/image asset records also retain their Project id so
`chatgpt_get_asset` reopens the correct Project thread.

## Legacy general-chat opt-out

Project isolation is enabled by default:

```text
CGW_REQUIRE_WORKSPACE_PROJECT=true
```

For an intentional legacy/general-chat workflow only:

```bash
export CGW_REQUIRE_WORKSPACE_PROJECT=false
```

Then sends without `workspace_id` may use ordinary ChatGPT chats.

This opt-out removes the workspace-level Project-memory isolation guarantee.

## Project instructions

CGW intentionally does not add Project instructions such as:

```text
You are being called by Codex through MCP...
```

Doing so would unnecessarily reveal the orchestration architecture to ChatGPT.

If users manually add their own Project instructions later, those are outside
CGW's isolation guarantee and may influence replies.
