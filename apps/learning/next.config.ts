import type { NextConfig } from "next";

// Sent with every response. Students' work and names pass through this app,
// so no external origin is allowed for scripts, styles, fonts or connections:
// an injected <script src> has nowhere to load from and an injected fetch has
// nowhere to send to. 'unsafe-inline' stays for scripts because the app
// router inlines its hydration payload.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig: NextConfig = {
  // Kept out of the bundle: PGlite ships WebAssembly and data files it loads
  // from its own folder, and pg has optional native bits.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
