# Dashboard

How does the operator watch browsers, sign in to services, manage profiles,
and play recordings?

## Access

Open the server's public URL to reach `/dashboard/`. Select **Continue
with GitHub** and sign in as the configured owner. Browserctl matches
the numeric GitHub account ID and records dashboard actions as
`github:<id>` in the audit log.

Register a GitHub OAuth app with the server's public origin as its
homepage and `<public origin>/dashboard/login/callback` as its callback.
Use a separate app for each target. The
[input schema](../config/inputs.json) declares the required client ID,
owner ID, and protected client-secret file. Store the secret exactly as
issued. Browserctl requests no GitHub scopes and revokes the GitHub
access token after checking the account.

GitHub sign-in expires after 10 minutes and the callback works once in
the browser that started it. A successful sign-in sets an HttpOnly,
SameSite=Lax cookie scoped to `/dashboard`. The cookie is Secure when the
public URL uses HTTPS. Dashboard sessions last 7 days. The server stores
only the session token's SHA-256 hash alongside the owner ID and expiry.
Signing out ends the current session and closes its live views.

The same session authenticates dashboard API calls, live views, and
[recording playback](recordings.md#playing-recordings). State-changing
requests and WebSocket upgrades also require the public URL's Origin.
Agent client tokens are managed separately through the admin command.

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
