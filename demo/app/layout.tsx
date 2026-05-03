import type { Metadata } from "next";
import Header from "./Header";
import Tabs from "./Tabs";
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
        <div className="max-w-6xl mx-auto px-6 pt-6">
          <Header />
          <Tabs />
        </div>
        {children}
        <script
          defer
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon='{"token": "3a5b865568b24718b7d8f62803f332fd"}'
        />
      </body>
    </html>
  );
}
