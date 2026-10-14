# Limitations and status

- Users have two roles (administrator, member) with a fixed set of permissions; there is no
  fine-grained per-device permission and no SSO (OIDC/SAML) yet. Two-factor is TOTP only.
- No agent, so emremote cannot detect logged-in users or device health. Status means only "the
  service port accepted a TCP connection".
- RDP file exchange goes through the transfer drive, not the whole Windows disk; full disk access
  and system information need SSH (Windows' optional OpenSSH Server). Session recording is not
  implemented. Multi-monitor sessions are not possible: the gateway (guacd 1.6) offers one screen.
- **Not yet verified on real hardware:** RDP printing, microphone, RemoteApp and Hyper-V VMConnect
  settings (they are validated, stored and passed to the gateway), and Wake-on-LAN delivery from
  inside Docker's network. Treat them as experimental and report what you find.
- The system overview and file manager need an SSH connection method whose host key is pinned. On
  Windows, enable the optional OpenSSH Server. The Windows system overview is implemented but has
  not yet been validated against a real Windows host.
- macOS Screen Sharing works through its VNC compatibility mode, which has lower image quality and
  performance than RDP.
- The gateway decides frame rate and encoding. Expect an experience comparable to Guacamole: good
  for administration and office work, not for video or gaming. There are no promises of 4K/60 fps
  or lossless video.
