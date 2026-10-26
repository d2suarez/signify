// ===================================================================
// Widget — Convert
//
// Three everyday file jobs, done ENTIRELY in the teacher's browser:
//
//   Pictures     JPG / PNG / WebP / iPhone HEIC in, JPG / PNG / WebP out,
//                optionally smaller; or all of them as one PDF.
//   PDF tools    join PDFs, pick or reorder pages, turn them, split into a
//                PDF per page, save pages as pictures, or pull out the
//                pictures inside.
//   PDF → Word   the words, paragraphs and headings as a .docx — not the
//                layout. For layout (or a scanned page) it points at Google
//                Drive, which does that job better than anything free.
//
// Nothing is uploaded and nothing is saved to the board: a worksheet with
// pupils' names on it never leaves the computer, it costs the server nothing,
// and the tool works for visitors too. Files live in memory, per card, for
// the life of the page (the same pattern as the word count), so opening the
// expanded view keeps the queue. Only the settings are state.
//
// The libraries are open source and served from /vendor, loaded only the
// first time they are needed:
//   pdf-lib  (MIT)        building PDFs              /vendor/pdf-lib.min.js
//   pdf.js   (Apache-2.0) reading text and pictures  /vendor/pdfjs/
//   heic-to  (LGPL-3.0)   iPhone photos, its CSP-safe build /vendor/heic/
// heic-to runs a worker from a blob of its own code, which is why the CSP has
// `worker-src 'self' blob:`. Safari reads HEIC natively and never loads it.
//
// The .zip and .docx writers are our own, small and tested: a zip with
// stored (uncompressed) entries is valid everywhere, and the files inside
// these — JPEGs, PNGs, PDFs — are already compressed.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon } = Desk;
  const toast = (...a) => (Desk.toast ? Desk.toast(...a) : null);

  // ---------------------------------------------------------------
  // Pure helpers (exported at the bottom for the tests)
  // ---------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const utf8 = (s) => new TextEncoder().encode(String(s));

  /**
   * A zip archive with stored entries, as a list of byte chunks (hand them
   * straight to a Blob). files: [{ name, data: Uint8Array }].
   */
  function zipParts(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    // A fixed, valid DOS date (1 Jan 2020, midnight); the archive is made
    // and opened in the same minute, and nobody reads these.
    const dosTime = 0;
    const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;

    for (const f of files) {
      const name = utf8(f.name);
      const data = f.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);              // version needed
      lv.setUint16(6, 0x0800, true);          // names are UTF-8
      lv.setUint16(8, 0, true);               // stored
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      parts.push(local, data);

      const cen = new Uint8Array(46 + name.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);              // made by
      cv.setUint16(6, 20, true);              // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cen.set(name, 46);
      central.push(cen);

      offset += local.length + data.length;
    }

    const cenSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cenSize, true);
    ev.setUint32(16, offset, true);
    return parts.concat(central, [end]);
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  const zip = (files) => concat(zipParts(files));

  /** Text that is safe inside a Word XML text node — Word refuses the whole file otherwise. */
  function xmlText(s) {
    return String(s)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * The files of a .docx. blocks: [{ text, heading: 0|1|2 } | { pageBreak: true }].
   * Order matters: [Content_Types].xml first.
   */
  function docxFiles(blocks, title) {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const body = blocks.map((b) => {
      if (b.pageBreak) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      const style = b.heading ? `<w:pPr><w:pStyle w:val="Heading${b.heading}"/></w:pPr>` : '';
      return `<w:p>${style}<w:r><w:t xml:space="preserve">${xmlText(b.text)}</w:t></w:r></w:p>`;
    }).join('');

    const files = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        + '</Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        + '</Relationships>',
      'docProps/core.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
        + `<dc:title>${xmlText(title || '')}</dc:title></cp:coreProperties>`,
      'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + '</Relationships>',
      'word/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<w:styles ${W}>`
        + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
        + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
        + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
        + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        + '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
        + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
        + '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>'
        + '</w:styles>',
      'word/document.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<w:document ${W}><w:body>${body || '<w:p/>'}`
        + '<w:sectPr><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
        + '</w:body></w:document>',
    };
    return Object.entries(files).map(([name, xml]) => ({ name, data: utf8(xml) }));
  }

  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  /**
   * pdf.js text items for ONE page → paragraphs.
   *
   * items: [{ str, transform: [a,b,c,d,x,y], width, height, hasEOL }]. PDF y
   * runs UP the page. Lines are items sharing a baseline; paragraphs are
   * lines closer together than the usual leading, of the same size. A line
   * noticeably larger than the body text, and short, is a heading.
   *
   * Returns [{ text, heading: 0|1|2 }].
   */
  function paragraphs(items) {
    const lines = [];
    let cur = null;

    for (const it of items || []) {
      if (!it || typeof it.str !== 'string') continue;
      const t = it.transform || [1, 0, 0, 1, 0, 0];
      const size = Math.abs(it.height) || Math.hypot(t[2], t[3]) || 10;
      const x = t[4];
      const y = t[5];
      const w = it.width || 0;

      if (it.str) {
        const sameLine = cur && !cur.ended && Math.abs(y - cur.y) <= Math.max(cur.size, size) * 0.5;
        if (sameLine) {
          const gap = x - cur.right;
          if (gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
          cur.text += it.str;
          cur.right = Math.max(cur.right, x + w);
          if (it.str.trim()) cur.size = Math.max(cur.size, size);
        } else {
          cur = { text: it.str, x, y, size, right: x + w, ended: false };
          lines.push(cur);
        }
      }
      if (it.hasEOL && cur) cur.ended = true;
    }

    const kept = lines
      .map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
      .filter((l) => l.text);
    if (!kept.length) return [];

    // Body size: the size most of the TEXT is set in, weighted by length.
    const weighted = [];
    for (const l of kept) for (let i = 0; i < Math.min(l.text.length, 200); i += 4) weighted.push(l.size);
    const body = median(weighted) || 10;
    const headingOf = (l) => {
      if (l.text.length > 150) return 0;
      if (l.size >= body * 1.5) return 1;
      if (l.size >= body * 1.18) return 2;
      return 0;
    };

    const gaps = [];
    for (let i = 1; i < kept.length; i += 1) {
      const g = kept[i - 1].y - kept[i].y;
      if (g > 0 && g < body * 3) gaps.push(g);
    }
    const lead = median(gaps) || body * 1.2;
    const widest = Math.max(...kept.map((l) => l.right - l.x));
    const listStart = /^([•▪◦●○■□\-–*]|\(?[0-9]{1,3}[.)]|\(?[a-zA-Z][.)])\s/;

    const out = [];
    let para = null;
    for (let i = 0; i < kept.length; i += 1) {
      const l = kept[i];
      const h = headingOf(l);
      const prev = kept[i - 1];
      let fresh = !para || h || para.heading;
      if (!fresh) {
        const gap = prev.y - l.y;
        const shortEnd = (prev.right - prev.x) < widest * 0.7 && /[.!?:;]["'”’)]?$/.test(prev.text);
        fresh = gap <= 0                              // went back up: a new column
          || gap > lead * 1.45 + 0.5                  // a blank line's worth of space
          || Math.abs(l.size - para.size) > body * 0.15
          || shortEnd
          || listStart.test(l.text);
      }
      if (fresh) {
        para = { text: l.text, heading: h, size: l.size };
        out.push(para);
      } else if (/[A-Za-z]-$/.test(para.text) && /^[a-z]/.test(l.text)) {
        para.text = para.text.slice(0, -1) + l.text;   // a word broken across lines
      } else {
        para.text += ` ${l.text}`;
      }
    }
    return out.map(({ text, heading }) => ({ text, heading }));
  }

  /**
   * "1-3, 5, 8-" → zero-based page indexes, in the order written. Blank or
   * "all" is every page. A backwards range ("5-3") runs backwards, so pages
   * can be reordered. Repeats are allowed (two copies of a page).
   * Returns { pages } or { error } in words a teacher can act on.
   */
  function ranges(text, n) {
    const t = String(text || '').trim().toLowerCase();
    if (!n) return { error: 'There are no pages yet.' };
    if (!t || t === 'all') return { pages: Array.from({ length: n }, (_, i) => i) };
    const pages = [];
    for (const raw of t.split(/[,;\s]+/).filter(Boolean)) {
      const tok = raw.replace(/[–—]/g, '-');
      const m = tok.match(/^(\d*)-(\d*)$/);
      let a;
      let b;
      if (/^\d+$/.test(tok)) { a = b = parseInt(tok, 10); }
      else if (m && (m[1] || m[2])) { a = m[1] ? parseInt(m[1], 10) : 1; b = m[2] ? parseInt(m[2], 10) : n; }
      else return { error: `"${raw}" is not a page or a range — try something like 1-3, 5, 8-` };
      for (const p of [a, b]) {
        if (p < 1) return { error: 'Pages start at 1.' };
        if (p > n) return { error: `There is no page ${p}: there ${n === 1 ? 'is 1 page' : `are ${n} pages`}.` };
      }
      const step = a <= b ? 1 : -1;
      for (let p = a; step > 0 ? p <= b : p >= b; p += step) pages.push(p - 1);
    }
    return { pages };
  }

  /** Which file, and which page within it, combined page i belongs to. */
  function locate(counts, i) {
    let left = i;
    for (let f = 0; f < counts.length; f += 1) {
      if (left < counts[f]) return { file: f, page: left };
      left -= counts[f];
    }
    return null;
  }

  /** Longest side no more than max; never enlarges. max 0 = as it is. */
  function fit(w, h, max) {
    if (!max || (w <= max && h <= max)) return { w, h };
    const k = max / Math.max(w, h);
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  function outName(name, ext) {
    const base = String(name || 'file').replace(/\.[a-z0-9]{1,5}$/i, '') || 'file';
    return `${base}.${ext}`;
  }

  /** Names made unique in place, the way a desktop does it: "a.jpg", "a (2).jpg". */
  function uniqueNames(names) {
    const seen = new Map();
    return names.map((n) => {
      const key = n.toLowerCase();
      const k = (seen.get(key) || 0) + 1;
      seen.set(key, k);
      if (k === 1) return n;
      const m = n.match(/^(.*?)(\.[^.]+)?$/);
      return `${m[1]} (${k})${m[2] || ''}`;
    });
  }

  function isHeic(file, head) {
    if (/\.(heic|heif)$/i.test(file.name || '') || /heic|heif/i.test(file.type || '')) return true;
    if (!head || head.length < 12) return false;
    const brand = String.fromCharCode(...head.slice(8, 12));
    return /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand);
  }

  /** A decoded pdf.js image (kind 1 = 1-bit grey, 2 = RGB, 3 = RGBA) → RGBA bytes. */
  function toRGBA(kind, data, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    if (kind === 3) { out.set(data.subarray ? data.subarray(0, out.length) : data.slice(0, out.length)); return out; }
    if (kind === 2) {
      for (let i = 0, j = 0; j < out.length; i += 3, j += 4) {
        out[j] = data[i]; out[j + 1] = data[i + 1]; out[j + 2] = data[i + 2]; out[j + 3] = 255;
      }
      return out;
    }
    if (kind === 1) {
      const rowBytes = (w + 7) >> 3;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const j = (y * w + x) * 4;
          out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
        }
      }
      return out;
    }
    return null;
  }

  function bytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  // ---------------------------------------------------------------
  // Libraries, loaded on first use
  // ---------------------------------------------------------------

  const libs = {};

  function once(key, make) {
    if (!libs[key]) libs[key] = make().catch((e) => { delete libs[key]; throw e; });
    return libs[key];
  }

  function script(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load a part of the converter. Check the connection and try again.'));
      document.head.append(s);
    });
  }

  const pdfLib = () => once('pdflib', async () => {
    if (!window.PDFLib) await script('/vendor/pdf-lib.min.js');
    return window.PDFLib;
  });

  const pdfjs = () => once('pdfjs', async () => {
    const m = await import('/vendor/pdfjs/pdf.min.mjs');
    m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return m;
  });

  const heicLib = () => once('heic', () => import('/vendor/heic/heic-to.min.js'));

  async function openPdfjs(data) {
    const lib = await pdfjs();
    return lib.getDocument({
      data: data.slice(),                 // pdf.js takes ownership of what it is given
      isEvalSupported: false,             // the CSP refuses eval; do not even try
      useWasm: false,                     // ...and WebAssembly; the JS decoders are used
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      enableXfa: false,
    }).promise;
  }

  /** Frees pdf.js's worker-side copy. Never throws: it runs in finally blocks. */
  function closePdf(doc) {
    try {
      const done = doc.loadingTask ? doc.loadingTask.destroy() : doc.destroy();
      if (done && done.catch) done.catch(() => {});
    } catch (_) { /* already gone */ }
  }

  function pdfError(e) {
    const name = (e && e.name) || '';
    if (/Password/i.test(name) || /encrypt|password/i.test(String(e && e.message))) return 'This PDF is password-protected.';
    if (/InvalidPDF/i.test(name)) return 'This does not look like a PDF, or it is damaged.';
    return (e && e.message) || 'Something went wrong reading this PDF.';
  }

  // ---------------------------------------------------------------
  // Browser-side work
  // ---------------------------------------------------------------

  function download(blob, name) {
    const href = URL.createObjectURL(blob);
    const a = el('a', { href, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    // Freed later; revoking immediately can beat the download.
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  }

  async function downloadAll(outs, zipName) {
    if (!outs.length) return;
    if (outs.length === 1) { download(outs[0].blob, outs[0].name); return; }
    const names = uniqueNames(outs.map((o) => o.name));
    const files = [];
    for (let i = 0; i < outs.length; i += 1) {
      files.push({ name: names[i], data: new Uint8Array(await outs[i].blob.arrayBuffer()) });
    }
    download(new Blob(zipParts(files), { type: 'application/zip' }), zipName);
  }

  /** Anything the browser can show → something drawImage takes, with its size. */
  async function decode(file) {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    try {
      const bmp = await createImageBitmap(file);
      return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch (_) { /* fall through */ }

    if (isHeic(file, head)) {
      const { heicTo } = await heicLib();
      const bmp = await heicTo({ blob: file, type: 'bitmap' });
      return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    }

    // SVG and a few others decode through an <img> but not createImageBitmap.
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('This browser cannot read this kind of picture.'));
        i.src = url;
      });
      const w = img.naturalWidth || 1024;
      const h = img.naturalHeight || 1024;
      return { src: img, w, h, close: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  function canvasBlob(canvas, type, q) {
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the picture.'))), type, q));
  }

  /** Draw at a size; JPEG has no transparency, so it gets a white page under it. */
  function draw(pic, size, type) {
    const c = document.createElement('canvas');
    c.width = size.w;
    c.height = size.h;
    const g = c.getContext('2d');
    if (type === 'image/jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); }
    g.imageSmoothingQuality = 'high';
    g.drawImage(pic.src, 0, 0, size.w, size.h);
    return c;
  }

  const FORMATS = {
    jpeg: { type: 'image/jpeg', ext: 'jpg', label: 'JPG' },
    png: { type: 'image/png', ext: 'png', label: 'PNG' },
    webp: { type: 'image/webp', ext: 'webp', label: 'WebP' },
  };
  const SIZES = [[0, 'Same size'], [2400, 'Large · 2400 px'], [1600, 'Medium · 1600 px'], [1024, 'Small · 1024 px'], [640, 'Tiny · 640 px']];
  const SHARPNESS = [[1.5, 'Screen'], [2.5, 'Print'], [4, 'Sharpest']];
  const PAPER = { letter: [612, 792], a4: [595.28, 841.89] };

  // In-memory work, per card (see the header). Never saved.
  const sessions = new Map();
  let seq = 0;

  function sessionFor(key) {
    if (!sessions.has(key)) {
      sessions.set(key, { pics: [], picGen: 0, pdfs: [], pdfOut: [], pdfRun: 0, words: [], pages: '', busy: '', listeners: new Set() });
    }
    return sessions.get(key);
  }

  Desk.widget({
    type: 'convert',
    added: '2026-10-07',
    news: 'Turn iPhone photos into JPGs, join or split PDFs, and turn a PDF into Word — right in the browser.',
    name: 'Convert',
    blurb: 'Change picture formats (iPhone HEIC too), join and split PDFs, save PDF pages or their pictures, and turn a PDF into a Word document. Files never leave this computer.',
    icon: 'convert',
    category: 'other',
    students: true,
    role: 'p4',
    guest: true,                   // holds no files and calls no API — everything runs in this browser
    fills: true,
    tone: 'card',
    size: { w: 5, h: 7 },
    min: { w: 4, h: 5 },

    init(s) {
      if (!['pics', 'pdf', 'word'].includes(s.tab)) s.tab = 'pics';
      if (!FORMATS[s.fmt]) s.fmt = 'jpeg';
      if (!(s.q >= 0.4 && s.q <= 1)) s.q = 0.85;
      if (!SIZES.some(([v]) => v === s.max)) s.max = 0;
      if (!['letter', 'a4'].includes(s.paper)) {
        s.paper = /^en-(US|CA)$|^es-(MX|US)$|^fr-CA$/.test((typeof navigator !== 'undefined' && navigator.language) || '') ? 'letter' : 'a4';
      }
      if (!['pdf', 'render', 'images'].includes(s.task)) s.task = 'pdf';
      if (![0, 90, 180, 270].includes(s.rotate)) s.rotate = 0;
      if (typeof s.split !== 'boolean') s.split = false;
      if (!SHARPNESS.some(([v]) => v === s.sharp)) s.sharp = 2.5;
      if (!['png', 'jpeg'].includes(s.renderFmt)) s.renderFmt = 'png';
    },

    mount(ctx) {
      const s = ctx.state;
      const key = (ctx.item && ctx.item.id) || 'x';
      const S = sessionFor(key);

      const root = el('div.cv');
      ctx.root.append(root);

      // Async work finishes after a remount sometimes (card → expanded view);
      // every mounted copy repaints from the shared session.
      const repaint = () => paintBody();
      S.listeners.add(repaint);
      const changed = () => S.listeners.forEach((f) => f());

      const seg = (options, current, onPick, cls = '') => el(`div.seg${cls}`, {}, options.map(([v, label]) =>
        el('button.seg-btn' + (v === current ? '.is-on' : ''), { type: 'button', text: label, onclick: () => onPick(v) })));

      const tabs = el('div.cv-tabs');
      const body = el('div.cv-body');
      root.append(tabs, body);

      function paintTabs() {
        Desk.clear(tabs);
        tabs.append(seg([['pics', 'Pictures'], ['pdf', 'PDF tools'], ['word', 'PDF → Word']], s.tab, (v) => {
          s.tab = v; ctx.save(); paintTabs(); paintBody();
        }));
      }

      /** A drop zone with a hidden file picker inside it. */
      function dropZone(label, accept, onFiles) {
        const input = el('input', { type: 'file', accept, multiple: true, hidden: true, onchange: () => { onFiles([...input.files]); input.value = ''; } });
        const zone = el('label.cv-drop', {
          ondragover: (e) => { e.preventDefault(); zone.classList.add('is-over'); },
          ondragleave: () => zone.classList.remove('is-over'),
          ondrop: (e) => {
            e.preventDefault();
            zone.classList.remove('is-over');
            onFiles([...((e.dataTransfer && e.dataTransfer.files) || [])]);
          },
        }, [input, el('span.cv-drop-icon', { svg: icon('upload', 18) }), el('span', { text: label })]);
        return zone;
      }

      function row(name, detail, actions, kind = '') {
        return el(`div.cv-row${kind ? `.is-${kind}` : ''}`, {}, [
          el('div.cv-row-text', {}, [el('div.cv-name', { text: name, title: name }), el('div.cv-detail', { text: detail })]),
          el('div.cv-row-actions', {}, actions.filter(Boolean)),
        ]);
      }

      const smallBtn = (label, onclick, opts = {}) => el('button.btn.btn--small' + (opts.primary ? '.btn--primary' : ''), {
        type: 'button', onclick, disabled: !!opts.disabled, title: opts.title || null, 'aria-label': opts.aria || null,
        svg: opts.icon ? icon(opts.icon, 14) : null,
      }, opts.icon && label ? ` ${label}` : (opts.icon ? null : label));

      function paintBody() {
        Desk.clear(body);
        if (s.tab === 'pics') paintPics();
        else if (s.tab === 'pdf') paintPdf();
        else paintWord();
      }

      // =============================================================
      // Pictures
      // =============================================================

      function addPics(files) {
        const fresh = files.filter((f) => /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp|gif|bmp|svg|avif|tiff?)$/i.test(f.name));
        if (fresh.length < files.length) toast(`${files.length - fresh.length} file${files.length - fresh.length === 1 ? ' was' : 's were'} not a picture.`, 'warn');
        for (const file of fresh) S.pics.push({ id: ++seq, file, status: 'waiting' });
        if (fresh.length) convertPics();
        changed();
      }

      async function convertPics() {
        const gen = ++S.picGen;
        const fmt = FORMATS[s.fmt];
        for (const p of S.pics) { p.status = 'waiting'; p.out = null; p.note = ''; }
        changed();
        for (const p of S.pics) {
          if (gen !== S.picGen) return;              // settings changed: a newer run owns the list
          p.status = 'working';
          changed();
          let pic = null;
          try {
            pic = p.decoded || await decode(p.file);
            // HEIC is slow to decode; keep it so a settings change is instant.
            if (!p.decoded && isHeic(p.file)) p.decoded = pic;
            const size = fit(pic.w, pic.h, s.max);
            const blob = await canvasBlob(draw(pic, size, fmt.type), fmt.type, s.q);
            if (gen !== S.picGen) return;
            const got = Object.values(FORMATS).find((f) => f.type === blob.type) || FORMATS.png;
            p.out = { blob, name: outName(p.file.name, got.ext) };
            p.size = size;
            p.note = got !== fmt ? `This browser cannot make ${fmt.label}; saved as ${got.label}.` : '';
            p.status = 'done';
          } catch (e) {
            if (gen !== S.picGen) return;
            p.status = 'error';
            p.note = (e && e.message) || 'Could not read this picture.';
          } finally {
            if (pic && pic !== p.decoded && pic.close) pic.close();
          }
          changed();
        }
      }

      async function picsToPdf() {
        const ready = S.pics.filter((p) => p.status !== 'error');
        if (!ready.length) return;
        S.busy = 'Making the PDF…';
        changed();
        try {
          const { PDFDocument } = await pdfLib();
          const doc = await PDFDocument.create();
          const [pw, ph] = PAPER[s.paper];
          const margin = 28;           // about 1 cm
          for (const p of ready) {
            const pic = p.decoded || await decode(p.file);
            try {
              const size = fit(pic.w, pic.h, s.max || 2400);
              const jpg = await canvasBlob(draw(pic, size, 'image/jpeg'), 'image/jpeg', Math.max(s.q, 0.85));
              const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
              const landscape = size.w > size.h;
              const W = landscape ? ph : pw;
              const H = landscape ? pw : ph;
              const k = Math.min((W - margin * 2) / size.w, (H - margin * 2) / size.h);
              const page = doc.addPage([W, H]);
              page.drawImage(img, { x: (W - size.w * k) / 2, y: (H - size.h * k) / 2, width: size.w * k, height: size.h * k });
            } finally {
              if (pic !== p.decoded && pic.close) pic.close();
            }
          }
          const name = ready.length === 1 ? outName(ready[0].file.name, 'pdf') : 'pictures.pdf';
          download(new Blob([await doc.save()], { type: 'application/pdf' }), name);
        } catch (e) {
          toast((e && e.message) || 'Could not make the PDF.', 'warn');
        } finally {
          S.busy = '';
          changed();
        }
      }

      function clearPics() {
        S.picGen += 1;
        for (const p of S.pics) if (p.decoded && p.decoded.close) p.decoded.close();
        S.pics = [];
        changed();
      }

      function paintPics() {
        const fmt = FORMATS[s.fmt];
        const restart = () => { ctx.save(); if (S.pics.length) convertPics(); else changed(); };

        body.append(dropZone('Drop pictures here, or choose them — JPG, PNG, WebP, iPhone HEIC, GIF, SVG',
          'image/*,.heic,.heif', addPics));

        const quality = el('input.cv-range', {
          type: 'range', min: 40, max: 100, step: 5, value: String(Math.round(s.q * 100)),
          'aria-label': 'Quality',
          oninput: (e) => { qLabel.textContent = `${e.target.value}%`; },
          onchange: (e) => { s.q = parseInt(e.target.value, 10) / 100; restart(); },
        });
        const qLabel = el('span.cv-val', { text: `${Math.round(s.q * 100)}%` });

        const sizeSel = el('select.select.select--small', {
          'aria-label': 'Size',
          onchange: (e) => { s.max = parseInt(e.target.value, 10); restart(); },
        }, SIZES.map(([v, label]) => el('option', { value: String(v), text: label, selected: v === s.max ? 'selected' : null })));

        body.append(el('div.cv-settings', {}, [
          el('div.cv-field', {}, [el('span.cv-label', { text: 'Save as' }),
            seg(Object.entries(FORMATS).map(([k, f]) => [k, f.label]), s.fmt, (v) => { s.fmt = v; paintBody(); restart(); })]),
          el('div.cv-field', {}, [el('span.cv-label', { text: 'Size' }), sizeSel]),
          s.fmt !== 'png' ? el('div.cv-field', {}, [el('span.cv-label', { text: 'Quality' }), quality, qLabel]) : null,
        ]));

        const list = el('div.cv-list');
        for (const p of S.pics) {
          let detail = bytes(p.file.size);
          if (p.status === 'working') detail += ' · converting…';
          else if (p.status === 'waiting') detail += ' · waiting';
          else if (p.status === 'error') detail = p.note;
          else if (p.out) detail += ` → ${bytes(p.out.blob.size)} · ${p.size.w}×${p.size.h}${p.note ? ` · ${p.note}` : ''}`;
          list.append(row(p.out ? p.out.name : p.file.name, detail, [
            p.out ? smallBtn('', () => download(p.out.blob, p.out.name), { icon: 'download', aria: `Download ${p.out.name}`, title: 'Download' }) : null,
            smallBtn('', () => { S.pics = S.pics.filter((x) => x !== p); if (p.decoded && p.decoded.close) p.decoded.close(); changed(); },
              { icon: 'close', aria: 'Remove', title: 'Remove' }),
          ], p.status === 'error' ? 'error' : ''));
        }
        if (S.pics.length) body.append(list);

        const done = S.pics.filter((p) => p.out).map((p) => p.out);
        const working = S.pics.some((p) => p.status === 'working' || p.status === 'waiting');
        if (S.pics.length) {
          body.append(el('div.cv-actions', {}, [
            smallBtn(done.length > 1 ? `Download all ${done.length} (.zip)` : `Download ${fmt.label}`, () => downloadAll(done, 'pictures.zip'),
              { icon: 'download', primary: true, disabled: !done.length || working }),
            smallBtn('Make one PDF', picsToPdf, { disabled: !!S.busy || working }),
            el('select.select.select--small', {
              'aria-label': 'PDF paper size',
              onchange: (e) => { s.paper = e.target.value; ctx.save(); },
            }, [['letter', 'Letter'], ['a4', 'A4']].map(([v, l]) => el('option', { value: v, text: l, selected: v === s.paper ? 'selected' : null }))),
            smallBtn('Clear', clearPics),
          ]));
        }
        if (S.busy) body.append(el('p.hint', { text: S.busy }));
      }

      // =============================================================
      // PDF tools
      // =============================================================

      async function addPdfs(files) {
        const fresh = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
        if (fresh.length < files.length) toast('Only PDFs can go in here.', 'warn');
        if (!fresh.length) return;
        const items = fresh.map((file) => ({ id: ++seq, file, pages: 0, status: 'reading' }));
        S.pdfs.push(...items);
        S.pdfOut = []; S.pdfRun += 1;
        changed();
        try {
          const { PDFDocument } = await pdfLib();
          for (const it of items) {
            try {
              it.data = new Uint8Array(await it.file.arrayBuffer());
              const doc = await PDFDocument.load(it.data, { updateMetadata: false });
              it.pages = doc.getPageCount();
              it.status = 'ready';
            } catch (e) {
              it.status = 'error';
              it.note = pdfError(e);
            }
            changed();
          }
        } catch (e) {
          for (const it of items) { it.status = 'error'; it.note = e.message; }
          changed();
        }
      }

      const readyPdfs = () => S.pdfs.filter((p) => p.status === 'ready');

      /** The chosen pages, as [{ file, page }] across all the PDFs in order. */
      function chosen() {
        const docs = readyPdfs();
        const counts = docs.map((d) => d.pages);
        const total = counts.reduce((a, b) => a + b, 0);
        const r = ranges(S.pages, total);
        if (r.error) return r;
        return { list: r.pages.map((i) => { const at = locate(counts, i); return { doc: docs[at.file], page: at.page }; }) };
      }

      const stem = () => {
        const docs = readyPdfs();
        return docs.length === 1 ? docs[0].file.name.replace(/\.pdf$/i, '') : 'pages';
      };

      async function runPdf() {
        const pick = chosen();
        if (pick.error) { toast(pick.error, 'warn'); return; }
        // Results are gathered privately and only shown if nothing changed
        // while this ran — otherwise the list would mix two different jobs.
        const run = ++S.pdfRun;
        const outs = [];
        const task = s.task;
        S.pdfOut = [];
        S.busy = 'Working…';
        changed();
        try {
          if (task === 'pdf') await makePdf(pick.list, outs);
          else if (task === 'render') await renderPages(pick.list, outs);
          else await pullImages(pick.list, outs);
          if (run !== S.pdfRun) return;
          S.pdfOut = outs;
          if (!outs.length) toast(task === 'images' ? 'No pictures were found on those pages.' : 'Nothing was made.', 'warn');
        } catch (e) {
          if (run === S.pdfRun) toast(pdfError(e), 'warn');
        } finally {
          S.busy = '';
          changed();
        }
      }

      async function makePdf(list, outs) {
        const { PDFDocument, degrees } = await pdfLib();
        const loaded = new Map();
        const src = async (d) => {
          if (!loaded.has(d)) loaded.set(d, await PDFDocument.load(d.data, { updateMetadata: false }));
          return loaded.get(d);
        };
        const addTo = async (out, { doc, page }) => {
          const [pg] = await out.copyPages(await src(doc), [page]);
          if (s.rotate) pg.setRotation(degrees((pg.getRotation().angle + s.rotate) % 360));
          out.addPage(pg);
        };
        if (s.split) {
          for (let i = 0; i < list.length; i += 1) {
            S.busy = `Page ${i + 1} of ${list.length}…`;
            changed();
            const out = await PDFDocument.create();
            await addTo(out, list[i]);
            outs.push({ blob: new Blob([await out.save()], { type: 'application/pdf' }), name: `${stem()} - page ${list[i].page + 1}.pdf` });
          }
        } else {
          const out = await PDFDocument.create();
          for (const it of list) await addTo(out, it);
          const name = readyPdfs().length > 1 ? 'joined.pdf' : `${stem()} (edited).pdf`;
          outs.push({ blob: new Blob([await out.save()], { type: 'application/pdf' }), name });
        }
      }

      /** Each chosen page drawn to a picture. */
      async function renderPages(list, outs) {
        const fmt = FORMATS[s.renderFmt];
        const opened = new Map();
        try {
          for (let i = 0; i < list.length; i += 1) {
            S.busy = `Drawing page ${i + 1} of ${list.length}…`;
            changed();
            const { doc, page } = list[i];
            if (!opened.has(doc)) opened.set(doc, await openPdfjs(doc.data));
            const pg = await opened.get(doc).getPage(page + 1);
            const vp = pg.getViewport({ scale: s.sharp });
            const c = document.createElement('canvas');
            c.width = Math.floor(vp.width);
            c.height = Math.floor(vp.height);
            const g = c.getContext('2d');
            g.fillStyle = '#ffffff';
            g.fillRect(0, 0, c.width, c.height);
            // intent 'print': the default 'display' paces itself with
            // requestAnimationFrame, which stops in a background tab — so a
            // long job would freeze the moment the teacher looked elsewhere.
            await pg.render({ canvasContext: g, canvas: c, viewport: vp, intent: 'print' }).promise;
            const blob = await canvasBlob(c, fmt.type, 0.9);
            c.width = c.height = 0;
            pg.cleanup();
            const from = readyPdfs().length > 1 ? doc.file.name.replace(/\.pdf$/i, '') : stem();
            outs.push({ blob, name: `${from} - page ${page + 1}.${fmt.ext}` });
          }
        } finally {
          for (const d of opened.values()) closePdf(d);
        }
      }

      /** The pictures embedded in the chosen pages, as PNGs. */
      async function pullImages(list, outs) {
        const lib = await pdfjs();
        const OPS = lib.OPS;
        const wanted = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat].filter((x) => x != null));
        const opened = new Map();
        const seen = new Set();
        const objGet = (store, name) => new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), 8000);
          try { store.get(name, (v) => { clearTimeout(t); resolve(v); }); } catch (_) { clearTimeout(t); resolve(null); }
        });
        try {
          for (let i = 0; i < list.length; i += 1) {
            S.busy = `Looking at page ${i + 1} of ${list.length}…`;
            changed();
            const { doc, page } = list[i];
            if (!opened.has(doc)) opened.set(doc, await openPdfjs(doc.data));
            const pg = await opened.get(doc).getPage(page + 1);
            const ops = await pg.getOperatorList();
            let n = 0;
            for (let k = 0; k < ops.fnArray.length; k += 1) {
              if (!wanted.has(ops.fnArray[k])) continue;
              const arg = ops.argsArray[k][0];
              let img = arg;
              if (typeof arg === 'string') {
                const tag = `${doc.id}:${arg}`;
                if (seen.has(tag)) continue;                    // the same logo on every page
                seen.add(tag);
                img = await objGet(arg.startsWith('g_') ? pg.commonObjs : pg.objs, arg);
              }
              if (!img || !img.width || !img.height || (img.width < 24 && img.height < 24)) continue;
              const c = document.createElement('canvas');
              c.width = img.width;
              c.height = img.height;
              const g = c.getContext('2d');
              if (img.bitmap) g.drawImage(img.bitmap, 0, 0);
              else if (img.data) {
                const rgba = toRGBA(img.kind, img.data, img.width, img.height);
                if (!rgba) continue;
                g.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
              } else continue;
              const blob = await canvasBlob(c, 'image/png');
              c.width = c.height = 0;
              // pdf.js names a picture differently on different pages, so the
              // same logo on every page is only caught by what it looks like.
              const print = `${img.width}x${img.height}:${crc32(new Uint8Array(await blob.arrayBuffer()))}`;
              if (seen.has(print)) continue;
              seen.add(print);
              n += 1;
              const from = readyPdfs().length > 1 ? doc.file.name.replace(/\.pdf$/i, '') : stem();
              outs.push({ blob, name: `${from} - page ${page + 1} - picture ${n}.png` });
            }
            pg.cleanup();
          }
        } finally {
          for (const d of opened.values()) closePdf(d);
        }
      }

      function movePdf(p, by) {
        const i = S.pdfs.indexOf(p);
        const j = i + by;
        if (j < 0 || j >= S.pdfs.length) return;
        S.pdfs.splice(i, 1);
        S.pdfs.splice(j, 0, p);
        S.pdfOut = []; S.pdfRun += 1;
        changed();
      }

      function paintPdf() {
        body.append(dropZone('Drop PDFs here, or choose them — add several to join them', 'application/pdf,.pdf', addPdfs));

        const list = el('div.cv-list');
        let first = 1;
        for (const p of S.pdfs) {
          let detail;
          if (p.status === 'reading') detail = 'reading…';
          else if (p.status === 'error') detail = p.note;
          else {
            const last = first + p.pages - 1;
            detail = `${p.pages} page${p.pages === 1 ? '' : 's'}${S.pdfs.length > 1 ? ` · numbered ${first === last ? first : `${first}–${last}`} below` : ''} · ${bytes(p.file.size)}`;
            first = last + 1;
          }
          const i = S.pdfs.indexOf(p);
          list.append(row(p.file.name, detail, [
            S.pdfs.length > 1 ? smallBtn('', () => movePdf(p, -1), { icon: 'up', aria: 'Move up', title: 'Move up', disabled: i === 0 }) : null,
            S.pdfs.length > 1 ? smallBtn('', () => movePdf(p, 1), { icon: 'down', aria: 'Move down', title: 'Move down', disabled: i === S.pdfs.length - 1 }) : null,
            smallBtn('', () => { S.pdfs = S.pdfs.filter((x) => x !== p); S.pdfOut = []; S.pdfRun += 1; changed(); }, { icon: 'close', aria: 'Remove', title: 'Remove' }),
          ], p.status === 'error' ? 'error' : ''));
        }
        if (S.pdfs.length) body.append(list);
        if (!readyPdfs().length) return;

        const total = readyPdfs().reduce((a, d) => a + d.pages, 0);
        const err = el('p.hint.cv-err');
        const check = () => { const r = ranges(S.pages, total); err.textContent = r.error || ''; return !r.error; };
        const pagesInput = el('input.input.cv-pages', {
          value: S.pages, placeholder: `All ${total} pages — or e.g. 1-3, 5, ${Math.min(total, 8)}-`,
          'aria-label': 'Which pages',
          oninput: (e) => { S.pages = e.target.value; S.pdfOut = []; S.pdfRun += 1; check(); paintOut(); },
        });

        const opts = el('div.cv-settings');
        const paintOpts = () => {
          Desk.clear(opts);
          opts.append(el('div.cv-field', {}, [el('span.cv-label', { text: 'Make' }),
            seg([['pdf', 'A new PDF'], ['render', 'Pages as pictures'], ['images', 'Pictures inside']], s.task,
              (v) => { s.task = v; S.pdfOut = []; S.pdfRun += 1; ctx.save(); paintOpts(); paintOut(); })]));
          opts.append(el('div.cv-field', {}, [el('span.cv-label', { text: 'Pages' }), pagesInput]), err);
          if (s.task === 'pdf') {
            opts.append(
              el('div.cv-field', {}, [el('span.cv-label', { text: 'Turn' }),
                seg([[0, 'No'], [90, '↻ 90°'], [180, '180°'], [270, '↺ 90°']], s.rotate, (v) => { s.rotate = v; S.pdfOut = []; S.pdfRun += 1; ctx.save(); paintOpts(); paintOut(); })]),
              el('div.cv-field', {}, [el('span.cv-label', { text: 'As' }),
                seg([[false, 'One PDF'], [true, 'A PDF per page']], s.split, (v) => { s.split = v; S.pdfOut = []; S.pdfRun += 1; ctx.save(); paintOpts(); paintOut(); })]),
            );
          } else if (s.task === 'render') {
            opts.append(
              el('div.cv-field', {}, [el('span.cv-label', { text: 'Format' }),
                seg([['png', 'PNG'], ['jpeg', 'JPG']], s.renderFmt, (v) => { s.renderFmt = v; S.pdfOut = []; S.pdfRun += 1; ctx.save(); paintOpts(); paintOut(); })]),
              el('div.cv-field', {}, [el('span.cv-label', { text: 'Detail' }),
                seg(SHARPNESS, s.sharp, (v) => { s.sharp = v; S.pdfOut = []; S.pdfRun += 1; ctx.save(); paintOpts(); paintOut(); })]),
            );
          } else {
            opts.append(el('p.hint', { text: 'Photos and drawings stored inside the PDF, at the size they were put in. Tiny decorations are skipped.' }));
          }
          check();
        };
        paintOpts();
        body.append(opts);

        const out = el('div.cv-out');
        body.append(out);
        function paintOut() {
          Desk.clear(out);
          const label = { pdf: s.split ? 'Make the PDFs' : 'Make the PDF', render: 'Make the pictures', images: 'Find the pictures' }[s.task];
          out.append(el('div.cv-actions', {}, [
            smallBtn(label, runPdf, { primary: true, disabled: !!S.busy }),
            S.pdfOut.length ? smallBtn(S.pdfOut.length > 1 ? `Download all ${S.pdfOut.length} (.zip)` : 'Download',
              () => downloadAll(S.pdfOut, `${stem()}.zip`), { icon: 'download', primary: true }) : null,
            smallBtn('Clear', () => { S.pdfs = []; S.pdfOut = []; S.pdfRun += 1; S.pages = ''; changed(); }),
          ]));
          if (S.busy) out.append(el('p.hint', { text: S.busy }));
          if (S.pdfOut.length) {
            const res = el('div.cv-list');
            for (const o of S.pdfOut.slice(0, 60)) {
              res.append(row(o.name, bytes(o.blob.size), [smallBtn('', () => download(o.blob, o.name), { icon: 'download', aria: `Download ${o.name}`, title: 'Download' })]));
            }
            if (S.pdfOut.length > 60) res.append(el('p.hint', { text: `…and ${S.pdfOut.length - 60} more in the .zip.` }));
            out.append(res);
          }
        }
        paintOut();
      }

      // =============================================================
      // PDF → Word
      // =============================================================

      async function addWords(files) {
        const fresh = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
        if (fresh.length < files.length) toast('Only PDFs can go in here.', 'warn');
        const items = fresh.map((file) => ({ id: ++seq, file, status: 'waiting' }));
        S.words.push(...items);
        changed();
        for (const it of items) {
          it.status = 'working';
          changed();
          let pdf = null;
          try {
            pdf = await openPdfjs(new Uint8Array(await it.file.arrayBuffer()));
            const blocks = [];
            let chars = 0;
            let paras = 0;
            for (let n = 1; n <= pdf.numPages; n += 1) {
              it.progress = `page ${n} of ${pdf.numPages}`;
              changed();
              const page = await pdf.getPage(n);
              const tc = await page.getTextContent();
              const ps = paragraphs(tc.items);
              if (n > 1 && ps.length) blocks.push({ pageBreak: true });
              for (const p of ps) { blocks.push(p); chars += p.text.length; paras += 1; }
              page.cleanup();
            }
            it.pages = pdf.numPages;
            it.text = blocks.filter((b) => !b.pageBreak).map((b) => b.text).join('\n\n');
            it.scanned = chars < 25 * pdf.numPages;
            it.paras = paras;
            it.headings = blocks.filter((b) => b.heading).length;
            const title = it.file.name.replace(/\.pdf$/i, '');
            it.out = {
              blob: new Blob(zipParts(docxFiles(blocks, title)), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
              name: outName(it.file.name, 'docx'),
            };
            it.status = 'done';
          } catch (e) {
            it.status = 'error';
            it.note = pdfError(e);
          } finally {
            if (pdf) closePdf(pdf);
          }
          changed();
        }
      }

      function paintWord() {
        body.append(dropZone('Drop a PDF here, or choose one', 'application/pdf,.pdf', addWords));
        body.append(el('p.hint.cv-note', { text: 'Keeps the words, paragraphs and headings so you can edit them — not the layout, tables, columns or pictures.' }));

        const list = el('div.cv-list');
        for (const w of S.words) {
          let detail;
          if (w.status === 'waiting') detail = 'waiting';
          else if (w.status === 'working') detail = `reading ${w.progress || '…'}`;
          else if (w.status === 'error') detail = w.note;
          else if (w.scanned) detail = 'Little or no text found — this looks like a scanned page. Use Google Drive below; it reads scans.';
          else detail = `${w.pages} page${w.pages === 1 ? '' : 's'} · ${w.paras} paragraph${w.paras === 1 ? '' : 's'}${w.headings ? ` · ${w.headings} heading${w.headings === 1 ? '' : 's'}` : ''}`;
          list.append(row(w.out ? w.out.name : w.file.name, detail, [
            w.out && !w.scanned ? smallBtn('', () => download(w.out.blob, w.out.name), { icon: 'download', aria: `Download ${w.out.name}`, title: 'Download Word file' }) : null,
            w.text && !w.scanned ? smallBtn('', async () => {
              try { await navigator.clipboard.writeText(w.text); toast('Text copied.'); } catch (_) { toast('Could not copy here.', 'warn'); }
            }, { icon: 'copy', aria: 'Copy the text', title: 'Copy the text' }) : null,
            smallBtn('', () => { S.words = S.words.filter((x) => x !== w); changed(); }, { icon: 'close', aria: 'Remove', title: 'Remove' }),
          ], w.status === 'error' || w.scanned ? 'error' : ''));
        }
        if (S.words.length) body.append(list);

        body.append(el('div.cv-drive', {}, [
          el('div.cv-drive-head', { text: 'Need the layout, tables, or a scanned page?' }),
          el('p.hint', { text: 'Google Docs does this better than any free tool, and reads scans:' }),
          el('ol.cv-steps', {}, [
            el('li', { text: 'Upload the PDF to Google Drive.' }),
            el('li', { text: 'Right-click it → Open with → Google Docs.' }),
            el('li', { text: 'File → Download → Microsoft Word (.docx).' }),
          ]),
          el('a.btn.btn--small', { href: 'https://drive.google.com/drive/my-drive', target: '_blank', rel: 'noopener noreferrer', svg: icon('external', 14) }, ' Open Google Drive'),
        ]));
      }

      paintTabs();
      paintBody();

      return {
        destroy() { S.listeners.delete(repaint); },
      };
    },

    // Exposed for the tests.
    _crc32: crc32,
    _zip: zip,
    _docxFiles: docxFiles,
    _xmlText: xmlText,
    _paragraphs: paragraphs,
    _ranges: ranges,
    _locate: locate,
    _fit: fit,
    _outName: outName,
    _uniqueNames: uniqueNames,
    _isHeic: isHeic,
    _toRGBA: toRGBA,
  });

}(window.Desk));
