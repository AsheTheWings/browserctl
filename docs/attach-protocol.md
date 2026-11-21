# Existing browser provider

An attach provider brokers a client's access to an already-running browser.
The [input schema](../config/inputs.json) defines its configuration. Point
its origin at a verified HTTPS endpoint or a numeric loopback address. Use
an authenticated private tunnel when forwarding a loopback origin to a
remote machine. Deliver the provider's dedicated bearer token as an
owner-only file. Do not expose raw browser debugging or share the token
with MCP clients.

Browserctl sends the bearer token on both requests:

- `GET /v1/capabilities` must return
  `{"protocol":"browserctl.existing-browser.v1","sources":["existing"]}`.
  This poll does not request a browser or trigger approval.
- Upgrade `GET /v1/attach/existing` to WebSocket with the authenticated
  client name in `X-Browserctl-Client`. The provider waits for approval
  before returning HTTP 101. HTTP 401 indicates a rejected broker
  credential, 403 refusal, 408 expiry, and 409 a busy provider.

Once approved, the socket carries text CDP frames for one worker.
Browserctl does not follow redirects, send a browser-close command, or
reconnect the socket. Either side closing it revokes the attachment. The
provider owns the local consent prompts and bounds the session lifetime.
See [choosing a browser](mcp.md#choosing-a-browser) for the agent contract.
