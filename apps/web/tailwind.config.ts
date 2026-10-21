import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["var(--font-inter)", "Inter", "sans-serif"] },
      colors: { ink: "#111827", muted: "#6B7280", line: "#E5E7EB", accent: "#2563EB" },
      boxShadow: { panel: "0 12px 36px rgba(15, 23, 42, 0.06)" },
    },
  },
  plugins: [],
};

export default config;
