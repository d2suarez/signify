/**
 * Reads the NAD Office of Education's standards PDFs (North American Division,
 * Seventh-day Adventist) into plain items for scripts/standards-seeds.mjs.
 * The NAD publishes its standards only as PDFs, so nothing here is typed by
 * hand: every code and statement comes from the PDF's own text, placed by
 * where it sits on the page.
 *
 * Needs pdfjs-dist, which the app does not ship:
 *   npm i --no-save pdfjs-dist@4.10.38    (or PDFJS=<path to legacy/build/pdf.mjs>)
 *
 * Three page layouts:
 *  - grid: the elementary tables (Bible, ELA, math, science, social studies,
 *    fine arts, PE). Page title = domain, a left column of strands, then one or
 *    more code columns ("B.K.BF.1" + statement). Grades come from the code.
 *  - outline: the secondary sets. One course per page (big title), headings
 *    ("COURSE FOCUS"), then ACCT.1 / ACCT.1.1 lines.
 *  - tech: the 2022 elementary technology tables, which print no codes. Codes
 *    are made with the document's own coding rule, T.<domain>.<standard>.<objective>.
 *
 * Each parse returns { items, problems, tokens }: items are
 * { key, code, statement, type, grades, parentKey, abbreviated?, notes? } in
 * tree order; problems are things the parser could not place (printed by the
 * seed script and listed in PLAN.md); tokens counts every code-shaped string
 * on the standards pages, to check against the items.
 */
import fs from "node:fs";
import path from "node:path";

export const NAD_PDFS = "https://hub.adventisteducation.org/uploads/artifact-content/";

export async function fetchNad(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const res = await fetch(NAD_PDFS + f);
    if (!res.ok) throw new Error(`${NAD_PDFS + f}: ${res.status}`);
    fs.writeFileSync(path.join(dir, f), Buffer.from(await res.arrayBuffer()));
    console.log("fetched", NAD_PDFS + f);
  }
}

let pdfjs;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  try {
    pdfjs = await import(process.env.PDFJS || "pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    throw new Error("The NAD PDFs need pdfjs-dist: npm i --no-save pdfjs-dist@4.10.38 (or set PDFJS=<path to pdf.mjs>)");
  }
  return pdfjs;
}

// ---------- text with positions ----------

/** Every page's text as segments: runs of text on one line with no wide gap. */
async function readPages(file) {
  const { getDocument } = await loadPdfjs();
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const flat = (i) => Math.abs(i.transform[1]) < 0.01 && Math.abs(i.transform[2]) < 0.01;
    const items = tc.items
      .filter((i) => i.str.trim() && flat(i))
      .map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, size: Math.round(Math.abs(i.transform[3]) * 2) / 2, s: i.str }));
    // Rotated text is kept apart: the secondary sets' side tab names the course.
    const tabs = tc.items.filter((i) => i.str.trim() && !flat(i)).map((i) => ({ text: i.str.trim(), size: Math.round(Math.hypot(i.transform[0], i.transform[1])) }));
    pages.push({ n, segs: segments(items), tabs, cells: await filledRects(page) });
  }
  return pages;
}

/** Filled rectangles (table cell backgrounds) in page coordinates. */
async function filledRects(page) {
  const { OPS } = await loadPdfjs();
  const ops = await page.getOperatorList();
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const out = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let path = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const f = ops.fnArray[i], a = ops.argsArray[i];
    if (f === OPS.save) stack.push(ctm);
    else if (f === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (f === OPS.transform) ctm = mul(ctm, a);
    else if (f === OPS.constructPath) {
      path = [];
      let k = 0;
      for (const op of a[0]) {
        if (op === OPS.rectangle) {
          const [x, y, w, h] = a[1].slice(k, k + 4);
          k += 4;
          const pt = (X, Y) => [ctm[0] * X + ctm[2] * Y + ctm[4], ctm[1] * X + ctm[3] * Y + ctm[5]];
          const [x1, y1] = pt(x, y), [x2, y2] = pt(x + w, y + h);
          path.push({ x0: Math.min(x1, x2), x1: Math.max(x1, x2), y0: Math.min(y1, y2), y1: Math.max(y1, y2) });
        } else if (op === OPS.moveTo || op === OPS.lineTo) k += 2;
        else if (op === OPS.curveTo) k += 6;
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4;
      }
    } else if (f === OPS.fill || f === OPS.eoFill || f === OPS.fillStroke || f === OPS.eoFillStroke) { out.push(...path); path = []; }
  }
  return out;
}

