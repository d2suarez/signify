import type { NextConfig } from "next";
import { BOARD_ORIGINS } from "./src/lib/boards";
import { VIDEO_ORIGINS } from "./src/lib/post-doc";
import { DESK_ORIGIN } from "./src/lib/desk";
import { GOOGLE_EMBED_ORIGINS } from "./src/lib/embeds";

// Sent with every response. Students' work and names pass through this app,
// so no external origin is allowed for scripts, styles, fonts or connections:
// an injected <script src> has nowhere to load from and an injected fetch has
// nowhere to send to. 'unsafe-inline' stays for scripts because the app
// router inlines its hydration payload. Frames: only Signify Boards' own
// origins, for Board blocks (src/lib/boards.ts holds the list), and the
// YouTube (no-cookie) and Vimeo players for videos in updates (post-doc.ts),
// Teacher's Desk for the left rail's tools (src/lib/desk.ts), and Google's
// embed pages for Slides/Docs/Sheets/Forms/Drive files (src/lib/embeds.ts).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src 'self' ${[...BOARD_ORIGINS, ...VIDEO_ORIGINS, DESK_ORIGIN, ...GOOGLE_EMBED_ORIGINS].join(" ")}`,
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig: NextConfig = {
  // Kept out of the bundle: PGlite ships WebAssembly and data files it loads
  // from its own folder, and pg has optional native bits.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  // Our LTI public keys, where platforms look for them.
  async rewrites() {
    return [{ source: "/.well-known/jwks.json", destination: "/lti/jwks" }];
  },
  async headers() {
    return [
      {
        // Everything but /lti/: those responses set their own headers, because a
        // launch may be framed by the registered platform's origins (and only
        // those), which this static list can't know (src/app/lti/respond.ts).
        // And /files/: an uploaded file sets its own (src/app/files/[id]/route.ts),
        // because this page CSP's object-src 'none' stops the browser's PDF viewer.
        // /work-files/ (students' handed-in files) likewise.
        source: "/:path((?!lti/|files/|work-files/).*)",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // The microphone only for this app's own pages: the teacher's noise meter
          // (Presenter.tsx), which keeps nothing but a loudness number; and
          // Teacher's Desk framed in the left rail, for its own noise meter.
          { key: "Permissions-Policy", value: `geolocation=(), microphone=(self "${DESK_ORIGIN}"), camera=(), payment=()` },
        ],
      },
    ];
  },
};

export default nextConfig;
