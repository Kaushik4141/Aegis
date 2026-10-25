import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      colors: {
        mono: {
          bg: "#050505",
          card: "#0a0a0a",
          surface: "#111111",
          elevated: "#171717",
          border: "#222222",
          borderLight: "#2a2a2a",
          text: "#ededed",
          muted: "#888888",
          dim: "#555555",
        },
      },
    },
  },
  plugins: [],
};

export default config;
