# Lease protocol

How does browserctl lease a browser from an external provider?

An external provider is a service that hands out browsers with a debugging
port, one per slot. Each provider is an entry of `BROWSERCTL_PROVIDERS`: its
name, the base URL of its lease API, the IP address its browsers' debugging
ports answer on, and a protected file holding browserctl's token for it.

## Requests

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
