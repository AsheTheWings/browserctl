# browserctl

browserctl runs browsers for agents and shows them live to their operator.
Agents connect to its MCP server with a client token. The operator manages
client tokens through the `browserctl admin` command.

browserctl is a TypeScript server on Node.js 26. It keeps its state in plain
files and uses no database.

## Run from source

```sh
npm ci
node bin/browserctl.ts serve
```

The server listens on `127.0.0.1:8790` in the development profile and keeps
its state in `$XDG_STATE_HOME/browserctl`. [Configuration](docs/configuration.md)
explains how inputs are layered and validated; the input schema and the
generated [`.env`](.env) list every input.

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

## Documentation

- [Configuration](docs/configuration.md): input layers, profiles, and protected files
- [Telemetry](docs/telemetry.md): the signals browserctl exports and where they go
- [Testing](docs/testing.md): test classes and gates
