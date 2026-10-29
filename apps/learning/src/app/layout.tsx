import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { lang } from "@/lib/access";

export const metadata: Metadata = {
  title: { default: "Signify Learning", template: "%s · Signify Learning" },
  description: "Lessons that are the plan, the presentation and the student view at once.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f2f2" },
    { media: "(prefers-color-scheme: dark)", color: "#161514" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={await lang()}>
      <body>
        {children}
        {/* The Signify app switcher and "Report a problem", shared by every app. */}
        <Script src="/vendor/signify-switcher.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
