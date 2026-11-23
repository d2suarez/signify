import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";
import type { CourseRole } from "./courses";

/**
 * Files teachers add to a course (migration 021): a class resource or a
 * lesson's "file" block points at one by id.
 *
 * - What a file IS comes from its bytes (`sniffFile`), checked against its
 *   extension; anything not on the short list is refused (no SVG, HTML,
 *   scripts, programs or macro documents). The stored content type is ours,
 *   never the browser's.
 * - The bytes are encrypted here before they are stored (AES-256-GCM, a key
 *   derived from BACKUP_ENCRYPTION_KEY, the object's name as associated data
 *   so two objects can't be swapped). In production they go to the R2 bucket
 *   the database backups use, under `files/` (the backup's pruning only
 *   touches `learning/`); locally to data/files. On Railway with no R2 or no
 *   valid key, uploads are off: never a plaintext fallback.
 * - Who may open one is decided per request from live Signify ID classes
 *   (`canOpen`): a teacher of the course it was uploaded to, or anyone in a
 *   course of the same school whose lessons or resources use it (a student
 *   only where a lesson holds it or a visible resource shows it). Copying a
 *   lesson to another section keeps the file id, so this follows the copy.
 */

export type FileKind = "image" | "pdf" | "audio" | "video" | "doc";
export const FILE_KINDS: FileKind[] = ["image", "pdf", "audio", "video", "doc"];
export const MAX_FILE = 25 * 1024 * 1024;
/** For the file picker's accept list. */
export const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.pptx,.xlsx,.txt,.csv,.mp3,.m4a,.mp4";

export type CourseFile = {
  id: string; courseId: string | null; name: string; contentType: string; kind: FileKind; size: number; createdAt: string;
};

export class FileError extends Error {
  constructor(public code: "off" | "empty" | "too-large" | "type" | "teachers") { super(code); }
}

type Ctx = { tenantId: string; userId: string };
type Who = Ctx & { role: CourseRole };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- what a file is ----------

const OFFICE: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function starts(b: Buffer, bytes: number[] | string, at = 0): boolean {
  const want = typeof bytes === "string" ? Buffer.from(bytes, "latin1") : Buffer.from(bytes);
  return b.length >= at + want.length && b.subarray(at, at + want.length).equals(want);
}

/** A file name safe to show and send back: no folders, no control characters, ≤200 characters, extension kept. */
export function cleanName(raw: unknown): string {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= 200) return clean || "file";
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";
  return clean.slice(0, 200 - ext.length) + ext;
}

/**
 * What these bytes are, if they are something a class may share: the
 * extension must name the same thing the bytes start with. Null = refused.
 */
export function sniffFile(name: string, b: Buffer): { contentType: string; kind: FileKind } | null {
  if (!b.length) return null;
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "pdf": return starts(b, "%PDF-") ? { contentType: "application/pdf", kind: "pdf" } : null;
    case "png": return starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? { contentType: "image/png", kind: "image" } : null;
    case "jpg": case "jpeg": return starts(b, [0xff, 0xd8, 0xff]) ? { contentType: "image/jpeg", kind: "image" } : null;
    case "gif": return starts(b, "GIF87a") || starts(b, "GIF89a") ? { contentType: "image/gif", kind: "image" } : null;
    case "webp": return starts(b, "RIFF") && starts(b, "WEBP", 8) ? { contentType: "image/webp", kind: "image" } : null;
    case "docx": case "pptx": case "xlsx":
      // An Office Open XML package: a zip whose parts include [Content_Types].xml.
      // (.docm/.pptm/.xlsm, which can carry macros, are not on the list.)
      return starts(b, [0x50, 0x4b, 0x03, 0x04]) && b.includes("[Content_Types].xml")
        && !b.includes("vbaProject.bin") ? { contentType: OFFICE[ext], kind: "doc" } : null;
    case "mp3": return starts(b, "ID3") || (b[0] === 0xff && b.length > 1 && (b[1] & 0xe0) === 0xe0) ? { contentType: "audio/mpeg", kind: "audio" } : null;
    case "m4a": return starts(b, "ftyp", 4) ? { contentType: "audio/mp4", kind: "audio" } : null;
    case "mp4": return starts(b, "ftyp", 4) ? { contentType: "video/mp4", kind: "video" } : null;
    case "txt": case "csv": {
      if (b.includes(0)) return null;
      try { new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; }
      return { contentType: `${ext === "csv" ? "text/csv" : "text/plain"}; charset=utf-8`, kind: "doc" };
    }
    default: return null;
  }
}

// ---------- encryption ----------

const MAGIC = Buffer.from("SIGNIFY-LFILE-01");
const onRailway = () => !!process.env.RAILWAY_ENVIRONMENT;

/** The files key, derived from the backup key (never the same bytes). Locally, a fixed development key. */
function filesKey(): Buffer | null {
  const hex = String(process.env.BACKUP_ENCRYPTION_KEY || "").trim();
  const base = /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, "hex")
    : onRailway() ? null : crypto.createHash("sha256").update("signify-learning-local-files").digest();
  return base ? Buffer.from(crypto.hkdfSync("sha256", base, Buffer.alloc(0), "signify-learning-files v1", 32)) : null;
}

