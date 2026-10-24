# Session recording

emremote can record the screen of remote sessions (SSH, Telnet, RDP, VNC) and play them back in the browser.
It is off until an administrator turns it on in **Settings > Session recording**.

## What is recorded

- What the screen shows, and the mouse. The gateway (guacd) writes it to a file as the session runs.
- **Not the keyboard.** Keystrokes are never recorded, so a password typed at a hidden prompt is not captured.
  Anything the remote computer *displays* is recorded, though: a password echoed on screen, a secret in a document or
  a terminal listing. Treat recordings as sensitive data.
- Sessions that are recorded show a red **REC** mark in the session toolbar, so nobody is recorded unknowingly.

## Who decides, who can watch

- Administrators choose in Settings: master switch, record every connection or only chosen devices, which protocols,
  per-device exceptions ("always" or "never"), how long to keep recordings and an optional size limit (the oldest
  recordings go first).
- **Recordings** (in the sidebar) lists them. Administrators see and can delete all of them; everyone else sees only the
  recordings of their own sessions. Viewing and downloading are written to the activity log.
- A recording of a shared (watched) session is the same single recording of that session.

## Where recordings are stored

The gateway always writes a recording to the `recordings` Docker volume on this server while the session runs. In
**Settings > Session recording > Where recordings are kept** you can also choose an **SMB share** or an **NFS share**:
when a recording is finished, emremote copies it to the share (and deletes the copy on this server unless you switch on
"Keep a copy on this server"). Playback, download and deletion work from the share. If the share is down, recordings stay
on this server and are copied when it answers again; Settings shows whether it answers and how many wait.

Nothing is mounted: emremote talks to the share with its own SMB and NFS clients, so the container needs no extra
privileges and no change in `compose.yaml` or `.env`. Fill in the form and press **Test connection** (saving also tests
it, and writes and deletes a small file).

| | SMB | NFS |
|---|---|---|
| Fields | file server, share name, optional folder, user name, password, domain | file server, export path, optional folder, user id and group id |
| Protocol | SMB 2 or 3 over port 445 | NFS version 3 over TCP (portmapper on port 111) |
| Server side | a user that may write to the share (empty user name means guest) | the export must allow this machine and non-privileged source ports (`insecure` in `/etc/exports`), and the user id must be allowed to write |

Good to know:

- The file server must be inside the **allowed target networks** (Settings), like every other target. Nothing is sent
  anywhere else.
- The share password is stored encrypted with `EMREMOTE_ENCRYPTION_KEY` alone (so copying works while nobody has signed in
  since the last restart) and is never shown again; leave the field empty to keep it. Anyone who has both the key and the
  database can read it.
- The first share setting applies to recordings made afterwards, and to recordings still on this server (they are copied
  too). Recordings already on a share stay there; if you point emremote at a different share, those recordings cannot
  be played from the new one.
- NFS version 4 only servers do not work; enable version 3 on the server. SMB servers that require signing or encryption
  were not tested.
- A share name or folder with other characters than letters, digits, space, dot, dash and underscore is refused.

Tested against Samba (SMB) and unfs3 (NFS version 3) in the test suite (`tests/stack.sh smoke`); not tested against
Windows, Synology, TrueNAS or a Linux kernel NFS server.

## Playback

Open **Recordings**, choose a session and press play; the slider seeks. Recordings are in the gateway's own format
(`.guac`). **Download** offers a **Video (MP4)**: the video is made in your browser tab (the recording is replayed
and encoded with the browser's video encoder, nothing is sent anywhere), so keep the tab open; a long recording takes a
while and the picture is capped at 1920 pixels wide. The video uses H.264, or VP9 inside the same MP4 when the browser
cannot encode H.264. Browsers without a video encoder only offer the raw file (`.guac`, for Apache Guacamole tools such as
`guacenc`). The MP4 path was tested with VP9 in Chromium; H.264 depends on your browser and was not tested.
Backups made with `scripts/backup.sh` do not include recordings.
