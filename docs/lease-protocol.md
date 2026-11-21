# Lease protocol

How does browserctl lease a browser from an external provider?

An external provider is a configured service that leases browsers. Set
`cdpHost` only for providers with legacy debugging ports. Without it,
Browserctl requires an explicit source and does not watch legacy slots.

## Legacy leases

Every request carries `Authorization: Bearer <token>`; a provider answers a
missing or wrong token with 401 `{"error":"unauthorized"}`. Bodies are JSON.

| Request | Body | Answer |
| --- | --- | --- |
| `POST /leases` | `{"owner": string, "slot"?: integer}`, at most 4096 bytes | 201 `{"lease": string, "slot": integer, "port": integer}`; 503 when every slot is leased |
| `POST /leases/<id>/ensure` | none | 200 `{"slot", "port"}` once the slot's browser answers and has a page |
| `POST /leases/<id>/heartbeat` | none | 200 `{"slot"}` |
| `DELETE /leases/<id>` | none | 200 `{"slot"}` once the slot's browser is closed and the slot is free |
| `GET /status` | none | 200 `{"slots": [{"slot", "port", "owner", "running", "idleMs"}]}` for leased slots only |

A request for an unknown lease answers 404 `{"error":"unknown lease"}`, and
other failures answer 500 `{"error": string}`. A provider truncates `owner` to
200 characters, grants a requested free slot, and otherwise picks a free one.
Any request on a lease refreshes it; a lease expires 90 seconds after its last
request.

The browser of a leased slot answers `GET /json/version` on its port at the
provider's address, without credentials. Its DevTools HTTP accepts only an IP
address in `Host`, so browserctl addresses it by IP.

## Explicit browser sources

A provider with isolated browser sources adds `capabilities` to `GET /status`:
`{"cdp":"lease","sources":["ephemeral","profile"],"profiles":["work"]}`.
Advertise supported source types and up to 500 unique available profile names
(lowercase letters, digits and hyphens, starting with a letter, at most 63
characters). An inventory describes available state, not whether services
are signed in. Providers without this field support only provider-only requests.

For `POST /leases`, an explicit `source` is `{"type":"ephemeral"}` or
`{"type":"profile","name":"work"}`. Return 404 for an unavailable source
without allocating a lease. Success returns `lease`, `slot`, `cdp: "lease"`,
and the accepted `source`, without a raw debugging port. Lease IDs must be
unguessable. `POST /leases/<id>/ensure` answers `{"cdp":"lease"}` when ready.

Start Chrome with an empty data directory or an isolated working copy of a
profile enrolled on that provider. The provider owns enrollment and saved
state. Lease close or expiry revokes access, closes the browser and discards
its copy before the slot can be reused; it never saves changes back.

Serve version JSON at `GET /leases/<id>/cdp/json/version` and upgrade
`GET /leases/<id>/cdp/devtools/browser` to the browser WebSocket. Both need the
bearer credential that owns the lease; other clients must not reach raw Chrome
DevTools. Exclude explicit-source leases from the watchable `/status` slots.
Browserctl uses the configured provider origin and requires HTTPS outside
numeric loopback. It does not follow a socket URL returned by the provider.
Browserctl does not provide live views or recordings for these leases.

### Serving leases with Browserctl

A separate Browserctl instance can serve explicit-source leases. Enable its
provider token file (see the [input schema](../config/inputs.json)) and deliver
the same dedicated token to the consuming instance's provider entry. Keep
the provider listener on numeric loopback; for a remote consumer, put an
HTTPS reverse proxy in front that preserves authorization and WebSocket
upgrades. The provider token is separate from dashboard and MCP credentials.

Enroll profiles in the **provider instance's own dashboard**: create a
profile, sign in in its interactive browser, then save a revision. Do not
copy a data directory from another machine. The consumer discovers the
profile name, not its revisions, services, or notes. Keep notes and update
the saved revision in the provider instance's own dashboard. Leases share
that instance's managed browser capacity.

## How browserctl uses it

- `session_open` with a provider leases a slot with owner
  `browserctl <client> <session id>`, calls `ensure`, and checks the browser's
  `/json/version`. It sends a heartbeat every 30 seconds while the session
  lives and `DELETE` when the session ends, including on shutdown.
- Session processes never reach the provider's address: the relay forwards
  each WebSocket client of the session's capability URL to the browser's
  debugging WebSocket.
- A 503 on `POST /leases` fails `session_open` with a capacity error. A 401,
  no answer within 30 seconds, or any other failure is a provider error:
  `provider_unauthorized`, `provider_unreachable`, or `provider_error`.
- A 404 on a heartbeat means the provider lost the lease: the session ends
  with reason `lease_lost`, and browserctl sends no `DELETE` for it.
- browserctl polls each provider's `GET /status` every 30 seconds, to show
  each provider's reachability and the browsers other owners lease.
- Each request is a `browserctl.lease.request` span, and each failure of a
  session's lease is a `browserctl.lease.failed` LogRecord; see
  [Telemetry](telemetry.md).
