"use client";

import { useEffect, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import { DESK_ORIGIN, DESK_TYPE, deskEmbedUrl } from "@/lib/desk";
import type { WidgetKind } from "@/lib/widgets";

/** Teacher's Desk's mark: its three shapes (the desk's own app icon). */
export function DeskMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <circle cx="128" cy="128" r="128" fill="#ec3013" />
      <rect x="256" y="0" width="256" height="256" fill="#1f4fd1" />
      <path d="M256 256 512 512 0 512Z" fill="#f5c400" />
    </svg>
  );
}

/**
 * The rail's tools are Teacher's Desk's own: one frame of desk.signify.one/embed
 * showing the person's real cards (the same timer, the same seating plans as
 * on their desk), drawn and saved by Desk with the person's own Desk sign-in.
 * One frame for all of them, so it is one desk tab, never several racing
 * each other's saves. Desk tells us (postMessage, checked against its
 * origin) how tall it is and when a card opens larger; then the frame fills
 * the window until Desk says it closed.
 */
export function DeskFrame({ d, kinds, idClassId, hidden }: { d: Dict; kinds: WidgetKind[]; idClassId: string | null; hidden: boolean }) {
  const [height, setHeight] = useState(160);
  const [big, setBig] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  const types = kinds.map((k) => DESK_TYPE[k]);
  const key = `${types.join(",")}|${idClassId ?? ""}`;
  // Built in the browser: Desk only talks back to the origin it was told, and checks it.
  useEffect(() => { setSrc(deskEmbedUrl(types, idClassId, location.origin)); setLoaded(false); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== DESK_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const m = e.data as { desk?: number; height?: number; stage?: boolean };
      if (!m || m.desk !== 1) return;
      if (typeof m.height === "number" && m.height > 0) setHeight(Math.min(4000, Math.round(m.height)));
      if (typeof m.stage === "boolean") setBig(m.stage);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!src) return null;
  return (
    <div className={`desk-frame ${big ? "is-big" : ""}`} hidden={hidden}>
      {!loaded && <p className="muted wg-small" style={{ margin: 0 }}>{d.wgLoading}</p>}
      <iframe
        ref={frame}
        src={src}
        title={d.wgDeskFrame}
        style={big ? undefined : { height }}
        allow={`microphone ${DESK_ORIGIN}; fullscreen ${DESK_ORIGIN}; clipboard-write ${DESK_ORIGIN}`}
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
