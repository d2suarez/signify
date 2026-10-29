import type { NextConfig } from "next";
import { BOARD_ORIGINS } from "./src/lib/boards";

// Sent with every response. Students' work and names pass through this app,
// so no external origin is allowed for scripts, styles, fonts or connections:
// an injected <script src> has nowhere to load from and an injected fetch has
// nowhere to send to. 'unsafe-inline' stays for scripts because the app
// router inlines its hydration payload. Frames: only Signify Boards' own
// origins, for Board blocks (src/lib/boards.ts holds the list).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src 'self' ${BOARD_ORIGINS.join(" ")}`,
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
        source: "/:path((?!lti/).*)",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // The microphone only for this app's own pages: the teacher's noise meter
          // (Presenter.tsx), which keeps nothing but a loudness number.
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(self), camera=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
