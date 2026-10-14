# Test fixture: a switch-style Telnet server (login prompt, password check, CLI)
# that prints what it receives. Used to verify Telnet automatic sign-in:
#   docker run --rm -p 12325:23 -v "$PWD/tests/targets:/f:ro" python:3-alpine python3 -u /f/fake-switch.py
# Minimal network-switch style telnet server: login prompt, password check, CLI.
import socket, threading
USER, PASS = "tester", "s3cret"
def readline(c, echo):
    buf = b""
    while True:
        b = c.recv(1)
        if not b: return None
        if b == b"\xff":  # IAC: skip option negotiation (3 bytes)
            c.recv(2); continue
        if b in (b"\r", b"\n"):
            if buf: return buf.decode(errors="replace")
            continue
        if b == b"\x00": continue
        buf += b
        if echo: c.sendall(b)
def handle(c):
    try:
        c.sendall(b"\r\nUser Access Verification\r\n\r\nUsername: ")
        u = readline(c, True)
        if u is None: return
        c.sendall(b"\r\nPassword: ")
        p = readline(c, False)
        ok = (u == USER and p == PASS)
        print(f"LOGIN user={u!r} password_ok={p == PASS} -> {'SUCCESS' if ok else 'FAILED'}", flush=True)
        if not ok:
            c.sendall(b"\r\n% Login invalid\r\n"); return
        c.sendall(b"\r\nswitch# ")
        while True:
            cmd = readline(c, True)
            if cmd is None: return
            print(f"COMMAND {cmd!r}", flush=True)
            c.sendall(f"\r\n{cmd} -> ok\r\nswitch# ".encode())
    except OSError:
        pass
    finally:
        c.close()
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("0.0.0.0", 23)); s.listen(5)
while True:
    c, _ = s.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()
