// Test fixture: an SSH server that answers like a Cisco IOS XE switch to the fixed "show"
// commands emremote runs, and rejects every other command. The password is read from
// TARGET_PASSWORD, the user is "tester". Not part of the product.
//
//	docker run --rm --network host -e TARGET_PASSWORD=... -v "$PWD/tests/targets/fakeswitch:/src/cmd/fakeswitch:ro" \
//	  -v "$PWD/app/backend:/src" -w /src golang:1.26-alpine go run ./cmd/fakeswitch
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"log"
	"net"
	"os"

	"golang.org/x/crypto/ssh"
)

var answers = map[string]string{
	"show version": `Cisco IOS XE Software, Version 17.06.04
Cisco IOS Software [Bengaluru], Catalyst L3 Switch Software (CAT9K_IOSXE), Version 17.6.4, RELEASE SOFTWARE (fc1)
lab-sw1 uptime is 1 week, 2 days, 3 hours, 4 minutes
cisco C9300-48P (X86) processor with 1392760K/6147K bytes of memory.
Processor board ID FCW2345A0BC
`,
	"show processes cpu":    "CPU utilization for five seconds: 3%/1%; one minute: 7%; five minutes: 4%\n",
	"show processes memory": "Processor Pool Total: 1073741824 Used: 268435456 Free: 805306368\n",
}

func main() {
	pw := os.Getenv("TARGET_PASSWORD")
	if pw == "" {
		log.Fatal("TARGET_PASSWORD is required")
	}
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(priv)
	cfg := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
		if c.User() == "tester" && string(p) == pw {
			return nil, nil
		}
		return nil, os.ErrPermission
	}}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", ":12522")
	if err != nil {
		log.Fatal(err)
	}
	for {
		nc, err := ln.Accept()
		if err != nil {
			continue
		}
		go func() {
			conn, chans, reqs, err := ssh.NewServerConn(nc, cfg)
			if err != nil {
				return
			}
			defer conn.Close()
			go ssh.DiscardRequests(reqs)
			for ch := range chans {
				if ch.ChannelType() != "session" {
					_ = ch.Reject(ssh.UnknownChannelType, "no")
					continue
				}
				c, creqs, _ := ch.Accept()
				go func() {
					defer c.Close()
					for r := range creqs {
						if r.Type != "exec" {
							_ = r.Reply(false, nil)
							continue
						}
						cmd := string(r.Payload[4:])
						_ = r.Reply(true, nil)
						if out, ok := answers[cmd]; ok {
							_, _ = c.Write([]byte(out))
						} else {
							_, _ = c.Write([]byte("% Invalid input detected at '^' marker.\n"))
						}
						_, _ = c.SendRequest("exit-status", false, []byte{0, 0, 0, 0})
						return
					}
				}()
			}
		}()
	}
}
