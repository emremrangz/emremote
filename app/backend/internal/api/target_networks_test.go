package api

import "testing"

func TestParseTargetNetworks(t *testing.T) {
	got, err := parseTargetNetworks([]string{"192.168.1.0/24", " 137.23.43.108 ", "10.1.2.3/8", "192.168.1.0/24", "2001:db8::5", ""})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"192.168.1.0/24", "137.23.43.108/32", "10.0.0.0/8", "2001:db8::5/128"}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i, p := range got {
		if p.String() != want[i] {
			t.Errorf("entry %d: %s, want %s", i, p, want[i])
		}
	}
	if targetsEverywhere(got) {
		t.Error("not everywhere")
	}
	all, err := parseTargetNetworks([]string{"0.0.0.0"})
	if err != nil || all[0].String() != "0.0.0.0/0" || !targetsEverywhere(all) {
		t.Fatalf("0.0.0.0 means everywhere: %v %v", all, err)
	}
	if v6, _ := parseTargetNetworks([]string{"::"}); len(v6) != 1 || v6[0].String() != "::/0" {
		t.Fatalf(":: means every IPv6 address: %v", v6)
	}
	for _, bad := range [][]string{{}, {""}, {"not-an-ip"}, {"10.0.0.0/33"}, {"http://1.2.3.4"}, {"fe80::1%eth0"}} {
		if _, err := parseTargetNetworks(bad); err == nil {
			t.Errorf("%v should be rejected", bad)
		}
	}
}
