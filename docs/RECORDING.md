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

By default in a Docker volume named `recordings`, mounted into the gateway and the application. Settings shows the
folder, free space and whether it is writable.

### On a network share (NFS or SMB)

The application cannot mount shares itself (it runs without privileges), so the share is a Docker volume that you
configure in `.env`. Fill in the three values before the first recording:

```
# NFS
EMREMOTE_RECORDINGS_TYPE=nfs
EMREMOTE_RECORDINGS_OPTIONS=addr=192.168.1.10,rw,nfsvers=4
EMREMOTE_RECORDINGS_DEVICE=:/export/emremote

# SMB / CIFS
EMREMOTE_RECORDINGS_TYPE=cifs
EMREMOTE_RECORDINGS_OPTIONS=addr=192.168.1.10,username=emremote,password=...,uid=1000,gid=1000,vers=3.0
EMREMOTE_RECORDINGS_DEVICE=//192.168.1.10/emremote
```

Then `docker compose up -d`. Docker keeps the settings of a volume that already exists, so to switch an existing
installation: stop it (`docker compose down`), copy the old recordings if you want to keep them, run
`docker volume rm <project>_recordings` (the project is usually `emremote`) and start again.

The gateway and the application run as user 1000, so the share must let uid 1000 write (for NFS set the export's
anonymous uid, for SMB use `uid=1000,gid=1000`). The SMB password sits in `.env`, which is already secret. The
share is mounted by the Docker host, not by emremote; if the share is down, recording fails and Settings says so.

Note: the NFS and SMB settings were checked only as far as Docker Compose turning them into volume options; no NFS or
SMB server was available for a real mount test. The Docker volume, the settings, retention and playback are what the
test suite covers (`tests/stack.sh smoke` and `tests/stack.sh recording`).

## Playback

Open **Recordings**, choose a session and press play; the slider seeks. Recordings are in the gateway's own format
(`.guac`); **Download** gives the raw file for use with Apache Guacamole tools (for example `guacenc` makes a video).
Backups made with `scripts/backup.sh` do not include recordings.
