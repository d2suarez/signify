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

/**
 * The deep-linking page in the platform's frame: it offers the picker in a
 * new tab, then asks every few seconds whether the teacher has chosen and
 * posts the signed answer to the platform from inside the frame, where the
 * platform expects it. Not in a frame, the same window goes to the picker.
 */
export function deepLinkFramePage(o: {
  lang: string; title: string; body: string; button: { href: string; label: string };
  poll: string; waiting: string; sending: string; gone: string;
}): string {
  const page = framePage({ lang: o.lang, title: o.title, body: o.body, button: o.button });
  const script = `<p id="dl-status" role="status" aria-live="polite"><small>${escapeHtml(o.waiting)}</small></p><script>(function(){
var href=${JSON.stringify(o.button.href)},poll=${JSON.stringify(o.poll)},sending=${JSON.stringify(o.sending)},gone=${JSON.stringify(o.gone)};
if(window.top===window){location.replace(href+"?w=1");return;}
var el=document.getElementById("dl-status"),tries=0;
function say(t){el.textContent=t;}
function post(r){say(sending);var f=document.createElement("form");f.method="post";f.action=r.returnUrl;
var i=document.createElement("input");i.type="hidden";i.name="JWT";i.value=r.jwt;f.appendChild(i);document.body.appendChild(f);f.submit();}
function ask(){if(++tries>900)return;fetch(poll,{cache:"no-store",credentials:"omit"}).then(function(r){return r.json();}).then(function(r){
if(r.state==="ready")post(r);else if(r.state==="gone")say(gone);else setTimeout(ask,2000);}).catch(function(){setTimeout(ask,4000);});}
setTimeout(ask,2000);})();</script>`;
  return page.replace("</main>", `${script}</main>`);
}

/** A page that posts the signed deep-linking answer to the platform at once (we were opened in a window). */
export function deepLinkPostPage(o: { lang: string; returnUrl: string; jwt: string; label: string }): string {
  return `<!doctype html><html lang="${escapeHtml(o.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signify Learning</title><style>${STYLE}</style></head><body><main><form id="dl" method="post" action="${escapeHtml(o.returnUrl)}">
<input type="hidden" name="JWT" value="${escapeHtml(o.jwt)}"><button class="btn" type="submit">${escapeHtml(o.label)}</button></form></main>
<script>document.getElementById("dl").submit();</script></body></html>`;
}
