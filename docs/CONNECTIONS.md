# Preparing target computers and configuring connections

emremote installs nothing on target computers. It connects to remote-access services that the
operating system already provides, or that you enable. The emremote host must be able to reach the
service port; check the target's firewall.

| OS | Graphical | Terminal |
|---|---|---|
| Windows 10/11 Pro, Enterprise, Education; Windows Server | **RDP** (built in) | SSH (OpenSSH Server, optional feature) |
| Windows Home | No built-in RDP server. Use a third-party VNC server (TightVNC, UltraVNC). | SSH |
| macOS | **VNC** via Screen Sharing | SSH via Remote Login |
| Linux | RDP via `xrdp` (recommended) or VNC (TigerVNC, x11vnc) | **SSH** |

## Windows: Remote Desktop (RDP)

1. Settings → System → **Remote Desktop** → On. Keep "Require devices to use Network Level
   Authentication" enabled.
2. Allow the user under "Remote Desktop users". Administrators are allowed by default.
3. Firewall: enabling Remote Desktop opens TCP 3389 for the private network profile. Make sure the
   network is marked **Private**, or add a rule.
4. Credentials:
   - **Local accounts:** the username and password.
   - **Microsoft accounts:** the e-mail address and the account **password**, not the PIN.
   - If "For improved security, only allow Windows Hello sign-in" is enabled (Settings → Accounts →
     Sign-in options), password sign-in over RDP fails. Turn that option off, or use a local
     account.
   - **Domain accounts:** username plus the **Domain** field (or `DOMAIN\user` in the username).

### Server certificate (automatic)

Windows uses a self-signed certificate for RDP. You do not need to do anything: on the **first
connection** emremote records the certificate (trust on first use) and refuses the connection if it
later changes. To check it once by hand (optional, for critical machines):

1. In emremote, open the device and click **Verify certificate** next to the RDP method (or **Settings → Security**), then **Fetch certificate**.
2. Compare the SHA-256 fingerprint with the one on the PC. In PowerShell on the Windows machine:

   ```powershell
   $t = (Get-CimInstance -Namespace root/cimv2/TerminalServices -ClassName Win32_TSGeneralSetting).SSLCertificateSHA1Hash
   $c = Get-Item "Cert:\LocalMachine\Remote Desktop\$t"
   ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData))).Replace('-',':').ToLower()
   ```

3. If they match, click **Trust this certificate**, then **Save changes**. The security mode switches
   to the negotiated TLS or NLA mode, because a pinned certificate cannot protect legacy RDP
   encryption, which presents no certificate at all.

Windows renews the self-signed certificate about once a year. When that happens, connections fail
with "SSL/TLS connection failed (untrusted/self-signed certificate?)". Open the connection's
**Settings → Security**, then **Fetch certificate** and **Trust this certificate**. Several
fingerprints, comma-separated, are also accepted.

### Display and quality

- **Resolution** follows your browser window. With the default *Resize remote desktop live*
  (display-update) this works on Windows 8.1 / Server 2012 R2 and later. Choose *Reconnect at the new
  size* for older systems.
- **HiDPI screens:** by default guacd keeps the remote desktop at a normal (96 DPI) logical size, so
  icons and text have their usual size. That looks slightly soft on a high-DPI screen. Session
  toolbar → Display → **Native pixel density** runs the remote desktop at your screen's full pixel
  resolution instead: sharpest text, but the remote UI looks small. Raise Windows' display scaling
  (e.g. 200%) to compensate.
- **Presets:**
  - *Best quality*: lossless encoding, 32-bit color and desktop effects.
  - *Balanced* (default): 32-bit color with adaptive lossy compression for photos and video, plus
    ClearType.
  - *Low bandwidth*: 16-bit color and no effects.
- **Keyboard layout** is detected automatically from your computer (for example Turkish Q) and
  given to the remote computer. Set a fixed layout only if the remote computer uses a different one.
