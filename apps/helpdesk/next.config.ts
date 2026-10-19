import type { NextConfig } from "next";

// Sent with every response. The help desk holds ticket text, photographs and
// staff sign-ins, and had no headers at all: nothing stopped it being framed
// for a clickjacked "resolve", and nothing constrained where an injected
// script could send what it read.
//
// 'unsafe-inline' stays for scripts because Next's app router inlines its
// hydration payload. Naming the HOSTS is what actually helps: with no external
// origin allowed, an injected <script src> has nowhere to load from and an
// injected fetch has nowhere to send to.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  serverExternalPackages: ["imapflow", "mailparser"],
  experimental: {
    serverActions: {
      // Allow photo uploads on ticket submissions (default is 1 MB)
      bodySizeLimit: "45mb",
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "geolocation=(), microphone=(), camera=(self), payment=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
