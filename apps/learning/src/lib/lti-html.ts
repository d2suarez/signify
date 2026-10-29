export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const STYLE = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f2f2;color:#201e1d;font:16px/1.5 system-ui,sans-serif}
main{max-width:32rem;padding:24px}h1{font-size:26px;margin:0 0 8px}p{margin:0 0 16px}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:999px;background:#1f4fd1;color:#fff;font-weight:600;text-decoration:none}
.btn:focus-visible{outline:3px solid #201e1d;outline-offset:2px}small{color:#5c5856}
@media(prefers-color-scheme:dark){body{background:#161514;color:#f3f2f2}.btn{background:#8fb0ff;color:#161514}small{color:#b3aeab}}`;

/** A small page shown inside the platform's frame (no app shell, no session). */
export function framePage(o: { lang: string; title: string; body: string; button?: { href: string; label: string }; note?: string; autoOpen?: boolean }): string {
  const btn = o.button
    ? `<p><a class="btn" href="${escapeHtml(o.button.href)}" target="_blank" rel="noopener">${escapeHtml(o.button.label)}</a></p>`
    : "";
  // Not in a frame (the platform opened a new window): go straight on.
  const go = o.button && o.autoOpen
    ? `<script>if (window.top === window) location.replace(${JSON.stringify(o.button.href)});</script>`
    : "";
  return `<!doctype html><html lang="${escapeHtml(o.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signify Learning</title><style>${STYLE}</style></head><body><main><h1>${escapeHtml(o.title)}</h1><p>${escapeHtml(o.body)}</p>${btn}${o.note ? `<small>${escapeHtml(o.note)}</small>` : ""}</main>${go}</body></html>`;
}
