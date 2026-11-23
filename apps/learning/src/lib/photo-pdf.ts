/**
 * A student's photos as ONE PDF, a page per photo in their order (story 01
 * A7: the workbook-grading skill grades one PDF per student). No library:
 * a JPEG goes into a PDF as it is (DCTDecode), and a plain PNG (8-bit grey
 * or RGB, not interlaced, no transparency) as its own compressed rows
 * (FlateDecode with the PNG predictor). Anything else is left out and
 * counted, never guessed at. Pure: bytes in, bytes out.
 */

type Img = { w: number; h: number; filter: string; colors: 1 | 3 | 4; data: Buffer; parms?: string };

export function jpegInfo(b: Buffer): { w: number; h: number; colors: 1 | 3 | 4 } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = b.readUInt16BE(i + 5), w = b.readUInt16BE(i + 7), n = b[i + 9];
      if (!w || !h || (n !== 1 && n !== 3 && n !== 4)) return null;
      return { w, h, colors: n as 1 | 3 | 4 };
    }
    if (m === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

function pngImage(b: Buffer): Img | null {
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), depth = b[24], type = b[25], interlace = b[28];
  if (depth !== 8 || interlace !== 0 || (type !== 0 && type !== 2)) return null;
  const parts: Buffer[] = [];
  let i = 8;
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i), kind = b.toString("latin1", i + 4, i + 8);
    if (i + 12 + len > b.length) return null;
    if (kind === "tRNS") return null;
    if (kind === "IDAT") parts.push(b.subarray(i + 8, i + 8 + len));
    if (kind === "IEND") break;
    i += 12 + len;
  }
  if (!parts.length || !w || !h) return null;
  const colors = type === 2 ? 3 : 1;
  return { w, h, filter: "FlateDecode", colors, data: Buffer.concat(parts), parms: `<< /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${w} >>` };
}

function image(b: Buffer): Img | null {
  const j = jpegInfo(b);
  if (j) return { ...j, filter: "DCTDecode", data: b };
  return pngImage(b);
}

/** Letter pages (portrait or landscape to suit each photo), the photo fitted inside a small margin. */
export function photosPdf(photos: Buffer[], title = "Photos"): { bytes: Buffer; pages: number; skipped: number } {
  const imgs = photos.map(image);
  const used = imgs.filter((x): x is Img => !!x);
  const objs: Buffer[] = [];
  const add = (b: Buffer | string) => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1")); return objs.length; };
  // 1 catalog, 2 pages: filled in at the end.
  add(""); add("");
  const kids: number[] = [];
  for (const img of used) {
    const land = img.w > img.h;
    const pw = land ? 792 : 612, ph = land ? 612 : 792, m = 18;
    const s = Math.min((pw - 2 * m) / img.w, (ph - 2 * m) / img.h);
    const dw = img.w * s, dh = img.h * s, x = (pw - dw) / 2, y = (ph - dh) / 2;
    const cs = img.colors === 1 ? "/DeviceGray" : img.colors === 4 ? "/DeviceCMYK" : "/DeviceRGB";
    // An Adobe CMYK JPEG is stored inverted; Decode turns it back.
    const decode = img.colors === 4 && img.filter === "DCTDecode" ? " /Decode [1 0 1 0 1 0 1 0]" : "";
    const imgNo = add(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace ${cs} /BitsPerComponent 8${decode} /Filter /${img.filter}${img.parms ? ` /DecodeParms ${img.parms}` : ""} /Length ${img.data.length} >>\nstream\n`, "latin1"),
      img.data, Buffer.from("\nendstream", "latin1"),
    ]));
    const draw = `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;
    const contentNo = add(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${imgNo} 0 R >> >> /Contents ${contentNo} 0 R >>`));
  }
  // UTF-16BE with a byte order mark, as hex: any name, nothing to escape.
  const utf16 = Buffer.from(title.slice(0, 200), "utf16le").swap16().toString("hex");
  const infoNo = add(`<< /Title <FEFF${utf16}> /Producer (Signify Learning) >>`);
  objs[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1");
  objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`, "latin1");
  const out: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let at = out[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(at);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), o, Buffer.from("\nendobj\n", "latin1")]);
    out.push(b); at += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  out.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoNo} 0 R >>\nstartxref\n${at}\n%%EOF\n`, "latin1"));
  return { bytes: Buffer.concat(out), pages: kids.length, skipped: photos.length - used.length };
}