export function sealFile(plain: Buffer, objectKey: string, key = filesKey()): Buffer {
  if (!key) throw new FileError("off");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(objectKey));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}

export function openFile(sealed: Buffer, objectKey: string, key = filesKey()): Buffer {
  if (!key || !sealed.subarray(0, 16).equals(MAGIC) || sealed.length < 16 + 12 + 16) throw new Error("not a sealed file");
  const iv = sealed.subarray(16, 28);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(objectKey));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(28, sealed.length - 16)), d.final()]);
}

// ---------- where the bytes live ----------

export type FileStore = {
  name: string;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  del(key: string): Promise<void>;
};

export function memoryStore(): FileStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    name: "memory", objects,
    async put(k, b) { objects.set(k, Buffer.from(b)); },
    async get(k) { return objects.get(k) ?? null; },
    async del(k) { objects.delete(k); },
  };
}

export function dirStore(dir: string): FileStore {
  const where = (k: string) => {
    const p = path.resolve(dir, k);
    if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error("bad key");
    return p;
  };
  return {
    name: `folder ${dir}`,
    async put(k, b) { fs.mkdirSync(path.dirname(where(k)), { recursive: true }); fs.writeFileSync(where(k), b); },
    async get(k) { try { return fs.readFileSync(where(k)); } catch { return null; } },
    async del(k) { fs.rmSync(where(k), { force: true }); },
  };
}

export type R2Config = { endpoint: string; bucket: string; keyId: string; secret: string; region?: string };