- **Session toolbar:** a floating bar that can be dragged, collapsed to a small pill, or hidden
  completely. To bring a hidden bar back, point at the top edge of the screen, or press
  **Ctrl+Alt+Shift+T**. It has zoom and fit,
  Ctrl+Alt+Del, Win+L and Win, modifier keys that stay held for the next key, navigation and arrow
  keys, files, clipboard, display settings and fullscreen. The remote desktop always fills the
  whole window. **Display → Match my monitor** sizes it to your monitor even in a smaller window, and
  fullscreen resizes it to the monitor automatically.
- **Audio** from the remote computer plays in the browser once you have interacted with the page.

## macOS: Screen Sharing (VNC) and Remote Login (SSH)

1. System Settings → General → **Sharing**:
   - **Screen Sharing** → On. Click (i) and enable **"VNC viewers may control screen with
     password"**, then set a VNC password (at most 8 characters, a limitation of the VNC protocol).
   - **Remote Login** → On, for SSH.
2. In emremote, add a **VNC** connection on port 5900 with that password. Leave the username empty.
3. If the Mac is asleep, the session waits until it wakes. "Wake for network access" helps.

VNC to macOS is noticeably slower and less sharp than RDP to Windows; this is inherent to Apple's
VNC compatibility mode. The remote resolution is the Mac's own resolution, and emremote scales it to
your browser window.

## Linux

### SSH

`sudo apt install openssh-server` (Debian/Ubuntu) or your distribution's equivalent. Password
authentication must be allowed (`PasswordAuthentication yes`) unless you use a private key. Keys are
supported: paste the private key into the connection, optionally with its passphrase.

### RDP with xrdp

```bash
sudo apt install xrdp
sudo adduser xrdp ssl-cert       # lets xrdp read its TLS key (Debian/Ubuntu)
sudo systemctl enable --now xrdp
```

xrdp starts a separate desktop session per user. On Ubuntu with GNOME, sign the user out locally
first, or use a lighter desktop such as XFCE. Make sure xrdp has a TLS certificate
(`certificate=` and `key_file=` in `/etc/xrdp/xrdp.ini`; Debian generates one). Without it, xrdp
falls back to legacy RDP encryption, which offers no server identity to pin.

### VNC

Use TigerVNC (`tigervnc-standalone-server`) for virtual desktops, or `x11vnc` to share the physical
display. Always set a VNC password (`vncpasswd`). VNC traffic itself is not encrypted, so use it only
on networks you trust, or tunnel it.

## Copy and paste

- **Paste from your computer:** press **Ctrl+V** (⌘V on a Mac, or Shift+Insert) in the session. The
  browser hands the text to emremote with that key press, so no permission is needed. emremote puts
  it on the remote clipboard and then sends the remote side's own paste shortcut: Ctrl+V on
  Windows and Linux, ⌘V on macOS, and Ctrl+Shift+V in SSH/Telnet terminals.
- **SSH and Telnet terminals:** selecting text with the mouse copies it. A right click while text is selected only
  copies (and clears the selection); a right click with nothing selected pastes. This is how PuTTY and Windows
  Terminal behave, and it stops a copied command from being typed into the shell again.
- **Right-click → Paste** on the remote side uses the remote clipboard, which holds whatever you last
  pasted or copied. In Chrome and Edge, emremote also refreshes it from your computer when you
  right-click; the browser asks once whether the site may see the clipboard, and after that it is
  silent. Firefox and Safari never allow this, so there right-click pastes the text from your last
  Ctrl+V.
- **Copy on the remote side** (Ctrl+C in Windows, or selecting text in a terminal) and it is on your
  computer's clipboard. If the browser refuses at that moment, it is written on your next key press
  or click.
- **On a Mac**, ⌘C, ⌘V, ⌘A, ⌘Z and other ⌘ shortcuts become Ctrl shortcuts on Windows and Linux.
- **Where paste cannot work** (Windows sign-in screen, BIOS, some VNC servers), open the clipboard
  panel, put the text in the lower box and press **Type it**: emremote types it key by key.