const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };

function segments(items) {
  // Superscript digits (cm², in³) are small and raised: put them back on their line.
  for (const i of items) {
    if (!/^\d+$/.test(i.s.trim())) continue;
    const base = items.find((b) => b !== i && b.size >= i.size * 1.4 && Math.abs(b.x + b.w - i.x) < 1.5 && i.y - b.y > 0.5 && i.y - b.y < b.size * 0.6);
    if (base) { i.s = i.s.trim().replace(/\d/g, (d) => SUP[d]); i.y = base.y; i.size = base.size; }
  }
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const i of items) {
    const line = lines.find((l) => Math.abs(l.y - i.y) <= 1.2);
    if (line) line.items.push(i); else lines.push({ y: i.y, items: [i] });
  }
  const out = [];
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const i of l.items) {
      const gap = cur ? i.x - cur.x1 : Infinity;
      if (cur && gap < Math.max(2.5, 0.6 * Math.min(cur.size, i.size))) {
        cur.text += (gap < 0.15 * i.size && !/[,;]$/.test(cur.text)) || /^[⁰¹²³⁴⁵⁶⁷⁸⁹]/.test(i.s) || /\s$/.test(cur.text) || /^\s/.test(i.s) ? i.s : " " + i.s;
        cur.x1 = i.x + i.w;
        cur.size = Math.max(cur.size, i.size);
      } else {
        cur = { x: i.x, x1: i.x + i.w, y: l.y, size: i.size, text: i.s };
        out.push(cur);
      }
    }
  }
  for (const s of out) s.text = s.text.replace(/\s+/g, " ").trim();
  return out.filter((s) => s.text);
}

const byReading = (a, b) => b.y - a.y || a.x - b.x;

/** Lines of segments → one statement; a word broken at a line end is joined. */
function joinText(segs, problems, code) {
  const lines = [];
  for (const s of [...segs].sort(byReading)) {
    const line = lines.find((l) => Math.abs(l.y - s.y) <= 1.2);
    if (line) line.parts.push(s); else lines.push({ y: s.y, parts: [s] });
  }
  let text = "";
  for (const l of lines) {
    const t = l.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(" ");
    // "Seventh-" + "day": the hyphen stays (nearly always a compound word).
    if (/[a-z]-$/.test(text) && /^[a-z]/.test(t)) {
      problems?.push(`${code}: "${text.split(" ").pop()}${t.split(" ")[0]}" was split across a line; kept the hyphen`);
      text += t;
    } else text = !text ? t : text.endsWith("/") ? text + t : `${text} ${t}`;
  }
  return text.replace(/\s+/g, " ").replace(/\s+([.,;:)])/g, "$1").replace(/\(\s+/g, "(").trim();
}

