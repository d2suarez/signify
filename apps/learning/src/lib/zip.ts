import zlib from "node:zlib";

/**
 * A small, strict zip reader for uploaded course exports. The file is
 * untrusted, so:
 *  - entry count, each entry's size and the total size are capped, both as
 *    the zip declares them and as they actually inflate (a zip bomb lies
 *    about its sizes; inflating stops at the cap whatever it says);
 *  - any name that could climb out of the archive (`..`, a leading `/`, a
 *    drive letter, a NUL) refuses the whole file;
 *  - encrypted entries and ZIP64 archives are refused;
 *  - nothing is ever written to disk, and an entry is only inflated when asked for.
 */

export const ZIP_LIMITS = {
  /** Entries in the archive (files and folders). */
  entries: 20_000,
  /** One entry, inflated. Pages and manifests are far smaller; media is never inflated. */
  entryBytes: 8 * 1024 * 1024,
  /** Everything inflated during one import. */
  totalInflated: 80 * 1024 * 1024,
  /** Everything the archive says it holds (media included, even though it is never read). */
  totalDeclared: 4 * 1024 * 1024 * 1024 - 1,
};

export class ZipError extends Error {}

export type ZipEntry = { name: string; method: number; compressed: number; size: number; offset: number };

/** A path inside the archive, or null if it could point outside it. */
export function safeEntryName(raw: string): string | null {
  const name = raw.replace(/\\/g, "/");
  if (!name || name.includes("\0")) return null;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  if (name.split("/").some((part) => part === "..")) return null;
  return name.replace(/^(\.\/)+/, "");
}

export class Zip {
  readonly entries = new Map<string, ZipEntry>();
  private inflated = 0;

  constructor(private readonly buf: Buffer, private readonly limits = ZIP_LIMITS) {
    const eocd = findEocd(buf);
    if (eocd < 0) throw new ZipError("not-zip");
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64");
    if (count > limits.entries) throw new ZipError("too-many-files");
    if (cdOffset + cdSize > buf.length) throw new ZipError("corrupt");

    let p = cdOffset;
    let declared = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("corrupt");
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const compressed = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const offset = buf.readUInt32LE(p + 42);
      if (p + 46 + nameLen > buf.length) throw new ZipError("corrupt");
      const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
      p += 46 + nameLen + extraLen + commentLen;

      if (flags & 0x1) throw new ZipError("encrypted");
      if (size === 0xffffffff || compressed === 0xffffffff || offset === 0xffffffff) throw new ZipError("zip64");
      const name = safeEntryName(rawName);
      if (name === null) throw new ZipError("unsafe-path");
      declared += size;
      if (declared > limits.totalDeclared) throw new ZipError("too-large");
      if (name.endsWith("/")) continue; // a folder
      if (!this.entries.has(name)) this.entries.set(name, { name, method, compressed, size, offset });
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The entry's bytes, or null if there is no such entry. Throws ZipError past a limit. */
  read(name: string): Buffer | null {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.size > this.limits.entryBytes) throw new ZipError("file-too-large");
    const b = this.buf;
    if (e.offset + 30 > b.length || b.readUInt32LE(e.offset) !== 0x04034b50) throw new ZipError("corrupt");
    const start = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28);
    const data = b.subarray(start, start + e.compressed);
    if (data.length !== e.compressed) throw new ZipError("corrupt");

    const room = Math.min(this.limits.entryBytes, this.limits.totalInflated - this.inflated);
    let out: Buffer;
    if (e.method === 0) {
      out = data;
    } else if (e.method === 8) {
      try {
        out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, room) });
      } catch (err) {
        const code = (err as { code?: string }).code;
        throw new ZipError(code === "ERR_BUFFER_TOO_LARGE" ? "too-large" : "corrupt");
      }
    } else {
      throw new ZipError("unsupported-compression");
    }
    // A size that disagrees with the directory is a damaged or doctored archive.
    if (out.length !== e.size) throw new ZipError(out.length > room ? "too-large" : "corrupt");
    this.inflated += out.length;
    if (this.inflated > this.limits.totalInflated) throw new ZipError("too-large");
    return out;
  }

  text(name: string): string | null {
    const b = this.read(name);
    return b === null ? null : b.toString("utf8").replace(/^﻿/, "");
  }
}

function findEocd(buf: Buffer): number {
  // The end record is at least 22 bytes and its comment at most 65,535.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}
