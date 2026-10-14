package api

import (
	"strings"
	"testing"
)

func TestSnippetValidation(t *testing.T) {
	v, req := snippetRequest{Name: " Restart nginx ", Body: "sudo systemctl restart nginx\r\nsystemctl status nginx\n\n", Category: " web "}.validate()
	if !v.ok() {
		t.Fatalf("valid snippet rejected: %v", v.errs)
	}
	if req.Name != "Restart nginx" || req.Category != "web" || req.Body != "sudo systemctl restart nginx\nsystemctl status nginx" {
		t.Fatalf("normalisation: %+v", req)
	}
	for name, bad := range map[string]snippetRequest{
		"no name":      {Body: "ls"},
		"empty body":   {Name: "x", Body: " \n "},
		"control char": {Name: "x", Body: "ls\x1b[2J"},
		"long body":    {Name: "x", Body: strings.Repeat("a", 4001)},
		"long name":    {Name: strings.Repeat("a", 65), Body: "ls"},
		"long cat":     {Name: "x", Body: "ls", Category: strings.Repeat("a", 33)},
	} {
		if v, _ := bad.validate(); v.ok() {
			t.Errorf("%s: accepted", name)
		}
	}
	if v, _ := (snippetRequest{Name: "tabs", Body: "a\tb\n  indented"}).validate(); !v.ok() {
		t.Error("tabs and indentation must survive")
	}
}
