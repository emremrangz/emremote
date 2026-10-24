FROM alpine:3.22
RUN apk add --no-cache samba && adduser -D -u 1000 rec && mkdir -p /srv/rec && chown rec /srv/rec
COPY smb.conf /etc/samba/smb.conf
CMD ["sh", "-c", "printf '%s\\n%s\\n' \"$TARGET_PASSWORD\" \"$TARGET_PASSWORD\" | smbpasswd -a -s rec && exec smbd -F --no-process-group --debug-stdout"]
