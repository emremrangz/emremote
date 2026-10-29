# Disposable test target exposing REAL RDP (xrdp), VNC (x11vnc) and SSH (OpenSSH)
# servers, used to validate emremote end to end. Never use in production.
FROM alpine:3.22
RUN apk add --no-cache xrdp xorgxrdp xorg-server xvfb x11vnc xterm openbox openssh-server \
      font-dejavu xsetroot dbus-x11 setxkbmap bash shadow procps busybox-extras sudo
# svc and svc2 are service accounts whose passwords the vault rotation tests change: svc changes its
# own password with passwd, svc2's is set by tester through sudo chpasswd (the only command tester may sudo).
RUN adduser -D -s /bin/sh svc && adduser -D -s /bin/sh svc2 \
 && echo 'tester ALL=(root) /usr/sbin/chpasswd' > /etc/sudoers.d/rotation && chmod 440 /etc/sudoers.d/rotation
RUN adduser -D -s /bin/bash tester \
 && ssh-keygen -A \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?AllowTcpForwarding.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config \
 && printf '#!/bin/sh\nexport XENVIRONMENT=/home/tester/.Xdefaults\nxsetroot -solid "#1f4e79"\nxterm -geometry 100x30+40+40 -fa "DejaVu Sans Mono" -fs 12 -T "emremote test target" -e bash -lc "echo RDP/VNC test target; hostname; exec bash" &\nexec openbox\n' > /home/tester/.xsession \
 && printf 'XTerm*VT100.translations: #override \\n\\\n  Ctrl <Key>v: insert-selection(CLIPBOARD) \\n\\\n  Shift <Key>Insert: insert-selection(CLIPBOARD)\n' > /home/tester/.Xdefaults \
 && chown tester:tester /home/tester/.Xdefaults \
 && chmod +x /home/tester/.xsession && cp /home/tester/.xsession /home/tester/.xinitrc && chown tester:tester /home/tester/.xsession /home/tester/.xinitrc \
 && sed -i 's|^exec .*|exec /home/tester/.xsession|' /etc/xrdp/startwm.sh 2>/dev/null || true
# Self-signed TLS certificate, like a default Windows installation.
RUN apk add --no-cache openssl \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=emremote-test-target" \
      -keyout /etc/xrdp/key.pem -out /etc/xrdp/cert.pem \
 && sed -i 's|^certificate=.*|certificate=/etc/xrdp/cert.pem|; s|^key_file=.*|key_file=/etc/xrdp/key.pem|' /etc/xrdp/xrdp.ini
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22 23 3389 5900
ENTRYPOINT ["/entrypoint.sh"]
