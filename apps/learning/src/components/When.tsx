"use client";

/**
 * A moment shown in the reader's own time zone. The server doesn't know it,
 * so the date is formatted in the browser (the server's guess is replaced
 * on load without a hydration warning).
 */
export function When({ iso, withTime = true, lang = "en" }: { iso: string | null; withTime?: boolean; lang?: string }) {
  if (!iso) return null;
  const d = new Date(iso);
  const text = d.toLocaleString(lang === "es" ? "es" : "en-US", {
    weekday: "short", month: "short", day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
  return <time dateTime={iso} suppressHydrationWarning>{text}</time>;
}
