FROM alpine:3.22
RUN apk add --no-cache unfs3 rpcbind && mkdir -p /srv/nfs && chmod 777 /srv/nfs \
 && echo '/srv/nfs (rw,no_root_squash,insecure)' > /etc/exports
CMD ["sh", "-c", "rpcbind -f -w & sleep 1; exec unfsd -d -e /etc/exports -n 2049 -m 2049"]