/** S3 (R2) with SigV4, as offsite.js signs it, but over fetch and with bytes kept as bytes. */
export function r2Store(cfg: R2Config): FileStore {
  const region = cfg.region || "auto";
  const hmac = (k: crypto.BinaryLike, s: string) => crypto.createHmac("sha256", k).update(s).digest();
  const hash = (b: crypto.BinaryLike) => crypto.createHash("sha256").update(b).digest("hex");
  const enc = (s: string) => s.replace(/[^A-Za-z0-9\-._~/]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  async function send(method: "GET" | "PUT" | "DELETE", key: string, body?: Buffer): Promise<Response> {
    const url = new URL(`${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}/${key}`);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    const payloadHash = hash(body ?? Buffer.alloc(0));
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    if (body) headers["content-type"] = "application/octet-stream";
    const names = Object.keys(headers).sort();
    const canonical = [method, enc(url.pathname), "", names.map((h) => `${h}:${headers[h].trim()}\n`).join(""), names.join(";"), payloadHash].join("\n");
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hash(canonical)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secret}`, day), region), "s3"), "aws4_request");
    const sig = crypto.createHmac("sha256", signingKey).update(toSign).digest("hex");
    const { host: _host, ...send } = headers;
    void _host;
    return fetch(url, {
      method,
      headers: { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.keyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` },
      body: body ? new Uint8Array(body) : undefined,
    });
  }
  return {
    name: `R2 ${url(cfg)}`,
    async put(k, b) { const r = await send("PUT", k, b); if (!r.ok) throw new Error(`file store PUT ${r.status}: ${(await r.text()).slice(0, 200)}`); },
    async get(k) {
      const r = await send("GET", k);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`file store GET ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async del(k) { const r = await send("DELETE", k); if (!r.ok && r.status !== 404) throw new Error(`file store DELETE ${r.status}`); },
  };
}
const url = (c: R2Config) => `${c.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/${c.bucket}/files/`;

let chosen: FileStore | null | undefined;
/** Tests (and nothing else) set the store. */
export function useFileStore(s: FileStore | null) { chosen = s; }

/** Where files go now, or null when uploads are off (on Railway without R2 or a valid key). */
export function fileStore(): FileStore | null {
  if (chosen !== undefined) return chosen;
  const e = process.env;
  const endpoint = e.R2_ENDPOINT || (e.R2_ACCOUNT_ID ? `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
  if (endpoint && e.R2_BUCKET && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY && filesKey()) {
    chosen = r2Store({ endpoint, bucket: e.R2_BUCKET, keyId: e.R2_ACCESS_KEY_ID, secret: e.R2_SECRET_ACCESS_KEY, region: e.R2_REGION });
  } else if (!onRailway()) {
    chosen = dirStore(e.LEARNING_FILES_DIR || path.join(process.cwd(), "data", "files"));
  } else {
    chosen = null;
  }
  return chosen;
}

export const uploadsOn = () => !!fileStore() && !!filesKey();

// ---------- the course's files ----------

function toFile(r: Record<string, unknown>): CourseFile {
  return {
    id: String(r.id), courseId: r.course_id ? String(r.course_id) : null, name: String(r.name), contentType: String(r.content_type),
    kind: r.kind as FileKind, size: Number(r.size),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

const objectKey = (tenantId: string, id: string) => `files/${tenantId.replace(/[^A-Za-z0-9_-]/g, "_")}/${id}`;

/**
 * Stores a teacher's upload for this course. Throws FileError for anything
 * refused. `courseId` null = a picture or file for a whole-school update
 * (the caller has checked the person may post to the whole school).
 */
export async function saveFile(who: Who, courseId: string | null, rawName: unknown, bytes: Buffer): Promise<CourseFile> {
  if (who.role !== "teacher") throw new FileError("teachers");
  const store = fileStore();
  const key = filesKey();
  if (!store || !key) throw new FileError("off");
  if (!bytes.length) throw new FileError("empty");
  if (bytes.length > MAX_FILE) throw new FileError("too-large");
  const name = cleanName(rawName);
  const what = sniffFile(name, bytes);
  if (!what) throw new FileError("type");
  const id = crypto.randomUUID();
  const k = objectKey(who.tenantId, id);
  await store.put(k, sealFile(bytes, k, key));
  const db = await getDb();
  const rows = await db.query(
    `INSERT INTO course_files (id, tenant_id, course_id, name, content_type, kind, size, sha256, storage_key, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [id, who.tenantId, courseId, name, what.contentType, what.kind, bytes.length,
      crypto.createHash("sha256").update(bytes).digest("hex"), k, who.userId],
  );
  return toFile(rows[0]);
}

/** A file of this school, whoever may see it (callers check `canOpen`). */
export async function getFile(tenantId: string, id: string): Promise<(CourseFile & { storageKey: string; uploadedBy: string }) | null> {
  if (!UUID.test(id)) return null;
  const db = await getDb();
  const rows = await db.query("SELECT * FROM course_files WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
  return rows[0] ? { ...toFile(rows[0]), storageKey: String(rows[0].storage_key), uploadedBy: String(rows[0].uploaded_by) } : null;
}

/** The file's bytes, decrypted. Null if the store has lost them or is off. */
export async function fileBytes(f: { storageKey: string }): Promise<Buffer | null> {
  const store = fileStore();
  if (!store) return null;
  const sealed = await store.get(f.storageKey);
  return sealed ? openFile(sealed, f.storageKey) : null;
}

/**
 * May this person open the file? `roleIn` answers, from live Signify ID
 * classes, how they relate to a course (null = not in it). A teacher: of the
 * course it was uploaded to, or of any course using it. A student: of a
 * course where a lesson holds it or a resource showing to students is it.
 */
export async function canOpen(
  tenantId: string, file: { id: string; courseId: string | null; uploadedBy?: string },
  roleIn: (courseId: string) => Promise<CourseRole | null>,
  /** Updates: who is asking, and whether they may read a post in a place (null = the whole school). */
  posts?: { userId: string; reads: (courseId: string | null) => boolean },
): Promise<boolean> {
  if (posts && file.uploadedBy && file.uploadedBy === posts.userId) return true;
  if (file.courseId && (await roleIn(file.courseId)) === "teacher") return true;
  const db = await getDb();
  if (posts) {
    // A picture or file shown in a visible update its reader can see.
    const shown = await db.query(
      "SELECT DISTINCT course_id FROM posts WHERE tenant_id = $1 AND status = 'visible' AND $2::uuid = ANY(file_ids)",
      [tenantId, file.id],
    );
    if (shown.some((r) => posts.reads(r.course_id ? String(r.course_id) : null))) return true;
  }
  if (!file.courseId) return false;
  const [res, les, asg] = await Promise.all([
    db.query(
      `SELECT course_id, bool_or(visible AND NOT archived) AS shown FROM class_resources
        WHERE tenant_id = $1 AND kind = 'block' AND block->>'type' = 'file' AND block->>'fileId' = $2 GROUP BY course_id`,
      [tenantId, file.id],
    ),
    db.query(
      "SELECT DISTINCT course_id FROM lessons WHERE tenant_id = $1 AND archived = false AND blocks @> $2::jsonb",
      [tenantId, JSON.stringify([{ type: "file", fileId: file.id }])],
    ),
    // Rich assignment instructions (migration 028): students once it's published.
    db.query(
      `SELECT course_id, bool_or(published) AS shown FROM assignments
        WHERE tenant_id = $1 AND archived = false AND instructions_doc->'nodes' @> $2::jsonb GROUP BY course_id`,
      [tenantId, JSON.stringify([{ type: "file", fileId: file.id }])],
    ),
  ]);
  const studentOk = new Set([
    ...res.filter((r) => r.shown === true).map((r) => String(r.course_id)), ...les.map((r) => String(r.course_id)),
    ...asg.filter((r) => r.shown === true).map((r) => String(r.course_id)),
  ]);
  const courses = new Set([...res.map((r) => String(r.course_id)), ...les.map((r) => String(r.course_id)), ...asg.map((r) => String(r.course_id))]);
  const own = file.courseId;
  courses.delete(own);
  if (studentOk.has(own) && (await roleIn(own)) === "student") return true;
  for (const c of courses) {
    const role = await roleIn(c);
    if (role === "teacher" || (role === "student" && studentOk.has(c))) return true;
  }
  return false;
}

/** Whether a file id is one of this school's files (resources keep a file block's id only then). */
export async function fileInSchool(tenantId: string, id: string): Promise<boolean> {
  return !!(await getFile(tenantId, id));
}
