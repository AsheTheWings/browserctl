# Dashboard

How does the operator watch browsers, sign in to services, manage profiles,
and play recordings?

Editable text and placeholders use at least `0.875rem`. The note editor
uses `1rem` on narrow screens; its character counter is separate.

## Access

Open the server's public URL to reach `/dashboard/`. The server's profile
selects how the operator signs in. The same dashboard session authenticates
API calls, live views, and [recording playback](recordings.md#playing-recordings).
State-changing requests and WebSocket upgrades require the public URL's Origin.
Signing out ends the current session and closes its live views. Agent client
tokens are managed through the admin command.

### Development

Enter the shared development password on the sign-in page. Deliver it as
an owner-only file containing one line of 15 to 256 characters, with no
trailing newline. The [input schema](../config/inputs.json) declares the
file path input. After ten failed attempts in a minute, sign-in waits for
the next window. Use the development listener over a private network.
Development dashboard sessions last up to seven days and end on restart.
Audit records use the actor `dashboard:development`.

### Production

Use an HTTPS public origin. Select **Continue with GitHub** and sign in
as the configured owner. Browserctl matches the numeric GitHub account ID
and records dashboard actions as `github:<id>` in the audit log.

Register a GitHub OAuth app with the server's public origin as its
homepage and `<public origin>/dashboard/login/callback` as its callback.
The [input schema](../config/inputs.json) declares the required client ID,
owner ID, and protected client-secret file. Store the secret exactly as
issued. Browserctl requests no GitHub scopes and revokes the GitHub
access token after checking the account.

GitHub sign-in expires after 10 minutes and the callback works once in
the browser that started it. A successful sign-in sets a Secure, HttpOnly,
SameSite=Lax cookie scoped to `/dashboard` for seven days. The server stores
only the session token's SHA-256 hash alongside the owner ID and expiry.

## Navigation and appearance

Overview shows live browsers, active sessions, and recent recordings.
Profiles, Tasks, Recordings, and Providers each have a dedicated view.
On desktop, the page starts next to the icon rail. Hover over the rail or
move keyboard focus into it to reveal the labels over the page. Sidebar rows
stay in place as the rail expands. Theme and sign-out controls are in the
sidebar. The dashboard uses the system color scheme on page load or when
the system scheme changes. The theme button switches between light and
dark for the open page.
The Browserctl mark appears on the sign-in page, in the sidebar, and in the
browser tab.

The [dashboard source](../dashboard) uses React, shadcn/ui components,
and the bundled Poppins font. `npm run build:dashboard` builds the
browser assets for the server. The image bundles them with the app.

## Live views

The grid shows every live session and every browser that a provider reports
leased to another owner. Its page previews follow the foreground tab and
update at about 5 frames per second. The first frame after a tab switch
can appear immediately. Select a card to open its viewer, or use the
fullscreen button on the card or in the viewer to fill the screen. Press
Escape in either view or use the browser's fullscreen exit control to
return to the dashboard. Fullscreen shows only the browser view; if the
browser denies fullscreen, the expanded viewer stays open. The expanded
header shows the card's details. Select the session ID to copy it.

Open a managed agent's tile to watch its full Chrome window,
including tabs and the address bar, as read-only 1920 × 1080 video at
30 frames per second. The server encodes the private display as H.264
while the viewer is open and streams it as fragmented MP4. The viewer
shows a spinner and “Starting live video…” until playback begins.
The expanded viewer fits the video's 16:9 frame within the viewport.
Video playback requires H.264 support.

Focused views of check sessions and provider browsers show the page
viewport as JPEG frames at most 1280 pixels wide, up to 60 per second.
The view follows Chrome's reported foreground tab. If multiple pages are
visible or Chrome supplies no visibility information, the view favors
newly opened or painting pages.

Watching another owner's browser
takes no lease, and its screencast client sends only the commands a
screencast needs. Watching does not count as session activity, so it never
keeps an idle session open.

## Sign-in sessions

Select **Connect** on a profile to open its sign-in session directly. It
resumes any active sign-in session for that profile or starts a working
copy of the current revision. A profile has at most one sign-in session
at a time. Closing the viewer leaves the session open. Its Chrome
runs headful on its own 1920 × 1080 Xvfb display, without a window manager or
any remote-debugging switch, as the session's browser user. x11vnc serves
the display only on a Unix socket in the session's directory, and the
server bridges that socket to the dashboard's noVNC view. The viewer scales
the display to fit its 16:9 frame and requests JPEG quality 9 out of 9. This
view sends keyboard and pointer input. The display admits only clients
holding its cookie, and nothing of the session listens on TCP.

A sign-in session closes after the idle timeout without keyboard or
pointer input. Select **Save** in the expanded viewer to create a revision
or **Discard** to close without saving. Saving sends Chrome SIGINT, its
graceful quit, which writes the whole profile, and waits up to 30 seconds for it to exit,
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
input, and output, and each provider's reachability and watchable legacy leases.
It lists recordings by session and plays a finished one in the focused
view, which keeps its size while the video loads. [Recordings](recordings.md)
says what is recorded and how long it is kept.

The Profiles page defaults to the managed provider. Select another
[management-capable provider](lease-protocol.md#profile-management-discovery)
to create or delete its profiles, inspect retained revisions, pin revisions,
or choose a current revision. These operations use that provider's own store.
Select **Connect** to open a provider profile in an interactive page editor.
Use its address field to navigate. The editor streams the page, not the
provider desktop, Chrome toolbar, or native dialogs. **Save** closes the
browser and saves a new provider revision. **Discard**, closing the editor,
or losing its connection discards the working copy.

Each managed profile card has **Revisions**, **Notes**, and **Sign-in checks** tabs.
Only **Revisions** can grow the card. **Notes** and **Sign-in checks** scroll
within the card when their content needs more room.
The **Notes** tab shows an operator note and an agent note. The panes sit
side by side on wide screens and stack on narrow screens. New and updated
notes accept up to 240 Unicode characters of plain text. The editor refuses
input over the limit and lets you shorten a saved note that exceeds it.
Both notes show the server-assigned client and last update.
The dashboard edits the operator note and can clear either
note. Clearing the agent note lets another authorized MCP client claim it.
Notes are independent of browser revisions and visible to authenticated MCP
clients. Keep secrets out of them. Notes describe intended use, not
instructions or verified sign-in state.
