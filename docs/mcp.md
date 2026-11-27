# MCP

How do agents drive browsers through browserctl?

## Connecting

Agents connect to `/mcp` over MCP's streamable HTTP transport and send their
client token as `Authorization: Bearer <token>`. A missing, wrong, or revoked
token is refused, and revoking a token closes that client's MCP connections
and the session they opened.

Each MCP connection binds at most one browser session, and initialization
returns concise server `instructions` covering session lifecycle, operator
takeover, loopback access, element targeting, screenshots, and out-of-band
secrets. By default a connection reaches only the session it opened; closing
the connection closes that session. An unbound connection stays alive while its
standalone SSE stream is open; once disconnected without a bound session, the
idle sweep drops it after the session idle timeout.
Clients granted session-management access can list and close any live session
across the server while still binding at most one session to their own
connection.

## Session tools

| Tool | Does |
| --- | --- |
| `providers_list` | Lists provider names, available descriptions, reachability, supported source types, and reported capacity |
| `profiles_list` | Lists profiles with their provider. Managed entries also include current revision, services, and shared notes |
| `profiles_note_set` | Claims or updates the client's note on a managed profile using `profile` and `text`; requires note-write permission |
| `sessions_list` | Lists all live sessions on the server (client, purpose, provider, source, state, idle time, `takeover`, and `own_connection`); requires session-management permission |
| `sessions_close` | Closes any live session by `session_id` (requires `force: true` for `sign_in` sessions); requires session-management permission |
| `session_open` | Binds one browser from the selected `provider` and `source`. Only lease providers accept `slot`. Fails fast on capacity by default; pass `wait_seconds` (0–60) to wait for a managed slot |
| `session_close` | Unbinds the session and detaches instead of closing an existing browser |
| `session_status` | Describes the bound session (including `takeover`, plus `dashboard_url` for managed sessions) or returns `{"bound":false}` |
| `session_file_put` | Decodes base64 into a file in the bound session's `uploads/` directory and returns its relative path and byte count |
| `session_file_get` | Reads a path relative to the bound session's file area and returns the file as base64 |
| `session_secret_prepare` | Mints a short-lived, single-use `PUT` URL to upload one or more secrets into the bound session from a local file |
| `session_secrets_list` | Lists the names of secrets currently loaded in the bound session without values |
| `session_secrets_clear` | Removes one named secret or all secrets from the bound session |
| `session_loopback_allow` | Allows the bound managed browser session (and its task runs) to reach one host loopback port; requires loopback permission |
| `session_loopback_list` | Lists loopback ports currently allowed for the bound session and configured loopback hosts |
| `session_loopback_clear` | Revokes one allowed loopback port or all loopback ports for the bound session |
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

An operator can grant or withdraw fleet session-management access on an existing
token with `browserctl admin tokens sessions <name> allow|deny`. `sessions_list`
never exposes capability URLs, tokens, or page content. `sessions_close`
requires `force: true` to close a `sign_in` session that may hold unsaved login
state.

### Capacity

`providers_list` includes a `capacity` object (`total`, `used`, `available`, and
`queued` for `managed`) for the built-in `managed` provider and for external
providers that advertise capacity on their status poll. Because external status
is polled periodically, capacity is advisory.

When `session_open` hits capacity, it fails fast by default (pass `wait_seconds`
from `0` to `60` to queue for a `managed` slot) and returns an error JSON object
containing `error: "capacity"`, `message`, `provider`, the provider's current
`capacity` when known, and `alternatives` listing other reachable providers with
available or unreported capacity.

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
snapshots, screenshots, and downloads to the session's file area. Action tools
inline saved page snapshots up to 16 KiB directly into their text result
(redacted for loaded session secrets) and keep the file link with a
`browser_snapshot` hint for larger snapshots. `browser_take_screenshot` saves
the capture to the session's file area and returns it as an MCP `image` content
block whether or not `filename` is given, subject to the 25 MiB file-area
limit. Browser tools and `task_run` refuse calls with a conflict error while a
task run or an operator takeover drives the session. For managed sessions,
`session_open` and `session_status` also include `dashboard_url` so an agent
blocked by a human-only gate can keep the session open, direct the user to
take over in the dashboard, and resume once `takeover` returns to `false`.
The capability URL never reaches an agent.

## Files

A session's file area holds `uploads/`, which `browser_file_upload` reads,
and its downloads and outputs at the root. For `session_file_put`, give a
filename without directories. Writing the same name again replaces that file.
For `session_file_get`, give a path relative to the file area. Both tools
limit the decoded file size to 25 MiB.

## Secrets

Agents can load secrets into a live browser session without placing secret
values in MCP tool arguments, command output, or model context, and without
restarting browserctl or the MCP connection.

1. Call `session_secret_prepare` on a bound session to obtain a single-use
   `PUT` URL valid for 60 seconds:
   - `{"name":"APP_PASSWORD"}` (default `format: "value"`) accepts a single-value
     file and strips one trailing newline unless `trim_newline: false` is set.
   - `{"format":"env"}` parses `NAME=value` lines (skipping blank lines and `#`
     comments, unwrapping one pair of matching surrounding single or double
     quotes without escape expansion) and loads every entry. Pass `name`
     alongside `format: "env"` to load only that key from the file.
2. Upload the local protected file directly to the returned URL:

```sh
curl -fsS -X PUT --data-binary @/path/to/secret "$UPLOAD_URL"
```

The endpoint accepts up to 64 KiB, stores up to 64 secrets per session in
server memory, consumes the upload URL, and answers with the loaded secret
names.

3. Reference loaded secrets in `browser_type` (`text`) or `browser_fill_form`
   (`fields[].value`) as `{{secret:NAME}}`. Browserctl substitutes the value
   before forwarding the call to the Playwright worker, fails closed if the
   secret name is not loaded, and redacts loaded secret values from text tool
   responses as `<secret>NAME</secret>`.

Secrets stay in memory only for the bound session and are cleared when
`session_secrets_clear` runs or the session closes.

## Loopback access

When the server enables its per-session loopback proxy
(`BROWSERCTL_LOOPBACK_PROXY_PORT`), managed agent sessions launch Chrome with a
loopback-only PAC script and `--proxy-bypass-list=<-loopback>` that routes
`127.0.0.1`, `localhost`, `::1`, and any configured `BROWSERCTL_LOOPBACK_HOSTS`
(exact hostnames or `*.domain` subdomain wildcards) through a per-session proxy
listener on `127.16.0.0/12`, leaving all other traffic direct. When
`BROWSERCTL_EXTRA_CA_CERT_FILE` is set, managed browser sessions install that
PEM CA certificate into their NSS trust store so internal HTTPS routes verify
without browser certificate errors.

An operator grants or revokes loopback permission per client token with
`browserctl admin tokens loopback <name> allow|deny`. An authorized client
calls `session_loopback_allow` with a port number to expose that port on
`127.0.0.1` to the bound session's browser (including `task_run` executions on
that session) over HTTP and `CONNECT` tunnels. Ports listed in
`BROWSERCTL_LOOPBACK_DENY_PORTS` are always refused. Grants expire when cleared
with `session_loopback_clear` or when the session closes.

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
