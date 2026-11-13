# Dashboard

How does the operator watch browsers, sign in to services, manage profiles,
and play recordings?

## Access

`node bin/browserctl.ts admin dashboard-link <name>` prints a link under
`BROWSERCTL_PUBLIC_BASE_URL` for a client that holds a token. The link works
once within 10 minutes. Opening it sets the `browserctl_dashboard` cookie,
`HttpOnly` and `SameSite=Strict` on `/dashboard`, and `Secure` when the
public base URL uses HTTPS; the dashboard session lasts 7 days. The server
keeps only each session's SHA-256 hash, in `dashboard-sessions.json` in the
state directory. Revoking the client's token ends its dashboard sessions and
closes their live views at once.

Every API request and WebSocket under `/dashboard` needs a dashboard
session. The server refuses a request that changes state, and every
WebSocket upgrade, unless its `Origin` is the public base URL's origin, so
open the dashboard at that URL. Actions are recorded in the audit log under
the dashboard session's client.

## Live views

The grid shows every live session and every browser that a provider reports
leased to another owner. Agent sessions, check sessions, and watched
browsers stream from Chrome's screencast of their page: the page viewport
only, without browser UI or desktop, as JPEG frames at most 1280 pixels
wide. Grid tiles update at about 5 frames per second, and a focused view
shows every frame Chrome sends, up to 60 per second. The view follows the
page a person or agent is using: a tab opened while watching takes the view
once it paints, and otherwise the shown page keeps it while it paints.

These views send nothing to the browser. Watching another owner's browser
takes no lease, and its screencast client sends only the commands a
screencast needs. Watching does not count as session activity, so it never
keeps an idle session open.

## Sign-in sessions

Signing in to a profile opens a sign-in session on a working copy of the
profile's current revision; a profile has at most one at a time. Its Chrome
runs headful on its own Xvfb display, without a window manager and without
any remote-debugging switch, as the session's browser user. x11vnc serves
the display only on a Unix socket in the session's directory, and the
server bridges that socket to the dashboard's noVNC view, the only view that
sends keyboard and pointer input. The display admits only clients holding
its cookie, and nothing of the session listens on TCP.

A sign-in session closes after the idle timeout without keyboard or
pointer input. Saving sends Chrome SIGINT, its graceful quit, which
writes the whole profile, and waits up to 30 seconds for it to exit,
then copies the working copy into a new revision, makes it current, and
records the dashboard's client; a Chrome that does not exit in time
fails the save and leaves the profile unchanged. A page that asks before
leaving holds Chrome open until the operator answers it in the display.
Discarding, or any other close, deletes the working copy without a
revision.

## Profiles, tasks, and providers

The dashboard creates a profile with an empty first revision, deletes a
profile no session uses, pins and unpins revisions, makes an earlier
revision current, and adds and removes services, each naming a saved check
task. Each service shows its last check, `signed_in` or `signed_out` with
its time and run, and can be checked at once. The dashboard lists tasks with
their revisions and source, the newest 200 runs with their status, client,
input, and output, and each provider's reachability and leased browsers.
It lists recordings by session and plays a finished one in the focused
view; [Recordings](recordings.md) says what is recorded and how long it is
kept.