## Session toolbar

The toolbar adapts to the target: Windows targets get Ctrl+Alt+Del, Win and Windows shortcuts
(Task Manager, Lock, Run, …); macOS gets ⌘, ⌥, Spotlight, app switching and Force Quit; Linux
desktops get Super and desktop shortcuts; SSH and Telnet get terminal keys (Ctrl+C, Ctrl+D, Ctrl+Z,
Ctrl+L, Ctrl+R) and no zoom. The display menu (resolution, pixel density, keyboard layout) appears
only for RDP. Set the device's operating system correctly so the right keys appear.

## SSH key files

In a connection's **Sign-in** tab, or in a saved credential, choose **Choose file…** (or drop the file) to
use an SSH private key instead of a password: `.pem` files, `id_rsa`, `id_ecdsa`, `id_ed25519`, `.key`,
in OpenSSH or PEM format (RSA, ECDSA and Ed25519). You can also paste the key text.

- The key is sent to the server once and stored **encrypted, exactly like passwords** (with a key
  derived from your sign-in password and the server key). The interface and API never show it again;
  you can only replace or remove it.
- A key that is protected by a passphrase needs the passphrase when you save it, so a wrong one is
  caught at once. The passphrase is stored encrypted too.
- The `.pub` file is the public half and is refused with an explanation. PuTTY `.ppk` files are not
  supported: in PuTTYgen choose **Conversions, then Export OpenSSH key**. Encrypted PKCS#8 keys
  (`BEGIN ENCRYPTED PRIVATE KEY`) are not supported; convert with `ssh-keygen -p -m PEM -f <file>`.
- Put the public key in `~/.ssh/authorized_keys` on the target, as with any SSH client.

## The workspace: tabs and split panes

Clicking **Connect** anywhere (Overview, Devices, search, Quick connect) opens the **workspace** window
and adds the session as a tab. Later connects add tabs to the same window instead of opening more.

- **Layouts** (buttons at the top right): one session, two side by side, two stacked, or four panes.
  Switching to a layout with more panes fills the empty ones with sessions that were hidden.
- **Panes and tabs.** Click a tab to show its session in the active pane (outlined when there is
  more than one pane). Click an empty pane, then a tab, to place a session there. `+` opens a new
  session; Quick connect is in that dialog too. Middle-click or the × closes a session and ends it.
- **Keyboard.** Keys, paste and the toolbar shortcut go only to the active pane. Clicking in a pane
  makes it active. Each pane has its own toolbar, file/snippet/clipboard panels and resolution.
- **Hidden sessions stay connected** (up to 8 at a time). Closing the window ends all of them, and
  the browser asks first while sessions are open.
- **Own window.** The arrow on a tab moves that session to its own window. A session address
  `/connect/<id>` still opens one session alone.
- If the browser blocks the pop-up, the session opens in the current tab instead (allow pop-ups for
  emremote to get the separate workspace window).

## Images and files in an RDP session

