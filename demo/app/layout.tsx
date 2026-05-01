import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "edgesharp · Cloudflare-native image optimization for Next.js",
  description:
    "Drop-in /_next/image replacement powered by Zig WASM SIMD. One line in next.config.mjs.",
  icons: { icon: "/demo/icon.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
