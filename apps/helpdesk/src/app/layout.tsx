import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { APP_TITLE } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: APP_TITLE,
    template: `%s · ${APP_TITLE}`,
  },
  description: "Ask for help with technology, buildings and anything else, and plan projects together.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f2f2" },
    { media: "(prefers-color-scheme: dark)", color: "#161514" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        {/* The Signify app switcher and "Report a problem", shared by every app. */}
        <Script src="/vendor/signify-switcher.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
