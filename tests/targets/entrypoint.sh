#!/bin/sh
set -e
: "${TARGET_PASSWORD:?TARGET_PASSWORD is required}"
echo "tester:${TARGET_PASSWORD}" | chpasswd
# System log with a couple of entries (for the system overview)
syslogd -O /var/log/messages
sleep 0.2
logger -p daemon.warning "emremote test target: disk usage warning (synthetic)"
logger -p daemon.err "emremote test target: synthetic error for log display"
chmod 644 /var/log/messages
# Telnet (unencrypted; network-device style login prompt)
telnetd -p 23 -l /bin/login
# SSH
/usr/sbin/sshd
# VNC on a virtual X display :1 (password-protected)
su tester -c "Xvfb :1 -screen 0 1600x900x24 >/tmp/xvfb.log 2>&1 &"
sleep 1
su tester -c "DISPLAY=:1 /home/tester/.xsession >/tmp/session.log 2>&1 &"
mkdir -p /home/tester/.vnc && x11vnc -storepasswd "${TARGET_PASSWORD}" /home/tester/.vnc/passwd >/dev/null
chown -R tester:tester /home/tester/.vnc
su tester -c "x11vnc -display :1 -rfbauth /home/tester/.vnc/passwd -forever -shared -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &"
# RDP (xrdp generates a self-signed certificate on first start)
mkdir -p /var/run/xrdp
xrdp-sesman
exec xrdp --nodaemon