const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
/** "BIBLICAL FOUNDATIONS" → "Biblical Foundations" (only all-caps headings). */
export function titleCase(s) {
  if (/[a-z]/.test(s)) return s;
  return s.toLowerCase().replace(/[a-z][a-z'’]*/g, (w, at) => (at > 0 && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
}

const GRADES = ["PK", "KG", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
const g2 = (g) => (g === "K" ? "KG" : String(g).padStart(2, "0"));
/** "K", "3", "1-4", "K-2", "9-12" → CASE levels. */
export function gradeRange(token) {
  const m = /^(K|\d{1,2})(?:-(K|\d{1,2}))?$/.exec(token);
  if (!m) return [];
  const a = GRADES.indexOf(g2(m[1])), b = m[2] ? GRADES.indexOf(g2(m[2])) : a;
  return a < 0 || b < a ? [] : GRADES.slice(a, b + 1);
}

/** Codes as printed, with en dashes and stray spaces evened out ("LA.3. RI.1" → "LA.3.RI.1"). */
const normCode = (c) => c.replace(/[–—‑]/g, "-").replace(/\s+/g, "");

/** Splits rows between consecutive anchors at the widest gap (rows centred on their anchor). */
function splitMiddle(anchors, lines) {
  const ys = anchors.map((a) => a.y);
  const cuts = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const between = lines.filter((l) => l.y <= ys[i] + 1.5 && l.y >= ys[i + 1] - 1.5).map((l) => l.y).sort((a, b) => b - a);
    const pts = [ys[i] + 0.01, ...between, ys[i + 1] - 0.01];
    let best = 0, cut = (ys[i] + ys[i + 1]) / 2;
    for (let k = 0; k + 1 < pts.length; k++) if (pts[k] - pts[k + 1] > best) { best = pts[k] - pts[k + 1]; cut = (pts[k] + pts[k + 1]) / 2; }
    cuts.push(cut);
  }
  return (y) => { let i = 0; while (i < cuts.length && y < cuts[i]) i++; return i; };
}

/**
 * Puts ordered rows into ordered labels (strands, centred in their cells):
 * between two labels the rows split at the widest gap between rows.
 */
function partition(rows, labels) {
  if (!labels.length || rows.length < labels.length) return null;
  const cuts = [];
  for (let k = 0; k + 1 < labels.length; k++) {
    const hi = labels[k].y, lo = labels[k + 1].y;
    let best = -Infinity, cut = (hi + lo) / 2;
    for (let i = 0; i + 1 < rows.length; i++) {
      const mid = (rows[i].bottom + rows[i + 1].top) / 2;
      const gap = rows[i].bottom - rows[i + 1].top;
      if (mid <= hi && mid >= lo && gap > best) { best = gap; cut = mid; }
    }
    cuts.push(cut);
  }
  return rows.map((r) => { const c = (r.top + r.bottom) / 2; let k = 0; while (k < cuts.length && c < cuts[k]) k++; return k; });
}

/** Vertical runs of label segments ("History of" / "the Bible") → one label each. */
function labelBlocks(segs) {
  const blocks = [];
  for (const s of [...segs].sort(byReading)) {
    const b = blocks.at(-1);
    if (b && b.bottom - s.y <= 1.35 * s.size + 0.5) { b.segs.push(s); b.bottom = s.y; } else blocks.push({ segs: [s], top: s.y, bottom: s.y });
  }
  return blocks.map((b) => ({ text: joinText(b.segs), y: (b.top + b.bottom) / 2, x: Math.min(...b.segs.map((s) => s.x)), x1: Math.max(...b.segs.map((s) => s.x1)) }));
}

// ---------- elementary tables ----------

/**
 * opts: code (RegExp, anchored, the whole code), grade (RegExp: group 1 = the
 * grade token in a normalized code), domain (RegExp: group 1 = the domain
 * abbreviation), corr (RegExp: the first words of a textbook-correlation
 * cell; statement text stops left of the first one on the page, else at cutX),
 * align ('top' | 'middle'), maxCodeSize, misprints ({ printed: meant }),
 * skipRows (RegExp: a left-column row label whose row holds no standards,
 * e.g. math's "Assessments"). Where the table draws a cell around a code,
 * that cell is the row; otherwise align decides.
 */
export async function parseGrid(file, opts) {
  const pages = await readPages(file);
  const problems = [];
  const items = new Map();
  const add = (it) => {
    if (items.has(it.key)) { problems.push(`${it.code || it.key}: printed twice; the second (${it.statement.slice(0, 40)}…) is left out`); return null; }
    items.set(it.key, it); return it;
  };
  let tokens = 0;
  for (const p of pages) {
    const titleSegs = p.segs.filter((s) => s.y > 740 && s.size >= 9);
    const title = titleSegs.sort((a, b) => a.x - b.x).map((s) => s.text).join(" ");
    if (!/[—–-]/.test(title)) continue;
    const codes = [];
    const rest = [];
    for (const s of p.segs) {
      // A code printed wrong in the subject PDF (checked against the grade-level PDFs).
      for (const [bad, good] of Object.entries(opts.misprints ?? {})) {
        if (s.text.startsWith(bad + " ") || s.text === bad) {
          problems.push(`page ${p.n}: the PDF prints "${bad}"; read as ${good}, as the grade-level PDFs print it`);
          s.text = good + s.text.slice(bad.length);
        }
      }
      const m = s.size <= (opts.maxCodeSize ?? 8) && opts.code.exec(s.text);
      if (m) {
        tokens++;
        codes.push({ ...s, code: normCode(m[0]), first: s.text.slice(m[0].length).trim() });
      } else rest.push(s);
    }
    if (!codes.length) continue;
    const domainName = titleCase(title.replace(/\(?CONTINUED\)?/i, "").split(/\s+[—–]\s*|\s+-\s+/).slice(1).join(" — ").replace(/^\d+\.\s*/, "").replace(/\s*—\s*$/, "").trim());
    const codeSize = Math.min(...codes.map((c) => c.size));
    // Code columns: codes within a few points of each other across the page.
    const cols = [];
    for (const c of [...codes].sort((a, b) => a.x - b.x)) {
      const col = cols.find((k) => Math.abs(k.x - c.x) <= 6);
      if (col) col.codes.push(c); else cols.push({ x: c.x, codes: [c] });
    }
    for (const col of cols) col.codes.sort(byReading);
    const firstX = cols[0].x;
    // Text starts at the code (top) or may sit above it, up to the big Essential Question text (middle).
    const maxY = Math.max(...codes.map((c) => c.y));
    const top = opts.align === "middle"
      ? Math.min(maxY + 80, ...p.segs.filter((s) => s.size >= codeSize + 2 && s.y > maxY).map((s) => s.y))
      : maxY + 2 * codeSize;
    const corrX = Math.min(...rest.filter((s) => opts.corr?.test(s.text) && s.x > firstX + 60).map((s) => s.x));
    const cutX = Number.isFinite(corrX) ? corrX - 2 : opts.cutX ?? Infinity;
    const smallestAround = (x, y) => p.cells.filter((r) => r.x0 <= x && r.x1 >= x && r.y0 <= y && r.y1 >= y).sort((a, b) => (a.y1 - a.y0) * (a.x1 - a.x0) - (b.y1 - b.y0) * (b.x1 - b.x0))[0];
    const skipped = rest.filter((s) => opts.skipRows?.test(s.text) && s.x < firstX).map((s) => smallestAround(s.x + 1, s.y + 1) ?? { y0: s.y - 2 * s.size, y1: s.y + s.size });
    const textSegs = rest.filter((s) => s.x >= firstX - 2 && s.size >= codeSize - 0.5 && s.size <= codeSize + 1.5 && s.y < top && s.x < cutX && !skipped.some((r) => s.y >= r.y0 && s.y <= r.y1));
    for (const col of cols) {
      col.text = [];
      // Anything else starting at a code column's edge is a code the pattern missed.
      for (const s of textSegs) if (Math.abs(s.x - col.x) <= 1.5 && /^\S*\d\S*\.\S*\d/.test(s.text)) problems.push(`page ${p.n}: "${s.text.slice(0, 40)}" looks like a code but doesn't match; its text went to the code above`);
    }
    for (const s of textSegs) {
      const col = [...cols].reverse().find((k) => k.x <= s.x + 3);
      col?.text.push(s);
    }
    for (const col of cols) {
      const owner = opts.align === "middle" ? splitMiddle(col.codes, col.text) : null;
      for (const c of col.codes) {
        c.lines = [];
        // The code's own cell, if it is a row (holds no other code of the column).
        const r = smallestAround(c.x + 1, c.y + codeSize / 2);
        c.row = r && !col.codes.some((o) => o !== c && o.y >= r.y0 && o.y <= r.y1) ? r : null;
      }
      for (const s of col.text) {
        let c = col.codes.find((k) => k.row && s.y >= k.row.y0 - 1 && s.y <= k.row.y1 + 1);
        if (c) { /* in the code's row cell */ }
        else if (owner) c = col.codes[owner(s.y)];
        else c = [...col.codes].reverse().find((k) => k.y >= s.y - 1.5);
        if (c) c.lines.push(s);
        else if (s.y < col.codes[0].y + codeSize * 3) problems.push(`page ${p.n}: "${s.text}" above the first code (${col.codes[0].code}) was left out`);
      }
    }
    // Strands: labels left of the first code column, beside the codes.
    const bottom = Math.min(...codes.map((c) => Math.min(c.y, ...c.lines.map((l) => l.y)))) - 2 * codeSize;
    const strandSegs = rest.filter((s) => s.x < firstX - 2 && s.size > codeSize && s.size <= 8.5 && s.y < top - 1 && s.y >= bottom && !/^(GRADE|CONTENT|TOPICS|STANDARDS)$/.test(s.text));
    // Not strands: a row label with its own text beside it ("Assessments  Math Interviews; …").
    const labels = labelBlocks(strandSegs.filter((l) => !rest.some((s) => s.size >= 9 && s.x > l.x1 && Math.abs(s.y - l.y) <= 6)));
    // A strand's own cell, where the table draws one: the smallest filled box around the label, left of the codes.
    for (const l of labels) {
      l.cell = p.cells
        .filter((r) => r.x0 <= l.x + 1 && r.x1 >= l.x1 - 1 && r.x1 <= firstX + 2 && r.y0 <= l.y && r.y1 >= l.y)
        .sort((a, b) => (a.y1 - a.y0) - (b.y1 - b.y0))[0] ?? null;
    }
    // A strand whose cell isn't filled (white) owns the space between its neighbours' cells.
    labels.forEach((l, k) => {
      if (l.cell || !labels.some((o) => o.cell)) return;
      const above = labels.slice(0, k).reverse().find((o) => o.cell), below = labels.slice(k + 1).find((o) => o.cell);
      l.cell = { y0: below ? below.cell.y1 : -Infinity, y1: above ? above.cell.y0 : Infinity };
    });
    for (const col of cols) {
      const rows = col.codes.map((c) => ({ top: c.y + codeSize, bottom: Math.min(c.y, ...c.lines.map((l) => l.y)) }));
      const inCell = labels.length && labels.every((l) => l.cell)
        ? col.codes.map((c) => labels.findIndex((l) => c.y >= l.cell.y0 && c.y <= l.cell.y1))
        : null;
      const byCell = inCell && inCell.every((k) => k >= 0);
      if (labels.length && !byCell) problems.push(`page ${p.n}: strands placed by spacing (no cell boxes to read): ${col.codes[0].code}…${col.codes.at(-1).code}`);
      const which = byCell ? inCell : labels.length ? partition(rows, labels) : null;
      if (labels.length && !which) problems.push(`page ${p.n}: ${labels.length} strands but only ${rows.length} codes in a column; strands left out there`);
      col.codes.forEach((c, i) => { c.strand = which ? labels[which[i]].text : null; });
    }
    for (const c of codes) {
      const g = opts.grade.exec(c.code)?.[1];
      const grades = g ? gradeRange(g) : [];
      if (!grades.length) problems.push(`${c.code}: no grade in the code`);
      const d = opts.domain.exec(c.code)?.[1] ?? "?";
      const dKey = `d:${d}`;
      const dom = items.get(dKey) ?? add({ key: dKey, code: d, statement: domainName, type: "Domain", grades: [], parentKey: null });
      if (dom.statement !== domainName) problems.push(`${c.code}: domain ${d} is titled both "${dom.statement}" and "${domainName}"`);
      let parentKey = dKey;
      if (c.strand) {
        const sKey = `s:${d}:${c.strand.toLowerCase()}`;
        const st = items.get(sKey) ?? add({ key: sKey, code: "", statement: c.strand, type: "Strand", grades: [], parentKey: dKey });
        st.grades = merge(st.grades, grades);
        parentKey = sKey;
      }
      dom.grades = merge(dom.grades, grades);
      const statement = joinText([...(c.first ? [{ ...c, text: c.first }] : []), ...c.lines], problems, c.code);
      if (!statement) problems.push(`${c.code}: no statement found`);
      add({ key: c.code, code: c.code, statement, type: "Standard", grades, parentKey });
    }
  }
  return { items: order([...items.values()]), problems, tokens };
}

const merge = (a, b) => [...new Set([...a, ...b])].sort((x, y) => GRADES.indexOf(x) - GRADES.indexOf(y));

/** Domains in first-seen order, strands in first-seen order, standards by grade then number. */
function order(items) {
  const kids = new Map();
  for (const i of items) { const p = i.parentKey ?? ""; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(i); }
  const num = (code) => Number(/(\d+)$/.exec(code)?.[1] ?? 0);
  const rank = (i) => (i.type === "Standard" ? [GRADES.indexOf(i.grades[0] ?? "PK"), num(i.code)] : [-1, 0]);
  const out = [];
  const walk = (p) => {
    const list = kids.get(p) ?? [];
    const sorted = list.every((i) => i.type === "Standard")
      ? [...list].sort((a, b) => { const [ga, na] = rank(a), [gb, nb] = rank(b); return ga - gb || na - nb; })
      : list;
    for (const i of sorted) { out.push(i); walk(i.key); }
  };
  walk("");
  return out;
}

// ---------- secondary outlines ----------

/**
 * opts: code (RegExp, anchored), grades (course name → CASE levels, else
 * defaultGrades), defaultGrades, misprints ({ printed: meant }).
 */
export async function parseOutline(file, opts) {
  const pages = await readPages(file);
  const problems = [];
  const items = [];
  const seen = new Set();
  let tokens = 0;
  let course = null, section = null, last = null, secN = 0;
  const flush = () => {
    if (!last) return;
    last.item.statement = joinText(last.segs, problems, last.item.code);
    if (!last.item.statement) problems.push(`${last.item.code}: no statement found`);
    last = null;
  };
  for (const p of pages) {
    const codeSize = 9;
    for (const s of p.segs) {
      for (const [bad, good] of Object.entries(opts.misprints ?? {})) {
        if (s.text.startsWith(bad + " ") || s.text === bad) {
          problems.push(`page ${p.n}: the PDF prints "${bad}"; read as ${good}`);
          s.text = good + s.text.slice(bad.length);
        }
      }
    }
    const hasCodes = p.segs.some((s) => s.size === codeSize && opts.code.test(s.text));
    if (!hasCodes) continue;
    // The side tab names the course; a page without a new one continues the course.
    const name = p.tabs.filter((t) => t.size >= 25).map((t) => t.text).join(" ").trim();
    if (name && name !== course?.statement) {
      flush();
      course = { key: `c:${name.toLowerCase()}`, code: "", statement: name, type: "Course", grades: opts.grades?.[name] ?? opts.defaultGrades, parentKey: null };
      items.push(course);
      section = null;
    }
    if (!course) { problems.push(`page ${p.n}: standards before any course title`); continue; }
    const body = p.segs.filter((s) => s.x < 600 && s.y > 40 && s.y < 680 && s.size < 25).sort(byReading);
    let headLines = [];
    const endHeading = () => {
      if (!headLines.length) return;
      flush();
      const raw = joinText(headLines);
      const m = /^([^[]*?)\s*(\[.*\]?)?$/.exec(raw);
      const head = titleCase(m[1].replace(/:$/, "").trim());
      section = { key: `${course.key}:s${++secN}`, code: "", statement: head || raw, type: "Section", grades: course.grades, parentKey: course.key, notes: m[2]?.replace(/[)\]]?$/, "]") ?? null, about: [] };
      items.push(section);
      headLines = [];
    };
    for (const s of body) {
      if (s.size >= 11.5) { if (!last && headLines.length && headLines.at(-1).y - s.y > 20) endHeading(); headLines.push(s); last && flush(); continue; }
      endHeading();
      if (s.size !== codeSize) continue;
      const m = opts.code.exec(s.text);
      if (m) {
        tokens++;
        flush();
        const code = normCode(m[0]);
        // The same number printed twice (a numbering slip): both are kept, the second keyed apart.
        let key = code;
        for (let n = 2; seen.has(key); n++) key = `${code}~${n}`;
        if (key !== code) problems.push(`${code}: printed twice in ${course.statement}; both kept with the printed code`);
        seen.add(key);
        const parentCode = code.replace(/\.[^.]+$/, "");
        const parentKey = seen.has(parentCode) && parentCode !== code ? parentCode : section?.key ?? course.key;
        const item = { key, code, statement: "", type: parentKey === parentCode ? "Indicator" : "Standard", grades: course.grades, parentKey };
        items.push(item);
        const first = s.text.slice(m[0].length).trim();
        last = { item, segs: first ? [{ ...s, text: first }] : [] };
      } else if (last) last.segs.push(s);
      else if (section) section.about.push(s);
      else problems.push(`page ${p.n}: "${s.text.slice(0, 60)}" before the first heading was left out`);
    }
    endHeading();
  }
  flush();
  for (const i of items) {
    if (i.about) { const t = joinText(i.about); i.notes = [i.notes, t].filter(Boolean).join(" ") || null; delete i.about; }
  }
  return { items, problems, tokens };
}

// ---------- elementary technology (2022) ----------

/** Codes per the document's coding page: T.<domain initials>.<standard>.<objective>. */
export async function parseTech(file, opts) {
  const pages = await readPages(file);
  const problems = [];
  const items = [];
  for (const p of pages) {
    const domN = p.segs.find((s) => /^Domain \d+$/.test(s.text) && s.y > 740);
    if (!domN) continue;
    const name = p.segs.filter((s) => s.y > 725 && s.y < 745 && s.size >= 9.5).map((s) => s.text).join(" ");
    const abbr = name.split(/\s+/).map((w) => w[0]).join("").toUpperCase();
    const dKey = `T.${abbr}`;
    items.push({ key: dKey, code: dKey, statement: titleCase(name), type: "Domain", grades: opts.grades, parentKey: null });
    const head = p.segs.find((s) => s.text.startsWith("Theme"));
    const foot = p.segs.find((s) => s.text.startsWith("Assessments:"));
    if (!head || !foot) { problems.push(`page ${p.n}: table edges not found`); continue; }
    const rows = p.segs.filter((s) => s.y < head.y - 2 && s.y > foot.y + 2);
    const themeNums = rows.filter((s) => s.x < 60 && /^\d+$/.test(s.text)).sort(byReading);
    const objNums = rows.filter((s) => s.x > 300 && s.x < 330 && /^\d+$/.test(s.text)).sort(byReading);
    const themeText = rows.filter((s) => s.x >= 55 && s.x < 150 && !/^\d+$/.test(s.text));
    const stdText = rows.filter((s) => s.x >= 150 && s.x < 305);
    const objText = rows.filter((s) => s.x >= 330);
    const themeOf = splitMiddle(themeNums, [...stdText, ...themeText]);
    const objOf = splitMiddle(objNums, objText);
    const group = (list, of, n) => { const g = Array.from({ length: n }, () => []); for (const s of list) g[of(s.y)].push(s); return g; };
    const tNames = group(themeText, themeOf, themeNums.length);
    const tStd = group(stdText, themeOf, themeNums.length);
    const oText = group(objText, objOf, objNums.length);
    themeNums.forEach((t, k) => {
      const code = `${dKey}.${t.text}`;
      // The theme is the standard's short name; the ISTE correlation stays at the end as printed.
      items.push({
        key: code, code, statement: joinText(tStd[k], problems, code), type: "Standard", grades: opts.grades, parentKey: dKey,
        abbreviated: joinText(tNames[k]) || null,
      });
    });
    objNums.forEach((o, k) => {
      const t = themeOf(o.y);
      const code = `${dKey}.${themeNums[t].text}.${o.text}`;
      items.push({ key: code, code, statement: joinText(oText[k], problems, code), type: "Objective", grades: opts.grades, parentKey: `${dKey}.${themeNums[t].text}` });
    });
  }
  const sorted = order(items.map((i) => ({ ...i, type: i.type === "Objective" ? "Standard" : i.type === "Standard" ? "Theme" : i.type })))
    .map((i) => ({ ...i, type: i.type === "Standard" ? "Objective" : i.type === "Theme" ? "Standard" : i.type }));
  return { items: sorted, problems, tokens: items.filter((i) => i.type === "Objective").length };
}

/**
 * Every code on a grade-level PDF with the text printed beside it (to
 * cross-check the subject PDFs): code → statement.
 */
export async function codesIn(file, re) {
  const pages = await readPages(file);
  const out = new Map();
  for (const p of pages) {
    const codes = [];
    for (const s of p.segs) { const m = re.exec(s.text); if (m) codes.push({ ...s, code: normCode(m[0]), lines: s.text.slice(m[0].length).trim() ? [{ ...s, text: s.text.slice(m[0].length).trim() }] : [] }); }
    if (!codes.length) continue;
    const codeX = Math.min(...codes.map((c) => c.x));
    const size = codes[0].size;
    for (const s of p.segs) {
      if (codes.some((c) => c.y === s.y && c.x === s.x) || s.x < codeX + 20 || Math.abs(s.size - size) > 0.6) continue;
      const c = codes.filter((k) => k.y >= s.y - 1.5).sort((a, b) => a.y - b.y)[0];
      c?.lines.push(s);
    }
    for (const c of codes) out.set(c.code, joinText(c.lines));
  }
  return out;
}
