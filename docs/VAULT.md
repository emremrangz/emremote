# Vault (privileged access)

The **Vault** (sidebar) keeps the sign-ins, SSH keys, API tokens and secure notes that give access to
your servers and network equipment. Connections can sign in with a vault entry without anyone seeing
the password. When a person does need to see it, they give a reason and the activity log records it.

It covers the core of what privileged access management (PAM) products do: shared accounts, check-out
with a time limit, approval, emergency access, password rotation, history and an audit trail.

## Entries

| Kind | Holds |
|---|---|
| **Sign-in** | username, domain, password, optional SSH key, note and one-time code secret |
| **SSH key** | private key and passphrase |
| **API token** | a token |
| **Secure note** | text such as recovery codes, PINs or licence keys |

Every entry has a name, a folder (for example `Network/Core`), tags, a web address and a description.
These are not secret and are visible to everyone who can see the entry. The secret fields are encrypted
with the vault key (see [SECURITY.md](SECURITY.md)).

- **Generate** fills in a password that follows the vault policy (**Settings → Access → Vault passwords**:
  length, character kinds, leave out look-alikes). Generated passwords never contain quotes, spaces,
  colons or backslashes, so they survive shells, `chpasswd`, RDP and terminal paste.
- **One-time code secret:** paste the base32 secret or the `otpauth://` link of a two-factor sign-in.
  The vault then shows the current 6-digit code. The secret itself is never shown again.
- **Editing** an entry changes only the secret fields you type in; the others stay as they are.

## Showing and copying

**Show** asks for a reason on shared entries (for example a ticket number), then shows the values for 30
seconds with copy buttons. The activity log records who, when, why and which fields, never the values.

An entry can be **connect only**: its secret is never shown, not even to administrators, and is only
handed to the gateway when someone connects. Saved credentials from before the vault existed start as
connect only, because they were promised to be write-only; an administrator can change that per entry.

## Who sees what

- Administrators manage every **shared** entry.
- Members manage their own **private** entries (with the "Save credentials" permission), which nobody
  else sees.
- Administrators share an entry with members or teams (entry → Details → **Shared with**):
  **Use** (check out and connect without seeing the secret) or **Use and show**.

## Check-out and approval

Shared entries have an access policy:

| Policy | Meaning |
|---|---|
| **Open** | Everyone given access uses the entry at any time. |
| **Check-out** | One person at a time checks the entry out, with a reason, for at most the entry's longest check-out time (5 minutes to 24 hours). |
| **Approval** | Like check-out, but members first **request** access (reason and time). Another administrator approves or rejects it under **Vault → Requests**. The approval has to be used within the time set in the vault policy (8 hours by default); a request nobody decides within a day expires. Administrators check out directly. |

While an entry needs a check-out, **connecting with it** (remote sessions, files, system information,
server-to-server copies) is refused for everyone who does not hold it, administrators included. This
keeps one person on a shared account at a time.

When the time runs out the entry is checked in automatically. At every check-in, the holder's remote
sessions that use the entry are ended. An administrator can force a check-in.

**Break-glass** is for emergencies when nobody can approve in time: a member checks out an approval entry
without approval, with a reason of at least 10 characters. It is flagged in the list and in the activity
log as `vault.break_glass`. It can be switched off per entry.

## Password rotation

A sign-in entry can have its password changed on the server by emremote:

1. Edit the entry and choose **Change the password on**: an SSH connection to the Linux or Unix computer
   that has the account. The username of the entry must be that account.
2. Choose how often (**Change the password**: every 7 to 365 days), and for check-out entries whether to
   **change after every check-in**, so the password someone saw stops working when they give it back.
3. **Change password now** in the entry's details runs it at once.

How it changes the password:

- If the connection signs in as the account itself (typically because it uses this entry), emremote
  runs `passwd` as that account and answers its prompts with the old and the new password.
- Otherwise it signs in with the connection's own login and sets the password with `chpasswd`, as root
  or through `sudo -S` (the login's password is given to sudo). The login needs permission to run
  `chpasswd` through sudo, for example `opsuser ALL=(root) /usr/sbin/chpasswd` in `/etc/sudoers.d/`.

Afterwards emremote signs in with the new password to confirm it ("unverified" if that sign-in is not
possible, for example when the account may not use SSH). Connections that use the entry use the new
password at once.

Safety:

- Only fixed commands run (`id -u`, `chpasswd`, `passwd`); the account name and the password go to stdin
  or the terminal, never into a command line.
- The new password is saved in the entry's history **before** the server is changed. If the connection
  breaks in the middle, the history keeps it as a "rotation attempt" and **Make current** puts it back.
- Rotation does not run while the entry is checked out (except the one after check-in), while the vault
  is locked after a restart, or through jump hosts.
- A failed scheduled rotation is retried an hour later and listed under **Health**.

Not covered: Windows accounts, network equipment, databases and cloud accounts. Their entries can still
remind you (**Remind me to change it**) and are marked as overdue.

## History

Every saved, rotated or restored value is kept (the last 20). Administrators of an entry can show an
older value, with a reason, or make it current again. Making an older value current changes only the
vault, not the server.

## Health

**Vault → Health** checks the entries you manage: weak passwords, passwords used by several entries,
entries older than their change interval (or a year without one), failed rotations and entries without
a secret. Passwords are compared in memory on the server; the report holds only entry names.

## Limits

- Rotation is Linux and Unix only. It was tested against OpenSSH on Alpine Linux with the shadow
  `passwd` and with `chpasswd` through sudo; `chpasswd` as root and other systems' `passwd` prompts
  (Debian, RHEL, BusyBox) are handled but were not tested on real machines.
- There are no e-mail or chat notifications: administrators see waiting requests as a count next to
  **Vault** in the sidebar.
- A secret someone has seen stays known to them until it is rotated.
- The vault separates users in the application. Knowing one user's sign-in password plus `.env` and the
  database decrypts every entry, as described in [SECURITY.md](SECURITY.md).
