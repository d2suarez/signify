import { Zip, ZipError } from "./zip";
import { parseXml, XmlError, kid, kids, find, textOf, type XmlNode } from "./xml";
import { htmlToBlocks, cleanRef } from "./html-text";
import { normalizeBlocks, webLink, type Block } from "./blocks";
import { LIMITS as ASSIGNMENT_LIMITS } from "./assignments";

/**
 * Reads an IMS Common Cartridge (1.1–1.3; Schoology's and Canvas's course
 * exports) into an import plan: units with lessons and assignments, plus
 * everything that couldn't be brought in, said plainly. Pure apart from the
 * zip it is handed: nothing is written here (cc-import.ts writes a plan).
 *
 * - The organization tree gives the units: each top-level folder is a unit,
 *   and everything inside it (sub-folders flattened, in order) its lessons
 *   and assignments. Items outside any folder land in "no unit".
 * - Web pages become lessons (html-text.ts: plain text, split at headings).
 * - Weblinks become lessons with one link block.
 * - Assignments (CC 1.3 `assignment_xmlv1p0`, Canvas's assignment_settings,
 *   and look-alikes) become assignments: title, instructions, points, due date.
 * - Quizzes (QTI) and discussions are skipped and listed; their source XML is
 *   kept so a later quiz feature can read it.
 * - Files (PDFs, images, documents) are listed as not imported.
 */

export type PlanLesson = { kind: "lesson"; title: string; blocks: Block[] };
export type PlanAssignment = {
  kind: "assignment"; title: string; instructions: string; points: number | null;
  dueOn: string | null; dueAt: string | null;
};
export type PlanItem = PlanLesson | PlanAssignment;
export type PlanUnit = { title: string; items: PlanItem[] };

export type SkipKind = "quiz" | "discussion" | "tool" | "file" | "other";
export type Skipped = { kind: SkipKind; title: string; unit: string | null };
/** A skipped quiz or discussion, with its source kept for later. */
export type KeptSource = { kind: "quiz" | "discussion"; title: string; unit: string | null; source: string };

export type Plan = {
  courseTitle: string;
  version: string;
  units: PlanUnit[];
  /** Items outside any folder. */
  loose: PlanItem[];
  skipped: Skipped[];
  kept: KeptSource[];
  /** Files and images that pages use, which weren't brought in. */
  missingFiles: string[];
  warnings: string[];
};

export type PlanSummary = {
  units: number; lessons: number; assignments: number; datedAssignments: number;
  quizzes: number; discussions: number; tools: number; files: number; other: number;
};

export class CartridgeError extends Error {
  constructor(readonly code: string) { super(code); }
}

export const PLAN_LIMITS = { units: 300, items: 3_000, keptSource: 1_000_000 };

/** Never more than this many names in one list sent to the browser. */
const LIST_CAP = 200;

type Resource = { id: string; type: string; href: string; files: string[]; base: string };

const posix = {
  dirname: (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""),
  /** Joins and resolves `.`/`..`; null if it climbs above the archive root. */
  join(base: string, rel: string): string | null {
    const parts: string[] = [];
    for (const seg of `${base}/${rel}`.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") { if (!parts.length) return null; parts.pop(); }
      else parts.push(seg);
    }
    return parts.join("/");
  },
};

export function readCartridge(buf: Buffer, opts: { schoolTz?: string } = {}): Plan {
  let zip: Zip;
  try {
    zip = new Zip(buf);
  } catch (e) {
    if (e instanceof ZipError) throw new CartridgeError(e.message);
    throw e;
  }
  try {
    return readZip(zip, opts.schoolTz ?? "America/New_York");
  } catch (e) {
    if (e instanceof ZipError) throw new CartridgeError(e.message);
    if (e instanceof XmlError) throw new CartridgeError("bad-xml");
    throw e;
  }
}

function xmlAt(zip: Zip, path: string): XmlNode | null {
  const s = zip.text(path);
  if (s === null) return null;
  try {
    return parseXml(s);
  } catch (e) {
    if (e instanceof XmlError) return null;
    throw e;
  }
}

