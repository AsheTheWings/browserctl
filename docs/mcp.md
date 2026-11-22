# MCP

How do agents drive browsers through browserctl?

## Connecting

Agents connect to `/mcp` over MCP's streamable HTTP transport and send their
client token as `Authorization: Bearer <token>`. A missing, wrong, or revoked
token is refused, and revoking a token closes that client's MCP connections
and the session they opened.

Each MCP connection binds at most one browser session. A connection reaches
only the sessions it opened; closing the connection closes the session.

## Session tools

| Tool | Does |
| --- | --- |
| `providers_list` | Lists provider names, available descriptions, reachability, and supported source types |
| `profiles_list` | Lists profiles with their provider. Managed entries also include current revision, services, and shared notes |
| `profiles_note_set` | Claims or updates the client's note on a managed profile using `profile` and `text`; requires note-write permission |
| `session_open` | Binds one browser from the selected `provider` and `source`. Only lease providers accept `slot` |
| `session_close` | Unbinds the session and detaches instead of closing an existing browser |
| `session_status` | Describes the bound session or returns `{"bound":false}` |
| `session_file_put` | Decodes base64 into a file in the bound session's `uploads/` directory and returns its relative path and byte count |
| `session_file_get` | Reads a path relative to the bound session's file area and returns the file as base64 |
| `task_list` | Lists the saved tasks and their latest revisions |
| `task_get` | Returns a task revision, the latest unless one is named |
| `task_save` | Saves an e2e test file as a new revision of a task |
| `task_run` | Runs a task revision against the bound session with a JSON input and returns its result |

Notes are context, not instructions or verified login state. An operator can
grant or withdraw note-write access on an existing token with
`browserctl admin tokens notes <name> allow|deny`. Clients can read notes
without this grant. A client cannot overwrite another client's note or clear
notes. The server assigns each note's `client` and `updated_at` values. See [profile notes](dashboard.md#profiles-tasks-and-providers)
for limits and visibility.

### Choosing a browser

`provider` defaults to `managed`, Browserctl's built-in provider. Choose
`source: {"type":"ephemeral"}` for an empty browser or
`source: {"type":"profile","name":"work"}` for a working copy of saved state.
For example:

```json
{"provider":"remote","source":{"type":"profile","name":"work"}}
```

The pair `(provider, name)` identifies a profile. Profiles created for the
built-in `managed` provider or a compatible
[managed runtime provider](lease-protocol.md#managed-runtime-providers) live in
Browserctl's own profile store, include current revision, services, and notes,
and run on their assigned runtime when `provider` is omitted. Other external
providers must advertise the source and profile; their saved state stays on
that provider. An external lease provider can accept `slot`.

The legacy forms `{"ephemeral":true}`, `{"profile":"work"}`, and
`{"provider":"remote"}` are valid without `source`. The provider-only
form leases the provider's default browser without a starting-state guarantee.

For a provider advertising `existing`, explicitly request
`{"provider":"operator-browser","source":{"type":"existing"}}`. Do not pass a
slot or profile. The operator sees the authenticated MCP client name and
must approve through the provider. Allow at least 180 seconds for the MCP
call, including operator approval and worker startup.

An attachment acts on the browser's live tabs, not a copy or a single tab.
There is no profile operation, dashboard view, recording, or task execution.
`session_close` detaches; the browser stays open. The operator can revoke
access through the provider, and a later attachment requires new approval.
See the [attach protocol](attach-protocol.md) for configuration.

## Browser tools

The connection also lists Playwright MCP's browser tools, which act on the
bound session and are refused while none is bound. The list leaves out
`browser_run_code_unsafe`, which would run code in the worker, and
`browser_close`, which would end the browser under its owner.

Each session's Playwright MCP runs in a worker process as the session's own
user, reaches the browser through the session's capability URL, and writes
snapshots, screenshots, and downloads to the session's file area. Browser
tools wait while a task run drives the session. The capability URL never
reaches an agent.

## Files

A session's file area holds `uploads/`, which `browser_file_upload` reads,
and its downloads and outputs at the root. For `session_file_put`, give a
filename without directories. Writing the same name again replaces that file.
For `session_file_get`, give a path relative to the file area. Both tools
limit the decoded file size to 25 MiB.

## Tasks

The task tools save an e2e test file and run it against the bound session's
browser. [Tasks](tasks.md) owns the task contract, its inputs, outputs, the
model forwarder, and the replay cache.

## Guides as resources

The connection serves three MCP resources:

| Resource | Content |
| --- | --- |
| `browserctl://guides/tasks` | The task contract: inputs, outputs, the bound browser, and run results |
| `browserctl://guides/e2e-writing-tests` | The e2e guide to writing test files |
| `browserctl://guides/e2e-agent` | The e2e guide to agent steps and the replay cache |
