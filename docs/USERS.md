# Users, teams and shared access

emremote supports several accounts. Administrators manage everything; members use what they are
given and can keep a private inventory of their own. Everything is managed on one screen: **Users**
(sidebar, Administration).

## Concepts

- **Shared inventory.** The devices, groups and saved credentials that existed before multi-user and
  everything an administrator adds.
- **Private inventory.** What a member adds themselves. Nobody else, administrators included, can
  see, open or change it. A new member's private inventory starts empty.
- **Administrator.** Sees and manages the whole shared inventory and all users. Administrators do not
  have a private inventory: what they add is shared.
- **Member.** Sees their own inventory plus the part of the shared inventory they were given.
- **Team.** A named bundle of permissions and shared-inventory access. A user's effective access is
  their own settings plus their team's.

## What a member can reach in the shared inventory

| Setting | Meaning |
|---|---|
| **Own inventory only** | Nothing shared. Starts empty and builds their own. |
| **Everything shared** | Every shared device and group, including ones added later. |
| **Selected devices and groups** | Only the ticked devices and groups. Ticking a group includes every device in it. |

Shared devices are used, not owned: members cannot edit or delete them, change their connection
methods or see their saved passwords. They can connect (with the saved password, which is never
shown), pick a keyboard layout, and mark them as personal favorites.

## Permissions

| Permission | Allows |
|---|---|
| Open remote sessions | RDP, VNC, SSH and Telnet sessions to devices they can see |
| Files and system info | File manager, RDP transfer drive, copying between servers, system overview |
| Quick connect | Connect to a host that is in no inventory (network policy still applies) |
| Manage own devices | Add, edit and delete their own devices, groups and connection methods |
| Save credentials | Keep their own saved logins, usable only on their own devices |

A member cannot use a shared credential on their own devices: that would let them point an
administrator's password at a host they control.

## Everyday tasks

- **Add a person:** Users → New user. Choose a username and a password (Generate makes a strong one),
  a team, what they can reach and their permissions. They can change the password under Settings.
- **Give a team access:** Users → New team, tick what it may do and which shared devices it reaches,
  then pick the team when creating or editing users. Editing a team updates every member.
- **Change access:** Edit the user or team. Changes apply at once and the person's running remote
  sessions are closed so the new access takes effect. They stay signed in.
- **Reset a password:** the user's menu → Reset password. They are signed out everywhere. Their saved
  connection passwords keep working.
- **Disable an account:** the user's menu → Disable account. They are signed out and cannot sign in;
  nothing is deleted.
- **Delete a user:** choose whether their devices, groups and credentials move to the shared
  inventory or are deleted with them.
- **See what people did:** administrators see all activity under Activity log; members see their own.

At least one active administrator must always exist, and you cannot disable, demote or delete your
own account.

## Two-factor authentication

Everyone can turn on an authenticator-app code under **Settings → Two-factor authentication**: scan
the QR code with Google Authenticator, Aegis, 1Password or similar, confirm with a code, and keep the
10 recovery codes (each works once, shown only at that moment). After that, signing in asks for the
code on a second line of the login screen; a recovery code can be typed instead.

- Turning it off, or renewing the recovery codes, needs the password and a current code.
- A code works once, so signing in twice within the same 30 seconds needs the next code.
- **Lost phone and recovery codes:** an administrator opens the user's menu → **Reset two-factor**
  (the user is signed out and signs in with the password only), or on the host run
  `docker compose exec emremote /app/emremote reset-password <user>`, which also turns it off.
- Administrators can see in the Users list who has it on. Two-factor protects the sign-in; it does
  not change what a user may do.

## How saved passwords work with several users

Saved connection passwords are encrypted with one data key. Each user holds their own copy of that
key, protected by their own sign-in password (and `EMREMOTE_ENCRYPTION_KEY`). That is why a new user's
password is set by an administrator while signed in, and why an administrator password reset keeps
saved passwords working. The key is unlocked in memory when someone signs in, so after a restart any
user can sign in first. See [SECURITY.md](SECURITY.md) for the trade-offs.

## Upgrading

The upgrade keeps everything: existing devices, groups and credentials become the shared inventory
and your account stays the administrator. Favorites and "last opened" times become personal. Take a
backup first (`scripts/backup.sh`).
