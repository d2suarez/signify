"use client";

import { useEffect } from "react";

export function CloseWhenDone() {
  useEffect(() => {
    try {
      window.opener?.postMessage({ type: "signify-helpdesk-connected" }, "*");
    } catch {}
    const timer = setTimeout(() => window.close(), 1200);
    return () => clearTimeout(timer);
  }, []);
  return null;
}
