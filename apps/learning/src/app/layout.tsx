import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { lang, myPrefs } from "@/lib/access";
import { readMe } from "@/lib/auth";
import { prefsAttrs } from "@/lib/prefs";
import { dict, type Dict } from "@/lib/i18n";
import { RailShell } from "@/components/rail/Rail";

/** Only the words the left rail uses go to the browser with every page. */
const RAIL_WORDS = /^(wg|todo|noise|mic|pick)|^(due|present|pcDraft|tryAgain|close|start|pause|resume|reset|save|saving|cancel)$/;
function railDict(d: Dict): Dict {
  return Object.fromEntries(Object.entries(d).filter(([k]) => RAIL_WORDS.test(k))) as Dict;
}

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
  const L = await lang();
  const me = await readMe();
  return (
    // The person's reading supports, on the first paint (globals.css reads them).
    <html lang={L} {...prefsAttrs(await myPrefs())}>
      <body>
        {/* To do and the person's Desk tools on the left of the normal pages (src/components/rail). */}
        <RailShell d={railDict(dict(L))} lang={L} signedIn={!!me}>{children}</RailShell>
        {/* The Signify app switcher and "Report a problem", shared by every app. */}
        <Script src="/vendor/signify-switcher.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