function readZip(zip: Zip, tz: string): Plan {
  const manifestText = zip.text("imsmanifest.xml");
  if (manifestText === null) throw new CartridgeError("no-manifest");
  let manifest: XmlNode;
  try {
    manifest = parseXml(manifestText);
  } catch (e) {
    throw new CartridgeError(e instanceof XmlError && e.message === "doctype" ? "doctype" : "bad-xml");
  }
  if (manifest.name !== "manifest") throw new CartridgeError("no-manifest");

  const plan: Plan = {
    courseTitle: line(textOf(find(find(kid(manifest, "metadata"), "general"), "title"))),
    version: line(textOf(find(kid(manifest, "metadata"), "schemaversion"))),
    units: [], loose: [], skipped: [], kept: [], missingFiles: [], warnings: [],
  };
  const missing = new Set<string>();

  // Resources by identifier.
  const resources = new Map<string, Resource>();
  const resNode = kid(manifest, "resources");
  const rootBase = resNode?.attrs.base ?? "";
  for (const r of kids(resNode, "resource")) {
    const id = r.attrs.identifier;
    if (!id) continue;
    const base = posix.join(rootBase, r.attrs.base ?? "") ?? "";
    const join = (h: string) => (h ? posix.join(base, cleanRef(h)) : null);
    resources.set(id, {
      id,
      type: (r.attrs.type ?? "").toLowerCase(),
      href: join(r.attrs.href ?? "") ?? "",
      files: kids(r, "file").map((f) => join(f.attrs.href ?? "")).filter((f): f is string => !!f),
      base,
    });
  }

  let count = 0;
  const used = new Set<string>();
  const take = (item: XmlNode, unit: string | null, into: PlanItem[]) => {
    const ref = item.attrs.identifierref;
    const title = line(textOf(kid(item, "title")));
    const res = ref ? resources.get(ref) : undefined;
    if (!res) return;
    used.add(res.id);
    if (++count > PLAN_LIMITS.items) throw new CartridgeError("too-many-items");
    const got = fromResource(zip, res, title, unit, tz, plan, missing);
    if (got) into.push(got);
  };
  /** Every item below a folder, in order, sub-folders flattened. */
  const walk = (node: XmlNode, unit: string | null, into: PlanItem[]) => {
    for (const child of kids(node, "item")) {
      if (child.attrs.identifierref) take(child, unit, into);
      else walk(child, unit, into);
    }
  };

  const orgs = kids(kid(manifest, "organizations"), "organization");
  if (orgs.length) {
    let top = kids(orgs[0], "item");
    // A rooted hierarchy wraps everything in one item with no resource (often
    // the course itself or "LearningModules"): its children are the real top level.
    if (top.length === 1 && !top[0].attrs.identifierref && kids(top[0], "item").length) top = kids(top[0], "item");
    for (const item of top) {
      if (item.attrs.identifierref) { take(item, null, plan.loose); continue; }
      if (plan.units.length >= PLAN_LIMITS.units) throw new CartridgeError("too-many-items");
      const unit: PlanUnit = { title: line(textOf(kid(item, "title"))) || "Untitled unit", items: [] };
      walk(item, unit.title, unit.items);
      plan.units.push(unit);
    }
  }

  // Canvas keeps assignments that aren't in any module only among the
  // resources; bring those in too, outside any unit.
  for (const res of resources.values()) {
    if (used.has(res.id) || !isAssignment(zip, res)) continue;
    if (++count > PLAN_LIMITS.items) throw new CartridgeError("too-many-items");
    const got = fromResource(zip, res, "", null, tz, plan, missing);
    if (got) plan.loose.push(got);
  }

  // Files the pages use that are also files in the archive or links elsewhere.
  plan.missingFiles = [...missing].sort().slice(0, LIST_CAP);
  if (missing.size > LIST_CAP) plan.warnings.push(`more-files:${missing.size - LIST_CAP}`);
  if (!plan.units.length && !plan.loose.length && !plan.skipped.length) plan.warnings.push("empty");
  return plan;
}

function line(s: string, max = 200): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

const isQuiz = (t: string) => t.includes("imsqti") || /assessment|question-bank/.test(t);
const isDiscussion = (t: string) => t.startsWith("imsdt");
const isWeblink = (t: string) => t.startsWith("imswl");
const isTool = (t: string) => t.includes("basiclti") || t.includes("imslti");

