/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        surface: token("surface"),
        "surface-2": token("surface-2"),
        "surface-3": token("surface-3"),
        border: token("border"),
        "border-strong": token("border-strong"),
        fg: token("fg"),
        muted: token("muted"),
        subtle: token("subtle"),
        primary: token("primary"),
        "primary-fg": token("primary-fg"),
        accent: token("accent"),
        "accent-fg": token("accent-fg"),
        success: token("success"),
        warning: token("warning"),
        danger: token("danger"),
      },
      fontFamily: {
        sans: ['"Inter Variable"', "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: { "2xs": ["0.6875rem", { lineHeight: "1rem" }] },
      boxShadow: {
        pop: "0 1px 2px rgb(0 0 0 / 0.08), 0 12px 32px -8px rgb(0 0 0 / 0.35)",
        card: "0 1px 2px rgb(0 0 0 / 0.04)",
      },
      keyframes: {
        "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
        "scale-in": { from: { opacity: 0, transform: "scale(0.97)" }, to: { opacity: 1, transform: "scale(1)" } },
        // Centred dialogs: keep translate(-50%, -50%) during the animation.
        "dialog-in": {
          from: { opacity: 0, transform: "translate(-50%, calc(-50% + 6px)) scale(0.98)" },
          to: { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
        },
        // Overlays centred horizontally only (the command palette).
        "palette-in": {
          from: { opacity: 0, transform: "translateX(-50%) translateY(4px) scale(0.98)" },
          to: { opacity: 1, transform: "translateX(-50%) translateY(0) scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out",
        "scale-in": "scale-in 140ms ease-out",
        "dialog-in": "dialog-in 150ms cubic-bezier(0.16, 1, 0.3, 1)",
        "palette-in": "palette-in 150ms cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};
