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
| `providers_list` | Lists provider names, reachability, and supported source types |
| `profiles_list` | Lists profiles with their provider. Managed entries also include current revision, services, and shared notes |
| `profiles_note_set` | Claims or updates the client's note on a managed profile using `profile` and `text`; requires note-write permission |
| `session_open` | Binds one browser from the selected `provider` and `source`. Only external providers accept `slot` |
| `session_close` | Closes and unbinds the bound session |
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
{"provider":"workstation","source":{"type":"profile","name":"work"}}
```

The pair `(provider, name)` identifies a profile. An external provider must
advertise the source and profile; Browserctl does not fall back to a different
browser. External profiles are enrolled on the provider and their saved state
does not travel through Browserctl. An external provider can accept `slot`.

The legacy forms `{"ephemeral":true}`, `{"profile":"work"}`, and
`{"provider":"workstation"}` are valid without `source`. The provider-only
form leases the provider's default browser without a starting-state guarantee.

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
