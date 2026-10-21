import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SentinelGate — Agent Safety Control Plane",
  description: "Edge-native action firewall for autonomous business agents.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
