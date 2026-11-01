# browserctl

browserctl runs browsers for agents and shows them live to their operator.
Agents connect to its MCP server with a client token. The operator manages
client tokens through the `browserctl admin` command.

browserctl is a TypeScript server on Node.js 26. It keeps its state in plain
files and uses no database.

## Run from source

```sh
npm ci
BROWSERCTL_WORK_DIRECTORY=/tmp/browserctl node bin/browserctl.ts serve
```

The server listens on `127.0.0.1:8790` in the development profile and keeps
its state in `$XDG_STATE_HOME/browserctl`. [Configuration](docs/configuration.md)
explains how inputs are layered and validated; the input schema and the
generated [`.env`](.env) list every input.

The server refuses to start when the browser users cannot reach its work
directory, as under a private home directory, so the default
`$XDG_CACHE_HOME/browserctl` rarely works from source. Started this way as an
ordinary user, the server serves admin commands, but every managed session
fails: sessions need the server to run as root beside the browser and session
users that the [`Containerfile`](Containerfile) creates.
`node scripts/test.ts integration` runs the server that way.

## Client tokens

Each agent or person that uses browserctl is a named client with its own
token. With the server running, as the server's user:

```sh
browserctl admin tokens create <name>   # prints the token once
browserctl admin tokens list            # names and creation times
browserctl admin tokens revoke <name>   # the token stops working at once
```

The server stores only each token's SHA-256 hash. The admin command reaches
the server through a Unix socket in the state directory that only the
server's user can open.

## Agent MCP

Agents connect to `/mcp` over MCP's streamable HTTP transport and send their
client token as `Authorization: Bearer <token>`. Each MCP connection binds at
most one browser session:

| Tool | Does |
| --- | --- |
| `profiles_list` | Lists the profiles sessions can start from |
| `session_open` | Opens a session from exactly one of `profile`, `ephemeral: true`, or `provider` with an optional `slot`, and binds it |
| `session_close` | Closes and unbinds the bound session |
| `session_status` | Describes the bound session, including its CDP capability URL |
| `session_file_put` | Writes a base64 file of at most 25 MiB to `uploads/` in the session's file area |
| `session_file_get` | Returns a file of at most 25 MiB from the session's file area |

The connection also lists Playwright MCP's browser tools, which act on the
bound session and are refused while none is bound. Each session's Playwright
MCP runs in a worker process as the session's own user, reaches the browser
through the session's capability URL, and writes snapshots, screenshots, and
downloads to the session's file area. The tool list leaves out
`browser_run_code_unsafe` and `browser_close`. A client reaches only the
sessions it opened; closing the MCP connection closes its session.

## Managed browsers

The server runs each managed Chrome headless, with its sandbox, as a browser
user that no other live session holds, and talks to it only over
`--remote-debugging-pipe`. Clients reach a session's CDP through the server
at `/cdp/<capability>/`, a path holding 256 random bits issued for that
session. `/cdp/<capability>/json/version` names the WebSocket URL, each
WebSocket client gets its own browser session, and the path answers 404 once
the session ends.

At most `BROWSERCTL_SESSION_LIMIT` managed sessions run at once; another
waits up to 60 seconds for a free place. A session closes after the idle
timeout without traffic, at its maximum lifetime, when its client's token is
revoked, and when the server stops.

The server runs as root in its container: it needs the browser and session
users the image creates. Its work directory must be at most 43 bytes long,
for Chrome's singleton socket, and its ancestors must let other users pass
through.

```sh
browserctl admin sessions check   # opens and closes an ephemeral session
```

## Profiles

A profile is a named list of immutable snapshot revisions of a Chrome
profile, one of them current. A session opened from a profile starts on a
fresh copy of its current revision, without Chrome's caches and `Singleton*`
files, and never writes back to it. After each new revision the server keeps
the current revision, pinned ones, and the 5 newest, and deletes the rest.

## Documentation

- [Configuration](docs/configuration.md): input layers, profiles, and protected files
- [Telemetry](docs/telemetry.md): the signals browserctl exports and where they go
- [Testing](docs/testing.md): test classes and gates
