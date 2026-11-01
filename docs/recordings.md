# Recordings

What does browserctl record, and how long does it keep it?

## What is recorded

The server records every agent session and every check session, whether its
browser is managed or leased from a provider, for as long as the session is
open. It never records a sign-in session or a browser it watches for
another owner.

A recording comes from the same screencast as the dashboard's live views:
the page viewport only, following the page in use. It is H.264 video in an
MP4 file at a steady 10 frames per second, with each frame fitted into
960 by 600 pixels. A page that does not paint repeats its last frame, so the
video runs as long as the session did. ffmpeg encodes it as the recorder
user, UID and GID 1090, which reads frames from the server and writes video
back to it with no file access of its own.

## Where recordings live

Recordings live in `BROWSERCTL_RECORDINGS_DIRECTORY`, which the server keeps
at mode 0700. Each session has `<session>.json`, describing its client,
purpose, source, and start and end times, and its video: `<session>.mp4`
once the session has ended, `<session>.mp4.part` while it is being written.
The video is a fragmented MP4, so a part file is playable up to its last
fragment; on startup the server finishes any part file a stopped server left
as it was written.

## Retention

On startup, every 10 minutes, and whenever a recording finishes, the server
deletes recordings that ended more than 7 days ago, then the oldest
recordings while the directory holds more than
`BROWSERCTL_RECORDINGS_CAP_BYTES`. Recordings still being written count
toward the cap but are never deleted.

## Playing recordings

The dashboard lists recordings by session, newest first, with their source,
client, times, and size, and plays a finished one in its focused view. The
video is served at `/dashboard/api/recordings/<session>/video` with byte
ranges, to dashboard sessions only.
