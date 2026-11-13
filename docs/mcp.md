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
| `profiles_list` | Lists the profiles sessions can start from, their current revision, and their services |
| `session_open` | Opens a session from exactly one of `profile`, `ephemeral: true`, or `provider` with an optional `slot`, and binds it |
| `session_close` | Closes and unbinds the bound session |
| `session_status` | Describes the bound session, or reports that none is bound |
| `session_file_put` | Writes a base64 file of at most 25 MiB to `uploads/` in the session's file area |
| `session_file_get` | Returns a file of at most 25 MiB from the session's file area, such as a download or screenshot |
| `task_list` | Lists the saved tasks and their latest revisions |
| `task_get` | Returns a task revision, the latest unless one is named |
| `task_save` | Saves an e2e test file as a new revision of a task |
| `task_run` | Runs a task revision against the bound session with a JSON input and returns its result |

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
and its downloads and outputs at the root. A file's path is relative to that
area, may not leave it, and is at most 25 MiB.

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
