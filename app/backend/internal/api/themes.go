package api

import (
	"fmt"
	"slices"
	"strings"
)

// Terminal appearance. guacd renders SSH and Telnet screens on the server, so
// colors and fonts are guacd parameters: the four built-in schemes plus a few
// popular palettes, which are expanded into guacd's custom color-scheme syntax.

type termTheme struct {
	fg, bg string
	ansi   [16]string
}

// terminalThemes holds palettes by name (colors as #rrggbb).
var terminalThemes = map[string]termTheme{
	"solarized-dark":  {"#839496", "#002b36", [16]string{"#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"}},
	"solarized-light": {"#657b83", "#fdf6e3", [16]string{"#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"}},
	"dracula":         {"#f8f8f2", "#282a36", [16]string{"#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"}},
	"nord":            {"#d8dee9", "#2e3440", [16]string{"#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"}},
	"one-dark":        {"#abb2bf", "#282c34", [16]string{"#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"}},
	"tomorrow-night":  {"#c5c8c6", "#1d1f21", [16]string{"#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6", "#969896", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#ffffff"}},
}

var builtinSchemes = []string{"gray-black", "black-white", "green-black", "white-black"}

// terminalSchemes lists every accepted color scheme name.
var terminalSchemes = func() []string {
	out := slices.Clone(builtinSchemes)
	for name := range terminalThemes {
		out = append(out, name)
	}
	slices.Sort(out[len(builtinSchemes):])
	return out
}()

// terminalFonts are the monospace fonts installed in the guacd image.
var terminalFonts = []string{"DejaVu Sans Mono", "Liberation Mono", "Terminus"}

// rgb converts #rrggbb to guacd's rgb:RR/GG/BB.
func rgb(hex string) string {
	h := strings.TrimPrefix(hex, "#")
	return fmt.Sprintf("rgb:%s/%s/%s", h[0:2], h[2:4], h[4:6])
}

// guacColorScheme returns the value of guacd's color-scheme parameter.
func guacColorScheme(name string) string {
	t, ok := terminalThemes[name]
	if !ok {
		return name // one of the built-in schemes
	}
	var b strings.Builder
	fmt.Fprintf(&b, "foreground: %s;\nbackground: %s;\n", rgb(t.fg), rgb(t.bg))
	for i, c := range t.ansi {
		fmt.Fprintf(&b, "color%d: %s;\n", i, rgb(c))
	}
	return b.String()
}

// TerminalPrefs are personal appearance choices sent by the browser; they win
// over the connection's own settings. Empty fields mean "use the connection's".
type TerminalPrefs struct {
	ColorScheme string `json:"color_scheme"`
	FontName    string `json:"font_name"`
	FontSize    int    `json:"font_size"`
}

func (v *validator) terminalPrefs(p *TerminalPrefs) *TerminalPrefs {
	if p == nil || *p == (TerminalPrefs{}) {
		return nil
	}
	if p.ColorScheme != "" {
		v.oneOf("terminal.color_scheme", p.ColorScheme, terminalSchemes...)
	}
	if p.FontName != "" {
		v.oneOf("terminal.font_name", p.FontName, terminalFonts...)
	}
	if p.FontSize != 0 {
		between(v, "terminal.font_size", p.FontSize, 6, 48)
	}
	return p
}