The remote clipboard that RDP and the gateway share carries **text only**, so a picture or file cannot
be pasted into Windows the way text can. emremote does the next best thing with the session's
**transfer drive**. Inside Windows it is the network location `\\tsclient\emremote` (type that into File Explorer's address bar; it is also listed under This PC → Network locations as "emremote on …", not under Local Disk):

- **Paste** an image or file (Ctrl+V with one on your clipboard) or **drag files onto the session
  window**. They are uploaded to the `from-browser` folder of the drive, and a message names the
  path to open in Windows (press F5 in that folder if it was already open). Pasted pictures are named `pasted-image-<date and time>.png`.
- To get something **out of Windows**, copy it to the `emremote` drive in File Explorer; it appears in
  the Files panel of the session (the folder icon in the toolbar), where you can download it.
- This needs the **Transfer drive** switch (Advanced tab) and does not work in view-only
  connections or Quick connect sessions. Large files are limited by `EMREMOTE_MAX_UPLOAD_MB`.

## Sharing a live session (view only)

Click the share icon in a session's toolbar, then **Create a view-only link**. Anyone who is signed in
to emremote and allowed to open sessions can watch that one session through the link. They see the
screen exactly as you do; their keyboard, mouse and clipboard never reach the remote computer (the
gateway joins them read-only, and emremote drops any input they send as well).

- The link stops working when you press **Stop sharing**, after two hours, or when the session ends.
  Stopping also disconnects everyone watching.
- Up to five people can watch one session. The dialog shows how many are watching right now.
- Only the owner of a session (or an administrator) can share it.
- The audit log records when a session was shared, who watched and for how long.
- Viewers see everything on the screen, including any secret typed into a visible field. Share
  only with people who may see what you are about to do.

## Quick view

**Connect** opens the session in the workspace window (tabs and split panes). For a quick look or a short
command you can stay on the page instead: the **Quick view** button next to Connect, and the "View here, on
this page" entries of the Connect menu, open the session in a large window over the current page.
Keyboard, clipboard and the toolbar work as in the workspace. Closing the window ends the session, and
**Open in window** reopens the session in the workspace. Escape is sent to the remote computer.

## Wake-on-LAN

Give a device its **MAC address** (Edit device, More details) and a **Wake** button appears on its
page. emremote sends the magic packet to the device's address and to the broadcast address of its
network (the `.255` of its /24 unless you enter another one). The address is also filled in
automatically the first time emremote reads the device over SSH.

- Wake only appears for physical computers; virtual machines and containers (for example Proxmox LXC) have no network card to wake.
- The device must be set up for it (BIOS/UEFI "Wake on LAN" and the network card's wake setting).
- emremote runs in a Docker network, so delivery of the broadcast depends on your host and router.
  If the device does not wake, enter its network's broadcast address explicitly, or make sure the
  host forwards directed broadcasts to the LAN.
- Packets only go to addresses inside `EMREMOTE_ALLOWED_TARGET_NETWORKS`. Waking is audited and
  limited to one request per device every five seconds.

## RDP extras

In a connection's **Advanced** tab (RDP):

- **Printing** adds a printer named "emremote" in Windows. Whatever you print is downloaded by the
  browser as a PDF.
- **Microphone** sends your microphone to the remote computer (the browser asks for permission).
- **Single application (RemoteApp)** opens one program in its own window instead of the desktop.
  The server decides what it allows: a Windows Server RemoteApp or a program alias such as `||notepad`.
- **Hyper-V virtual machine** connects to a VM console on a Hyper-V host through its VMConnect
  service: set security to **Hyper-V VMConnect**, port 2179, and enter the VM's name or id. This works
  even before Windows has started inside the VM.

## SSH extras

The connection's **Terminal** tab has a **Backspace key sends** choice (DEL or BS, for servers where
Backspace prints `^H`) and a **Locale** (for example `en_US.UTF-8`).

## Jump hosts (bastions)

Some devices live on a network that only one machine can see, for example an SSH server in a DMZ.
With a jump host, emremote signs in to that machine over SSH and reaches the device from there. It
works for RDP, VNC, SSH and Telnet, and for the file manager and system overview of SSH
connections.

**Turn it on (administrator).** Set `EMREMOTE_JUMP_TARGET_NETWORKS` in `.env` to the networks that lie
behind bastions, for example `192.168.50.0/24`, then `docker compose up -d`. It is empty by default,
which keeps the feature off. These networks are separate from `EMREMOTE_ALLOWED_TARGET_NETWORKS`:
they are only valid as jump targets, and loopback, link-local and denied ranges never are.

**Use it.** Add the bastion first as an ordinary device with an SSH method and a saved sign-in. Then
open the connection of the device behind it: **Advanced → Connect through a jump host**.

- The device behind the bastion must be entered by **IP address**, inside the jump target networks.
- The bastion's SSH server must allow TCP forwarding (`AllowTcpForwarding yes` in `sshd_config`, the OpenSSH default) and be able to reach the device.
- The bastion must be an ordinary allowed target with a **saved** username and password or key (it
  cannot be asked at connect time). Its host key is recorded on first use and pinned like any other.
- The device's own SSH host key or RDP certificate is recorded on first use through the tunnel.
- A jump host cannot use another jump host. A connection that is in use as a jump host cannot be
  deleted, and a device cannot be moved out of the jump networks while it uses one.
- A member can only use a bastion that has the same owner as their device, so a shared bastion
  cannot be aimed at hosts of their own choosing. Shared devices that use it work for everyone who
  may open them.
- Reachability is not probed for these connections (emremote cannot see the device). The session
  itself tells you if it is down.
- The audit log names the jump host for every session. Quick connect and exports do not carry jump
  host settings.

Each session gets a temporary listener on the private network shared with the gateway. It accepts
only the gateway, lives as long as the session and is closed with it (or after 45 seconds if the
session never starts).

## Terminal appearance (SSH and Telnet)

The palette button in the session toolbar changes the color theme (Gray, White, Green and Black on
white, Solarized Dark and Light, Dracula, Nord, One Dark, Tomorrow Night), the font (DejaVu Sans Mono,
Liberation Mono or Terminus, the monospace fonts installed in the gateway) and the text size. The
session reconnects, because the gateway draws the terminal. The choice is saved in your browser and
applies to all your SSH and Telnet sessions, including shared connections you cannot edit. A
connection's own Terminal settings (Edit connection → Terminal) are the default for everyone who has
made no choice.

## Command snippets

The braces button in an SSH or Telnet session opens **Snippets**: named pieces of text, private to
your account, that are typed into the session as if you had typed them.

- **Type** puts the text on the command line without pressing Enter; **Run** also presses Enter.
- Snippets with several lines ask for confirmation first, because each line runs as it is typed.
- Search by name, text or category. Snippets you used last are listed under **Recent**; that is the
  only history. emremote does not record what you type, so passwords entered at prompts are never
  captured.
- Up to 500 snippets per user; they are deleted with the account.

## Importing and exporting devices

**Devices → Import / Export.**

- **Export** writes what you can see as JSON (with groups, tags and connection methods) or CSV (one
  row per method). Passwords, keys and saved credentials are never included. Names that start with
  `=`, `+`, `-` or `@` get a leading apostrophe so spreadsheets do not run them as formulas.
- **Import** accepts an emremote JSON export, an OpenSSH config (`Host`, `HostName`, `Port`, `User`;
  wildcard hosts, `Match` blocks and `ProxyJump` are skipped with a note) or a CSV with the columns
  `name`, `address` (required) and optionally `hostname`, `os`, `device_type`, `protocol`, `port`,
  `username`, `domain`, `group`, `tags` (separated by `;`), `description`. Rows with the same name and
  address become one device with several methods.
- A preview lists what is new, what already exists (same name and address) and what is invalid. Existing
  devices can be skipped or imported again under a new name. Invalid rows are never imported.
- Imports land in your own scope: administrators add to the shared inventory, members to their private
  inventory. Add passwords afterwards. At most 2000 devices and 4 MB per import.

## Old switches and routers (legacy algorithms)

Browser terminals run inside guacd, which already speaks older SSH dialects. emremote's own SSH client
(file manager, system overview, jump host, host key lookup) only offers modern algorithms by default. For
equipment that still needs `diffie-hellman-group1-sha1`, CBC ciphers, `hmac-sha1` or `ssh-dss`, switch on
**Allow legacy algorithms** in the SSH connection's Host key tab. Modern algorithms are still tried first,
and the host key stays pinned. Use it only for devices you cannot update.

## SSH host keys (automatic)

As with any SSH client, the host key is recorded automatically on the first connection, and a
changed key is refused. After reinstalling a server, accept the new key under **Settings → Host key**.
To compare it by hand:

On the device page, click **Verify host key** next to the SSH method (or **Settings → Host key**), then **Fetch host key**. Compare the fingerprint with the
server:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub     # or ssh_host_ed25519_key.pub / ssh_host_rsa_key.pub
```

emremote asks for the key type that the gateway's SSH library prefers (ECDSA, then Ed25519, then
RSA), so the pinned key is the one the gateway will be shown. Without a pin, guacd does **not**
verify the host. The UI flags such connections as "Host key not verified".

## Switches and routers (Network devices)

Choose **Network** as the kind in Add device. Use SSH where the device has it (Telnet below otherwise).
With a saved SSH sign-in, emremote reads the vendor, firmware, model, serial number, uptime, CPU and
memory and shows them on the device page with the vendor's logo. It runs a few fixed, read-only
`show` commands (nothing you type is ever sent) and recognises Cisco IOS, IOS XE and NX-OS, Juniper
Junos, MikroTik RouterOS, Huawei VRP and HPE/Aruba ProCurve and AOS-CX. Other brands connect as usual
but show no details. There is no Files tab for network devices. The commands are checked against
sample output of each vendor; if a model prints something different, details may be partly empty.
For old equipment see "legacy algorithms" above.

## Network devices (Telnet)

Switches, routers, printers and UPS cards often offer only Telnet. emremote supports it, but Telnet
is **not encrypted**: the username, the password and everything you type cross the network in plain
text. It is marked "Unencrypted" everywhere in the UI. Prefer SSH whenever the device supports it,
and use Telnet only on a trusted management network.

- Add the device with type **Network device**, choose the **Telnet** method (port 23) and, if you
  like, a saved credential.
- With a saved username and password, emremote signs in automatically at the usual `login:` and
  `password:` prompts. For unusual prompts, set the patterns under Settings → Advanced →
  Automatic sign-in (regular expressions).
- If Backspace prints `^H` or `^?`, switch "Backspace key sends" under Settings → Terminal.
- Files and the system overview are not available over Telnet.

## Files (SFTP) and system overview

Both features use an **SSH** connection method of the device. You usually do not need to add one
yourself: when a device has only RDP or VNC, opening its System or Files tab makes emremote look for
the computer's built-in SSH server (port `EMREMOTE_AUTO_SSH_PORT`, default 22). If the server
answers and accepts the sign-in already saved for RDP/VNC, an SSH method is added automatically.

**Windows:** OpenSSH Server is part of Windows (an optional feature, not an agent). Turn it on once
in an administrator PowerShell:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Set-Service -Name sshd -StartupType Automatic; Start-Service sshd
```

This also opens the firewall rule for port 22. Then click **Check again** on the device's System or
Files tab. emremote connects with the RDP username (prefixed with the domain, if one is set) and the
saved password.

**Without SSH (RDP only): the transfer drive.** Every RDP session gets a redirected drive named
**emremote** (File Explorer → This PC). In emremote it is the "RDP transfer drive" on the device's
Files tab and in the RDP session window (**Files** button). Upload files there to open them in
Windows, or copy files to that drive in Windows to download them. Files persist per device in
`data/transfer/<device-id>` on the emremote host. It can be turned off per connection (RDP
Settings → Advanced → Transfer drive). It does not give access to the rest of the Windows disk;
that needs SSH.

**Hidden files:** files and folders whose names start with a dot are always shown.

- **Files:** the device page's **Files** tab, or the **Files** button in an SSH session window. You
  can browse, upload (drag and drop works), download (folders download as .zip), rename, create
  folders and delete. Deleting a folder removes everything inside it, after you confirm.
- **System:** the device page's **System** tab shows CPU, memory, swap, storage, uptime, the top
  processes and recent warning/error log lines. Turn on "Every 30 s" to refresh automatically.

Requirements:

1. Nothing to set up: the host key is recorded automatically the first time. If it later changes,
   access is refused until you accept the new key.
2. Credentials: if a password or key is saved for the method (or its credential), they are used.
   Otherwise you are asked once, and the password is used only for that session and never stored.
3. SFTP must be enabled on the server. It is by default in OpenSSH (`Subsystem sftp` in
   `sshd_config`).
4. **Logs** depend on what the account can read:
   - Linux: the systemd journal (members of `systemd-journal` or `adm`), otherwise
     `/var/log/syslog` or `/var/log/messages`. Only warning and error lines are shown.
   - macOS: the unified log, errors from the last 10 minutes.
   - Windows: the System event log, errors and warnings.
5. Windows: enable *Settings → System → Optional features → OpenSSH Server*. The overview runs a
   fixed PowerShell script.

The overview runs a **fixed, read-only** script (uname, /proc, df, ps, journalctl, or sysctl/vm_stat
on macOS, or CIM queries on Windows). Nothing you type is executed, and nothing is installed or
changed on the device. The file/system session closes after 10 minutes without use, after 1 hour in
total, and when you sign out.

## Copying between servers (SFTP transfer page)

**SFTP transfer** in the sidebar shows two file browsers. Choose a **Source** and a **Destination**
server; each can be any device's SSH method (SFTP) or its RDP transfer drive. Tick files or folders
on one side, open the target folder on the other, and press **Copy** (or **Copy back** for the other
direction).

- Files stream from source to destination through emremote. Nothing is stored on the emremote host
  or sent through your browser.
- Folders are copied with everything inside. Symbolic links are skipped, not followed.
- **If a file exists:** *Skip it* (default) leaves the destination file alone; *Overwrite* replaces it.
- Transfers run in the background with progress and can be cancelled. Already copied files stay
  in place when you cancel; a file that was being written may be incomplete.
- Copying a folder into itself, or onto the folder it already is in, on the same server is refused.
- Each transfer is recorded in the activity log (`file.copy`) with the file count and size.
- Transfers belong to your browser session: they stop when you sign out.

## Quick connect

**Quick connect** (Overview, next to **Add device**) opens a session to a host that is not in the
inventory: choose RDP, SSH, VNC or Telnet, enter the host, port and sign-in (or a saved credential),
and press **Connect**. The session opens in a new tab.

- Nothing is saved. The target and password are kept in emremote's memory for your browser session
  only and are forgotten after 12 hours without use, when you sign out, or when emremote restarts.
- The same network policy applies as for devices (`EMREMOTE_ALLOWED_TARGET_NETWORKS`).
- The server's identity (SSH host key, RDP certificate) is recorded on first connect and enforced
  for the rest of that quick connection, but not saved.
- The keyboard layout can be changed from the session toolbar. The Files panel is not available
  for quick connections; add the device for files and the system overview.
- Turn on **Save as a device** to add the device and its connection method instead, then connect.

## Authentication modes (all protocols)

| Mode | Behaviour |
|---|---|
| Ask when connecting | Nothing is stored. If the server needs credentials, the session window asks for them and sends them directly to the gateway. |
| Store with connection | Username, password and key are stored with this connection, encrypted. |
| Saved credential | References a reusable credential (sidebar → **Credentials**). The connection's own username, if set, overrides the credential's. |

## Device status

emremote probes each configured port with a TCP connection every 60 s (`EMREMOTE_STATUS_CHECK_INTERVAL`)
and on demand from the device page (**⋯ → Check reachability now**):

| Status | Meaning |
|---|---|
| Reachable | All configured ports accepted a TCP connection from the emremote server. |
| Partially reachable | Some ports did. |
| Not reachable | None did: the computer is off, asleep, firewalled, or the service is disabled. |
| Not checked | No probe has completed yet. |

The status does not show whether a user is logged in or whether credentials work. That would need
an agent, which this release deliberately does not have. Windows may log these probes as short
connection attempts on the RDP port. Set the interval to `0` to disable probes.
