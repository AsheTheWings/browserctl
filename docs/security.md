# Security model

What does browserctl protect, what does it isolate, and what must the
deployer confine?

## Principals and credentials

A client is named and holds one token. The server stores only the token's
SHA-256 hash, in the state directory, and revoking it closes that client's
MCP connections and browser sessions at once. The
admin command reaches the server through a Unix socket in the state
directory that only the server's user can open.

An agent's MCP connection binds at most one session and by default reaches only
the session it opened. Clients explicitly granted session-management access via
`browserctl admin tokens sessions <name> allow` can list and close any live
session across the server, without gaining access to another session's
capability URL, browser tools, or page content. Session workers and task runs
reach their session's browser through a 256-bit capability URL, which no tool or
signal exposes.
The relay answers 404 for a wrong or revoked capability, and the dashboard
checks its own session cookie and Origin before any state change or live
view.

The production dashboard authorizes the configured GitHub owner through a
browser-bound OAuth state and a server-side PKCE verifier. Development uses
a shared password delivered as a protected file. The dashboard
[access policy](dashboard.md#access) covers session cookies, sign-out,
and Origin checks. The dashboard sends input only to sign-in sessions,
through the display's own VNC bridge. The managed agent's full-window
viewer receives video through an authenticated HTTP response.

External providers are trusted to isolate browser state. Use only
[explicit-source leases](lease-protocol.md#explicit-browser-sources) or
[managed runtime providers](lease-protocol.md#managed-runtime-providers) for
signed-in profiles: the provider authenticates each lease's DevTools, media,
and VNC endpoints and withholds raw browser endpoints. Browserctl exposes live
views and recordings for managed runtime leases and withholds them for opaque
explicit-source leases. Legacy provider debugging ports require network
confinement and do not provide the same isolation.

An [existing browser attachment](attach-protocol.md) grants a named client
access to the live browser only after operator approval. Keep the provider's
debugging listener off the network, and give access only to a client you
trust with any open tab and signed-in site. Browserctl does not expose an
attachment to dashboard viewers, recordings, or task runs.

Managed agent and sign-in browsers each have a private, cookie-authenticated
Xvfb display without a window manager. A managed agent browser uses a
DevTools pipe, and a sign-in browser uses X11 input. The sign-in VNC
server listens on a Unix socket in the session's 0700 directory, and the
server is its only client.

The model key never reaches a session worker or a task run: they call the
server's forwarder, which names the configured model and holds the key.
Playwright workers run as the session's user with an allowlist that excludes
running code and closing the browser.

Recordings hold page content, so the recordings directory is mode 0700 and
each video is served only to dashboard sessions. Telemetry carries no token,
capability URL, cookie, page content, task input or output, or model payload.

Session secrets are uploaded through a 256-bit single-use capability URL bound
to one live session, held only in server memory until cleared or the session
closes, and never written to disk or telemetry. Audit records and MCP tool
responses name secrets without values, and text tool responses redact loaded
secret values. Non-password fields remain visible in session recordings.

## Host and container

The server runs as root inside its container because it switches to the
image's browser and session users, gives them their directories, reads what
they write, and stops their processes. It keeps no capability beyond
`CAP_SETUID`, `CAP_SETGID`, `CAP_CHOWN`, `CAP_DAC_OVERRIDE`, `CAP_FOWNER`,
`CAP_KILL`, and `CAP_SYS_CHROOT`, which Chrome's namespace sandbox needs, and
runs with no-new-privileges. The reference [`compose.yaml`](../compose.yaml)
sets exactly that set.

Each live session holds one browser user and one session user that no other
live session holds. Chrome keeps its sandbox: its renderer runs in its own
user and PID namespaces under a seccomp filter with no capabilities. A
target's user runs the container rootlessly; no target user holds sudo or a
root container daemon, and browserctl never calls a container engine's CLI
or socket from product code.

## Network confinement

browserctl does not confine the network access of the image's browser and
session users. A browser they run can reach any address the container can,
subject only to the host's own networking and to whatever the deployer
installs.

The deployer must refuse those users this host's addresses and every private
peer network, while leaving them the system resolver and the ports they need:
session users reach browserctl's own port, and browser users reach the
egress relay's port on its pinned addresses. The following reference rule
does that for one target; replace the placeholders with the target's
browser and session subordinate UID ranges, browserctl's port, and the
egress relay's pinned address and port, and extend the sets with the host's
IPv4 and IPv6 addresses and peer networks.

```nft
table inet browserctl-egress {
  chain output {
    type filter hook output priority 0; policy accept;
    # The system resolver remains reachable.
    meta skuid <browser-uid-range> udp dport 53 accept
    meta skuid <browser-uid-range> tcp dport 53 accept
    meta skuid <session-uid-range> udp dport 53 accept
    meta skuid <session-uid-range> tcp dport 53 accept
    # Session users reach browserctl itself.
    meta skuid <session-uid-range> ip daddr 127.0.0.1 tcp dport <port> accept
    # Browser users reach the egress relay on its pinned addresses.
    meta skuid <browser-uid-range> ip daddr <relay-address> tcp dport <relay-port> accept
    # Everything else to this host or a private peer network is refused.
    meta skuid <browser-uid-range> ip daddr { <host-address>, <private-peer-network> } drop
    meta skuid <browser-uid-range> ip6 daddr { <host-address-v6>, <private-peer-network-v6> } drop
    meta skuid <session-uid-range> ip daddr { <host-address>, <private-peer-network> } drop
    meta skuid <session-uid-range> ip6 daddr { <host-address-v6>, <private-peer-network-v6> } drop
  }
}
```

The rule belongs in its own root-owned nftables table, applied by a root
unit that the target user's manager requires, so a target cannot start
without it. When the per-session loopback proxy is enabled
(`BROWSERCTL_LOOPBACK_PROXY_PORT`), add one static accept rule allowing
`<browser-uid-range>` to reach `127.16.0.0/12` on that proxy port above the
drop rules; each managed agent session binds its own random address in
`127.16.0.0/12` and forwards only ports explicitly allowed by an authorized
client token, refusing any port in `BROWSERCTL_LOOPBACK_DENY_PORTS`. Task
runner processes (`<session-uid-range>`) keep no direct loopback access beyond
browserctl's own listener.