function isAssignment(zip: Zip, r: Resource): boolean {
  if (r.type.includes("assignment")) return true;
  return r.type.includes("learning-application-resource") && !!canvasSettings(r);
}

const canvasSettings = (r: Resource) => r.files.find((f) => /(^|\/)assignment_settings\.xml$/i.test(f));

function fromResource(
  zip: Zip, res: Resource, title: string, unit: string | null, tz: string, plan: Plan, missing: Set<string>,
): PlanItem | null {
  const t = res.type;
  const skip = (kind: SkipKind, fallback: string) => {
    plan.skipped.push({ kind, title: title || fallback, unit });
    return null;
  };

  if (isDiscussion(t)) {
    const x = xmlAt(zip, res.href || res.files[0] || "");
    const name = title || line(textOf(kid(x ?? undefined, "title"))) || "Discussion";
    const text = textOf(kid(x ?? undefined, "text"));
    plan.kept.push({ kind: "discussion", title: name, unit, source: text.slice(0, PLAN_LIMITS.keptSource) });
    return skip("discussion", name);
  }
  if (isQuiz(t)) {
    const path = res.href || res.files.find((f) => f.endsWith(".xml")) || "";
    const xml = path ? zip.text(path) : null;
    const name = title || line(textOf(find(xml ? safeParse(xml) : undefined, "title"))) || "Quiz";
    if (xml !== null && xml.length <= PLAN_LIMITS.keptSource) plan.kept.push({ kind: "quiz", title: name, unit, source: xml });
    return skip("quiz", name);
  }
  if (isTool(t)) return skip("tool", "External tool");
  if (isWeblink(t)) {
    const x = xmlAt(zip, res.href || res.files[0] || "");
    const url = webLink(kid(x ?? undefined, "url")?.attrs.href ?? "");
    const name = title || line(textOf(kid(x ?? undefined, "title"))) || "Link";
    if (!url) return skip("other", name);
    return { kind: "lesson", title: name, blocks: normalizeBlocks([{ type: "link", title: name, url }]) };
  }
  if (isAssignment(zip, res)) return assignmentFrom(zip, res, title, tz, missing);
  if (t === "webcontent" || t.startsWith("associatedcontent")) {
    const href = res.href || res.files[0] || "";
    if (/\.x?html?$/i.test(href)) {
      const html = zip.text(href);
      if (html === null) return skip("file", title || href);
      const page = htmlToBlocks(html, title);
      noteMissing(zip, href, page.missing, missing);
      const name = title || line(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "") || "Untitled lesson";
      return { kind: "lesson", title: name, blocks: normalizeBlocks(page.blocks) };
    }
    return skip("file", title || href.split("/").pop() || "File");
  }
  return skip("other", title || "Item");
}

function safeParse(xml: string): XmlNode | undefined {
  try { return parseXml(xml); } catch { return undefined; }
}

/** Records what a page used that wasn't brought in, as paths inside the archive where they resolve. */
function noteMissing(zip: Zip, pageHref: string, refs: string[], into: Set<string>) {
  for (const ref of refs) {
    if (/^https?:/i.test(ref)) { into.add(ref); continue; }
    const inPage = posix.join(posix.dirname(pageHref), ref);
    const fromBase = posix.join("web_resources", ref);
    const found = [inPage, fromBase, ref].find((p) => p && zip.has(p));
    into.add(found ?? ref);
  }
}

