# browserctl

browserctl runs browsers for agents and shows them live to their operator.
Agents connect to its MCP server with a client token. The operator manages
client tokens through the `browserctl admin` command.

browserctl is a TypeScript server on Node.js 26. It keeps its state in plain
files and uses no database. CI builds and qualifies its OCI image on every
pull request, branch push, and manual dispatch, and publishes a qualified
image to the operator's artifact registry from push and dispatch runs once
that registry is configured.

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

## Run the image

[`compose.yaml`](compose.yaml) is the reference deployment. It runs the image
with host networking, mounts the state, session work, and recordings
directories, mounts the protected files read-only at `/run/browserctl`, and
keeps exactly the seven capabilities Chrome's sandbox needs with
no-new-privileges. Set `BROWSERCTL_IMAGE`, `BROWSERCTL_ENV_FILE` (a file of
the server's inputs), `BROWSERCTL_STATE_PATH`, `BROWSERCTL_WORK_PATH`,
`BROWSERCTL_RECORDINGS_PATH`, and `BROWSERCTL_PROTECTED_PATH`, then run:

```sh
podman compose -f compose.yaml up -d
podman compose -f compose.yaml exec browserctl node bin/browserctl.ts admin tokens create <name>
podman compose -f compose.yaml exec browserctl node bin/browserctl.ts admin dashboard-link <name>
```

Inside the image the state and work directories default to traversable
paths under `/var/lib/browserctl`; the compose file overrides them to its
mounts. [Configuration](docs/configuration.md) owns the inputs and their
layers, and [Testing](docs/testing.md) owns the image's build and
qualification commands.

## Client tokens

Each agent or person that uses browserctl is a named client with its own
token. With the server running, as the server's user:

```sh
browserctl admin tokens create <name>   # prints the token once
browserctl admin tokens list            # names and creation times
browserctl admin tokens revoke <name>   # the token stops working at once
browserctl admin dashboard-link <name>  # prints a one-time dashboard link
```

The server stores only each token's SHA-256 hash. The admin command reaches
the server through a Unix socket in the state directory that only the
server's user can open.

## Agent MCP

Agents connect to `/mcp` over MCP's streamable HTTP transport and send their
client token as `Authorization: Bearer <token>`. Each MCP connection binds at
most one browser session, reaches only the sessions it opened, and lists
Playwright's browser tools for the bound session beside browserctl's session
and task tools. It serves the task contract and e2e guides as MCP resources.
See [MCP](docs/mcp.md).

## Tasks

A task is a saved e2e test file that runs against a session's browser,
reading a JSON input and writing a JSON output. Runs execute as the
session's user, reach the configured model only through the server's
forwarder at `POST /v1/responses`, and keep one replay cache per task, so
repeated runs replay recorded agent actions without model calls. A
profile's services name check tasks, which the server runs on a schedule to
record whether the profile is still signed in. See [Tasks](docs/tasks.md).

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
timeout without traffic or a task run, at its maximum lifetime, when its
client's token is revoked, and when the server stops.

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

## Dashboard

The operator opens the dashboard at `/dashboard` through a link that
`browserctl admin dashboard-link <name>` prints for an existing client. The
link works once within 10 minutes and sets a dashboard session cookie for
that client, valid for 7 days. The dashboard shows every live session and
every browser other owners lease from a provider as a live grid, opens a
focused view of one, manages profiles and their services, and lists tasks,
recent runs, and providers, and plays recordings. Signing in to a profile
opens Chrome on its own display, shown through noVNC, and saving it commits
a new current revision. See [Dashboard](docs/dashboard.md).

## Recordings

The server records each agent and check session's screencast as H.264 MP4,
at most 10 frames per second and 960 pixels wide, in
`BROWSERCTL_RECORDINGS_DIRECTORY`. It deletes recordings after 7 days, and
the oldest first while the directory exceeds its cap. See
[Recordings](docs/recordings.md).

## Documentation

- [Configuration](docs/configuration.md): input layers, profiles, and protected files
- [Dashboard](docs/dashboard.md): access, live views, sign-in sessions, profile management, and recordings
- [MCP](docs/mcp.md): the endpoint, session and task tools, browser tools, files, and guides
- [Recordings](docs/recordings.md): what is recorded, where it lives, and how long it is kept
- [Lease protocol](docs/lease-protocol.md): how browserctl leases browsers from external providers
- [Security](docs/security.md): credentials, isolation, and the deployer's network confinement
- [Tasks](docs/tasks.md): the task contract, runs, the model forwarder, the replay cache, and service checks
- [Telemetry](docs/telemetry.md): the signals browserctl exports and where they go
- [Testing](docs/testing.md): test classes and gates
