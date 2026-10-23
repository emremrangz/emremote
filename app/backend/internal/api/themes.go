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
	"solarized-dark":   {"#839496", "#002b36", [16]string{"#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"}},
	"dracula":          {"#f8f8f2", "#282a36", [16]string{"#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"}},
	"nord":             {"#d8dee9", "#2e3440", [16]string{"#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"}},
	"one-dark":         {"#abb2bf", "#282c34", [16]string{"#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"}},
	"tomorrow-night":   {"#c5c8c6", "#1d1f21", [16]string{"#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6", "#969896", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#ffffff"}},
	"monokai":          {"#f8f8f2", "#272822", [16]string{"#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"}},
	"gruvbox-dark":     {"#ebdbb2", "#282828", [16]string{"#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"}},
	"tokyo-night":      {"#c0caf5", "#1a1b26", [16]string{"#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"}},
	"catppuccin-mocha": {"#cdd6f4", "#1e1e2e", [16]string{"#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"}},
	"github-dark":      {"#c9d1d9", "#0d1117", [16]string{"#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc"}},
	"material-dark":    {"#eeffff", "#263238", [16]string{"#263238", "#ff5370", "#c3e88d", "#ffcb6b", "#82aaff", "#c792ea", "#89ddff", "#eeffff", "#546e7a", "#ff5370", "#c3e88d", "#ffcb6b", "#82aaff", "#c792ea", "#89ddff", "#ffffff"}},
	"rose-pine":        {"#e0def4", "#191724", [16]string{"#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"}},
	"everforest":       {"#d3c6aa", "#2d353b", [16]string{"#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa", "#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa"}},
	"night-owl":        {"#d6deeb", "#011627", [16]string{"#011627", "#ef5350", "#22da6e", "#addb67", "#82aaff", "#c792ea", "#21c7a8", "#ffffff", "#575656", "#ef5350", "#22da6e", "#ffeb95", "#82aaff", "#c792ea", "#7fdbca", "#ffffff"}},
	"ayu-dark":         {"#bfbdb6", "#0b0e14", [16]string{"#11151c", "#ea6c73", "#7fd962", "#f9af4f", "#53bdfa", "#cda1fa", "#90e1c6", "#c7c7c7", "#686868", "#f07178", "#aad94c", "#ffb454", "#59c2ff", "#d2a6ff", "#95e6cb", "#ffffff"}},
	"zenburn":          {"#dcdccc", "#3f3f3f", [16]string{"#4d4d4d", "#705050", "#60b48a", "#f0dfaf", "#506070", "#dc8cc3", "#8cd0d3", "#dcdccc", "#709080", "#dca3a3", "#c3bf9f", "#e0cf9f", "#94bff3", "#ec93d3", "#93e0e3", "#ffffff"}},
	"tango-dark":       {"#d3d7cf", "#2e3436", [16]string{"#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf", "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"}},
	"amber":            {"#ffb000", "#1a1000", [16]string{"#1a1000", "#ff6a00", "#d6a100", "#ffcc33", "#ff9d00", "#ff7a00", "#ffc766", "#ffb000", "#7a5600", "#ff8c3a", "#ffd24d", "#ffe08a", "#ffb84d", "#ff9a5c", "#ffd699", "#fff0cc"}},
	"solarized-light":  {"#657b83", "#fdf6e3", [16]string{"#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"}},
	"gruvbox-light":    {"#3c3836", "#fbf1c7", [16]string{"#fbf1c7", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64", "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"}},
	"catppuccin-latte": {"#4c4f69", "#eff1f5", [16]string{"#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be", "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"}},
	"github-light":     {"#24292f", "#ffffff", [16]string{"#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"}},
	"paper":            {"#333333", "#f5f2e9", [16]string{"#333333", "#b00020", "#1b7f3b", "#8a6500", "#1f5fbf", "#8e3b9e", "#0e7c86", "#bdbdbd", "#6b6b6b", "#d93a4a", "#2fa353", "#b58900", "#3b82f6", "#a855f7", "#1fa3ad", "#ffffff"}},
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