function assignmentFrom(zip: Zip, res: Resource, title: string, tz: string, missing: Set<string>): PlanAssignment {
  let name = title;
  let instructions = "";
  let points: number | null = null;
  let due: string | null = null;

  const settingsPath = canvasSettings(res);
  if (settingsPath) {
    // Canvas: assignment_settings.xml holds the facts, the resource's page holds the instructions.
    const s = xmlAt(zip, settingsPath);
    name ||= line(textOf(kid(s ?? undefined, "title")));
    points = num(textOf(kid(s ?? undefined, "points_possible")));
    due = line(textOf(kid(s ?? undefined, "due_at"))) || null;
    const page = res.href && /\.x?html?$/i.test(res.href) ? res.href : res.files.find((f) => /\.x?html?$/i.test(f));
    if (page) instructions = pageText(zip, page, missing);
  } else {
    // CC 1.3 assignment extension (and look-alikes): <assignment><title/><text texttype="text/html"/><gradable points_possible="10"/>.
    const path = res.href && res.href.endsWith(".xml") ? res.href : res.files.find((f) => f.endsWith(".xml")) ?? "";
    const x = path ? xmlAt(zip, path) : null;
    if (x) {
      name ||= line(textOf(kid(x, "title")));
      const body = kid(x, "text") ?? kid(x, "instructions") ?? kid(x, "description");
      if (body) {
        const raw = textOf(body);
        const isHtml = (body.attrs.texttype ?? "").includes("html") || /<[a-z][\s\S]*>/i.test(raw);
        instructions = isHtml ? blocksText(htmlToBlocks(raw), path, zip, missing) : raw.trim();
      }
      const gradable = find(x, "gradable");
      points = num(gradable?.attrs.points_possible ?? textOf(find(x, "points_possible") ?? find(x, "max_points") ?? find(x, "points")));
      due = line(textOf(find(x, "due_at") ?? find(x, "due_date") ?? find(x, "duedate") ?? find(x, "due"))) || null;
    } else {
      const page = res.files.find((f) => /\.x?html?$/i.test(f));
      if (page) instructions = pageText(zip, page, missing);
    }
  }

  const when = due ? dueFrom(due, tz) : null;
  return {
    kind: "assignment",
    title: name || "Untitled assignment",
    instructions: instructions.slice(0, ASSIGNMENT_LIMITS.instructions),
    points: points === null ? null : Math.min(ASSIGNMENT_LIMITS.maxPoints, Math.max(0, points)),
    dueOn: when?.dueOn ?? null,
    dueAt: when?.dueAt ?? null,
  };
}

function pageText(zip: Zip, href: string, missing: Set<string>): string {
  const html = zip.text(href);
  return html === null ? "" : blocksText(htmlToBlocks(html), href, zip, missing);
}

/** A page flattened into one piece of text, for assignment instructions. */
function blocksText(page: ReturnType<typeof htmlToBlocks>, href: string, zip: Zip, missing: Set<string>): string {
  noteMissing(zip, href, page.missing, missing);
  return page.blocks
    .map((b) => (b.type === "text" ? [b.title, b.body].filter(Boolean).join("\n\n") : [b.title, b.url].filter(Boolean).join(": ")))
    .filter(Boolean)
    .join("\n\n");
}

function num(s: string): number | null {
  const n = Number(String(s).trim());
  return String(s).trim() !== "" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/**
 * A due date as exports write it ("2026-11-03T23:59:00Z", "2026-11-03 23:59:00",
 * "2026-11-03") into the school's day and moment. A time with no zone is the
 * school's wall-clock time; a date alone is due at 11:59 pm that day.
 */
export function dueFrom(raw: string, tz: string): { dueOn: string; dueAt: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const h = m[4] ? Number(m[4]) : 23;
  const mi = m[5] ? Number(m[5]) : 59;
  const s = m[6] ? Number(m[6]) : 0;
  let at: Date;
  if (m[7]) {
    const zone = m[7] === "Z" ? "Z" : m[7].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    at = new Date(`${m[1]}-${m[2]}-${m[3]}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}${zone}`);
  } else {
    at = wallToUtc(y, mo, d, h, mi, s, tz);
  }
  if (Number.isNaN(at.getTime())) return null;
  return { dueOn: dayIn(at, tz), dueAt: at.toISOString() };
}

function zoneOffset(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let at = new Date(guess - zoneOffset(new Date(guess), tz));
  at = new Date(guess - zoneOffset(at, tz));
  return at;
}

function dayIn(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function summarize(plan: Plan): PlanSummary {
  const items = [...plan.loose, ...plan.units.flatMap((u) => u.items)];
  const skipped = (k: SkipKind) => plan.skipped.filter((s) => s.kind === k).length;
  return {
    units: plan.units.length,
    lessons: items.filter((i) => i.kind === "lesson").length,
    assignments: items.filter((i) => i.kind === "assignment").length,
    datedAssignments: items.filter((i) => i.kind === "assignment" && i.dueOn).length,
    quizzes: skipped("quiz"),
    discussions: skipped("discussion"),
    tools: skipped("tool"),
    files: skipped("file"),
    other: skipped("other"),
  };
}
