package api

import (
	"net/http"
	"strings"
	"unicode/utf8"
)

// ---- Command snippets ----
//
// Snippets are personal text the user types into their own terminal sessions
// from the browser. The server only stores them; it never runs them, and no
// keystrokes are recorded: the "recent" list is simply the snippets that were
// inserted last.

const maxSnippetsPerUser = 500

type snippetRequest struct {
	Name     string `json:"name"`
	Body     string `json:"body"`
	Category string `json:"category"`
}

func (req snippetRequest) validate() (*validator, snippetRequest) {
	v := newValidator()
	req.Name = v.text("name", req.Name, true, 64, false)
	req.Category = v.text("category", req.Category, false, 32, false)
	// The body keeps its inner whitespace and line breaks (only trailing newlines are trimmed).
	req.Body = strings.TrimRight(strings.ReplaceAll(req.Body, "\r\n", "\n"), "\n")
	switch {
	case !utf8.ValidString(req.Body):
		v.fail("body", "Contains invalid characters")
	case strings.TrimSpace(req.Body) == "":
		v.fail("body", "Required")
	case utf8.RuneCountInString(req.Body) > 4000:
		v.fail("body", "Must be at most 4000 characters")
	case hasControl(req.Body, true):
		v.fail("body", "Contains control characters")
	}
	return v, req
}

func (s *Server) handleListSnippets(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListSnippets(r.Context(), userFrom(r.Context()).ID)
	if err != nil {
		writeStoreError(w, r, err, "snippet")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreateSnippet(w http.ResponseWriter, r *http.Request) {
	var req snippetRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, req := req.validate()
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	u := userFrom(r.Context())
	if n, err := s.store.CountSnippets(r.Context(), u.ID); err == nil && n >= maxSnippetsPerUser {
		writeError(w, http.StatusConflict, "limit_reached", "You can keep up to 500 snippets. Delete some first.")
		return
	}
	sn, err := s.store.CreateSnippet(r.Context(), u.ID, req.Name, req.Body, req.Category)
	if err != nil {
		writeStoreError(w, r, err, "Snippet")
		return
	}
	writeJSON(w, http.StatusCreated, sn)
}

func (s *Server) handleUpdateSnippet(w http.ResponseWriter, r *http.Request) {
	var req snippetRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	v, req := req.validate()
	if !v.ok() {
		writeValidation(w, v)
		return
	}
	sn, err := s.store.UpdateSnippet(r.Context(), userFrom(r.Context()).ID, r.PathValue("id"), req.Name, req.Body, req.Category)
	if err != nil {
		writeStoreError(w, r, err, "Snippet")
		return
	}
	writeJSON(w, http.StatusOK, sn)
}

func (s *Server) handleDeleteSnippet(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteSnippet(r.Context(), userFrom(r.Context()).ID, r.PathValue("id")); err != nil {
		writeStoreError(w, r, err, "Snippet")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSnippetUsed(w http.ResponseWriter, r *http.Request) {
	sn, err := s.store.MarkSnippetUsed(r.Context(), userFrom(r.Context()).ID, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, r, err, "Snippet")
		return
	}
	writeJSON(w, http.StatusOK, sn)
}
