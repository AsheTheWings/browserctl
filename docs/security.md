# Security model

What does browserctl protect, what does it isolate, and what must the
deployer confine?

## Principals and credentials

A client is named and holds one token. The server stores only the token's
SHA-256 hash, in the state directory, and revoking it closes that client's
MCP connections, sessions, dashboard sessions, and live views at once. The
admin command reaches the server through a Unix socket in the state
directory that only the server's user can open.

An agent's MCP connection binds at most one session and reaches only the
sessions it opened. Session workers and task runs reach their session's
browser through a 256-bit capability URL, which no tool or signal exposes.
The relay answers 404 for a wrong or revoked capability, and the dashboard
checks its own session cookie and Origin before any state change or live
view.

The dashboard is the operator's surface. A dashboard link works once within
10 minutes; it sets an `HttpOnly`, `SameSite=Strict` cookie scoped to
`/dashboard`, stored as a hash in the state directory. Dashboard WebSockets
need that cookie and the public base URL's Origin. The dashboard sends input
only to sign-in sessions, through the display's own VNC bridge; it never
sends input to an agent or check session.

A sign-in session's Chrome runs headful on its own Xvfb display, without a
window manager and without a remote-debugging switch that a page could
reach. x11vnc listens only on a Unix socket in the session's 0700 directory,
and the server is the only client of it.

The model key never reaches a session worker or a task run: they call the
server's forwarder, which names the configured model and holds the key.
Playwright workers run as the session's user with an allowlist that excludes
running code and closing the browser.

Recordings hold page content, so the recordings directory is mode 0700 and
each video is served only to dashboard sessions. Telemetry carries no token,
capability URL, cookie, page content, task input or output, or model payload.

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
subordinate UID range and browserctl's port, and extend the set with the
host's IPv4 and IPv6 addresses and peer networks.

```nft
table inet browserctl-egress {
  chain output {
    type filter hook output priority 0; policy accept;
    # The system resolver remains reachable.
    meta skuid <uid-range-start>-<uid-range-end> udp dport 53 accept
    meta skuid <uid-range-start>-<uid-range-end> tcp dport 53 accept
    # Session users reach browserctl itself.
    meta skuid <uid-range-start>-<uid-range-end> ip daddr 127.0.0.1 tcp dport <port> accept
    # Browser users reach the egress relay's port here as well.
    # Everything else to this host or a private peer network is refused.
    meta skuid <uid-range-start>-<uid-range-end> ip daddr { <host-address>, <private-peer-network> } drop
    meta skuid <uid-range-start>-<uid-range-end> ip6 daddr { <host-address-v6>, <private-peer-network-v6> } drop
  }
}
```

The rule belongs in its own root-owned nftables table, applied by a root
unit that the target user's manager requires, so a target cannot start
without it.
