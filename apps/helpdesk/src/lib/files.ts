import path from "path";
import fs from "fs/promises";
import { prisma } from "./db";

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "data", "uploads");
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 4;

/**
 * What an attachment is allowed to be.
 *
 * A closed list, and the type is decided by SNIFFING THE BYTES rather than by
 * believing the Content-Type the browser sent. Both matter:
 *
 *   * `file.type` is written by whatever posted the form, so it was never
 *     evidence of anything. The old check was `type.startsWith("image/")`,
 *     which accepted `image/svg+xml` — and an SVG is a document that can carry
 *     script. Served back inline from this origin, that is stored XSS in a
 *     help desk that school staff sign in to.
 *   * Sniffing also means a file that lies in the other direction — a PDF
 *     labelled as a JPEG — is stored under what it actually is, so the type
 *     sent back with it is always true.
 */
const SIGNATURES: { type: string; test: (b: Buffer) => boolean }[] = [
  { type: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/png", test: (b) => b.subarray(1, 4).toString("latin1") === "PNG" },
  { type: "image/gif", test: (b) => b.subarray(0, 3).toString("latin1") === "GIF" },
  {
    type: "image/webp",
    test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  { type: "application/pdf", test: (b) => b.subarray(0, 4).toString("latin1") === "%PDF" },
];

/** The real type of these bytes, or null if it is not one we accept. */
export function sniffType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  return SIGNATURES.find((s) => s.test(buffer))?.type ?? null;
}

/** Types safe to render in a browser tab. Everything else is downloaded. */
export const INLINE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

export function uploadPath(attachmentId: string) {
  return path.join(UPLOAD_DIR, attachmentId);
}

export async function saveAttachments(ticketId: number, files: File[]) {
  const usable = files.filter((f) => f.size > 0 && f.size <= MAX_FILE_BYTES).slice(0, MAX_FILES);
  if (usable.length === 0) return;
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  for (const file of usable) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const mimetype = sniffType(buffer);
    // Not a picture or a PDF, whatever it claimed to be. Skipped rather than
    // failing the whole submission — the ticket still matters.
    if (!mimetype) continue;
    const attachment = await prisma.attachment.create({
      data: {
        ticketId,
        filename: file.name || "photo",
        mimetype,
        size: buffer.length,
      },
    });
    await fs.writeFile(uploadPath(attachment.id), buffer);
  }
}
