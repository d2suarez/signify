import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { Zip, ZIP_LIMITS } from "./zip";
import { saveFile, sniffFile, MAX_FILE, FileError } from "./files";
import { normalizeBlocks, type Block } from "./blocks";
import type { Plan, PlanBlock, PlanMedia } from "./cartridge";

/**
 * Brings an import plan's pictures and files in as Learning's own files
 * (encrypted, checked by their bytes, src/lib/files.ts), before the import's
 * transaction starts, and turns the plan's `media` blocks into file blocks.
 *
 * - From inside the export: read with room for a whole file (up to
 *   files.ts MAX_FILE), one at a time; each path stored once.
 * - From the web (a picture a page showed from another site): only https or
 *   http to a public address (no private, loopback or link-local address,
 *   checked again on every redirect), at most 5 redirects, 10 seconds and
 *   MAX_FILE bytes, and only if the bytes are a picture. At most
 *   REMOTE_CAP per import. Schoology's own picture addresses need a
 *   Schoology sign-in, so those come back as a link to the picture instead.
 * - Anything refused stays visible: a web picture becomes a link block, a
 *   file inside the export is listed in `failed`.
 */

export const REMOTE_CAP = 150;
const MEDIA_ZIP = { ...ZIP_LIMITS, entryBytes: MAX_FILE, totalInflated: 1024 * 1024 * 1024 };

export type MediaResult = {
  /** Lessons' blocks with media in place, by lesson object. */
  saved: number;
  failed: string[];
  /** Files were off (no storage set up): nothing was stored. */
  off: boolean;
};

type Saved = { fileId: string; name: string; kind: "image" | "pdf" | "audio" | "video" | "doc" };
type Who = { tenantId: string; userId: string };
type Fetcher = (url: string) => Promise<Buffer | null>;

/** Replaces every lesson's media blocks with file blocks (or links), in place. */
export async function bringInMedia(
  who: Who, courseId: string, buf: Buffer, plan: Plan, fetcher: Fetcher = fetchPicture,
): Promise<MediaResult> {
  const lessons = [...plan.loose, ...plan.units.flatMap((u) => u.items)].filter((i) => i.kind === "lesson");
  const result: MediaResult = { saved: 0, failed: [], off: false };
  if (!lessons.some((l) => l.blocks.some((b) => b.type === "media"))) return result;

  let zip: Zip | null = null;
  const done = new Map<string, Saved | null>();
  let remote = 0;
  const store = async (key: string, name: string, bytes: Buffer | null): Promise<Saved | null> => {
    if (!bytes || result.off) return null;
    try {
      const f = await saveFile({ ...who, role: "teacher" }, courseId, name, bytes);
      result.saved++;
      return { fileId: f.id, name: f.name, kind: f.kind };
    } catch (e) {
      if (e instanceof FileError) {
        if (e.code === "off") result.off = true;
        return null;
      }
      throw e;
    }
  };
  const get = async (m: PlanMedia): Promise<Saved | null> => {
    const key = m.path ? `zip:${m.path}` : `url:${m.url}`;
    if (done.has(key)) return done.get(key)!;
    let saved: Saved | null = null;
    if (m.path) {
      zip ??= new Zip(buf, MEDIA_ZIP);
      let bytes: Buffer | null = null;
      try { bytes = zip.read(m.path); } catch { bytes = null; }
      saved = await store(key, m.name, bytes);
    } else if (m.url && remote < REMOTE_CAP) {
      remote++;
      const bytes = await fetcher(m.url).catch(() => null);
      // Only a picture, whatever the address said.
      const named = withPictureExt(m.name, bytes);
      saved = named ? await store(key, named, bytes) : null;
    }
    done.set(key, saved);
    if (!saved && m.path && !result.off) result.failed.push(m.path);
    return saved;
  };

  for (const lesson of lessons) {
    const out: PlanBlock[] = [];
    for (const b of lesson.blocks) {
      if (b.type !== "media") { out.push(b); continue; }
      const f = await get(b);
      if (f) out.push({ id: "", type: "file", title: b.title, fileId: f.fileId, name: f.name, kind: f.kind, alt: b.alt });
      else if (b.url) out.push({ id: "", type: "link", title: b.title || b.alt || "Picture", url: b.url });
      else out.push({ id: "", type: "text", title: b.title, body: `[${b.alt || b.name}]` });
    }
    lesson.blocks = normalizeBlocks(out);
  }
  result.failed = [...new Set(result.failed)].slice(0, 200);
  return result;
}

/** The picture's name with an extension its bytes agree with, or null if it isn't a picture Learning keeps. */
function withPictureExt(name: string, bytes: Buffer | null): string | null {
  if (!bytes) return null;
  const stem = (name || "picture").replace(/\.[A-Za-z0-9]{1,8}$/, "") || "picture";
  for (const ext of ["png", "jpg", "gif", "webp"]) {
    const n = `${stem}.${ext}`;
    if (sniffFile(n, bytes)?.kind === "image") return n;
  }
  return null;
}

// ---------- a picture from the web, carefully ----------

/** Whether an address is one the internet can reach (not this machine, the private network or link-local). */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s)) return false;
    return true;
  }
  return false;
}

/**
 * DNS lookup that only ever hands the socket public addresses: the check and
 * the connection use the same answer, so a name can't change its address in
 * between (DNS rebinding).
 */
const publicLookup: net.LookupFunction = (host, opts, cb) => {
  dns.lookup(host, { all: true, verbatim: true }).then((all) => {
    const ok = all.filter((a) => isPublicAddress(a.address));
    if (!ok.length || ok.length !== all.length) { cb(Object.assign(new Error("not a public address"), { code: "EPUBLIC" }), "", 4); return; }
    if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, ok);
    else cb(null, ok[0].address, ok[0].family);
  }, (e) => cb(e, "", 4));
};

function getOnce(u: URL, signal: AbortSignal): Promise<{ status: number; location: string | null; body: Buffer | null }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(u, { lookup: publicLookup, signal, headers: { accept: "image/*", "user-agent": "SignifyLearning-import" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); resolve({ status, location: res.headers.location ?? null, body: null }); return; }
      if (status !== 200) { res.resume(); resolve({ status, location: null, body: null }); return; }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_FILE) { res.destroy(); resolve({ status, location: null, body: null }); return; }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > MAX_FILE) { res.destroy(); resolve({ status, location: null, body: null }); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status, location: null, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

/** A picture's bytes from the web, or null. */
export async function fetchPicture(raw: string): Promise<Buffer | null> {
  let url = raw;
  const signal = AbortSignal.timeout(10_000);
  for (let hop = 0; hop <= 5; hop++) {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    const bare = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(bare) ? !isPublicAddress(bare) : !bare.includes(".") || /\.(local|internal|localhost)$/i.test(bare)) return null;
    const got = await getOnce(u, signal);
    if (got.status >= 300 && got.status < 400) {
      if (!got.location) return null;
      url = new URL(got.location, u).toString();
      continue;
    }
    return got.body;
  }
  return null;
}
