import type { Dict } from "./i18n";
import type { Submission } from "./assignments";
import type { Group } from "./groups";
import { workFor, type GroupWork } from "./group-work";
import { safeFileName, zipFiles } from "./zip-write";
import { photosPdf } from "./photo-pdf";

/**
 * Every student's (or group's) online writing for one assignment as a zip
 * (story 01, F3): one text file each, named by student or by group and its
 * members, and a list of who handed in what and when. Pure: the route
 * gathers the work and checks it's a teacher of the class.
 */
export type ZipInput = {
  title: string;
  students: { id: string; name: string }[];
  subs: Map<string, Submission>;
  /** A group assignment's groups and their shared text, or null. */
  groups: Group[] | null; work: Map<string, GroupWork>;
  /** The assignment's group hand-in: "one" = one file per group; "each" = every member's own hand-in. */
  mode: "each" | "one";
  late: (s: Submission | null) => boolean;
  /** Only this student (or their group): "one student's work". */
  only?: string;
  when: Date; d: Dict;
  /**
   * Story 01 A7: each student's handed-in (else so far) files, in order,
   * with their bytes. They go in a folder named like the text file, numbered
   * so photos keep their order, plus one PDF of the photos when there are 2+.
   */
  files?: Map<string, { name: string; kind: string; data: Buffer }[]>;
};

const stamp = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

/** The most a zip may hold before it is refused (text only, so a whole class is a few MB). */
export const ZIP_MAX_BYTES = 50 * 1024 * 1024;
export class ZipTooBig extends Error {}
/** With students' files: the most a zip may hold (the route checks sizes before reading any bytes). */
export const ZIP_FILES_MAX_BYTES = 300 * 1024 * 1024;

export function workZip(z: ZipInput): { name: string; bytes: Buffer; count: number } {
  const { d } = z;
  const used = new Set<string>();
  const unique = (base: string) => {
    let name = `${safeFileName(base, d.student)}.txt`, n = 2;
    while (used.has(name.toLowerCase())) name = `${safeFileName(base, d.student)} (${n++}).txt`;
    used.add(name.toLowerCase());
    return name;
  };
  const files: { name: string; data: Buffer }[] = [];
  const index: string[] = [`${z.title}`, ""];
  const status = (s: Submission | null) =>
    s?.submittedAt ? `${d.handedIn} ${stamp(s.submittedAt)}${z.late(s) ? ` · ${d.late}` : ""}` : s?.body ? d.workingOn : d.notHandedIn;
  const usedDirs = new Set<string>();
  const file = (base: string, heading: string, s: Submission | null, body: string | null, ownerId: string) => {
    const list = z.files?.get(ownerId) ?? [];
    const hasText = !!body && !!body.trim();
    index.push(`${heading}: ${hasText || list.length ? status(s) : d.zipNothing}${list.length ? ` · ${d.wfFilesCount.replace("{n}", String(list.length))}` : ""}`);
    if (hasText) {
      const text = `${heading}\n${z.title}\n${status(s)}\n\n${body!.replace(/\r?\n/g, "\r\n")}\r\n`;
      files.push({ name: unique(base), data: Buffer.from(text, "utf8") });
    }
    if (!list.length) return;
    let dir = safeFileName(base, d.student), n = 2;
    while (usedDirs.has(dir.toLowerCase())) dir = `${safeFileName(base, d.student)} (${n++})`;
    usedDirs.add(dir.toLowerCase());
    const width = String(list.length).length < 2 ? 2 : String(list.length).length;
    list.forEach((f, i) => files.push({ name: `${dir}/${String(i + 1).padStart(width, "0")} ${safeFileName(f.name, "file")}`, data: f.data }));
    const photos = list.filter((f) => f.kind === "image");
    if (photos.length > 1) {
      const pdf = photosPdf(photos.map((p) => p.data), `${z.title} - ${heading}`);
      if (pdf.pages) files.push({ name: `${dir}/${safeFileName(`${base} - ${d.wfOnePdf}`, "photos")}.pdf`, data: pdf.bytes });
    }
  };

  const byGroup = new Map((z.groups ?? []).flatMap((g) => g.members.map((m) => [m.id, g] as const)));
  const oneEach = z.mode === "one";
  // A member no longer on the class list is named as having left (their own work never goes in).
  const nameOf = (m: { id: string; name: string }) => z.students.find((x) => x.id === m.id)?.name ?? `${m.name} (${d.zipLeft})`;
  const done = new Set<string>();
  for (const st of z.students) {
    // One student's download: their group's file in "one" mode, only their own otherwise.
    if (z.only && st.id !== z.only && !(oneEach && byGroup.get(z.only)?.members.some((m) => m.id === st.id))) continue;
    const g = byGroup.get(st.id);
    if (g && oneEach) {
      if (done.has(g.id)) continue;
      done.add(g.id);
      const names = g.members.map(nameOf);
      const sub = g.members.map((m) => z.subs.get(m.id) ?? null).find((s) => s?.submittedAt) ?? null;
      const holder = g.members.find((m) => z.subs.get(m.id)?.submittedAt)?.id ?? st.id;
      file(`${g.name} - ${names.join(", ")}`, `${g.name}: ${names.join(", ")}`, sub, workFor(sub, z.work.get(g.id) ?? null), holder);
    } else if (g) {
      // "each": every member hands in their own copy of the group's text; the zip keeps each one.
      const sub = z.subs.get(st.id) ?? null;
      file(`${st.name} (${g.name})`, `${st.name} · ${g.name}`, sub, workFor(sub, z.work.get(g.id) ?? null), st.id);
    } else {
      const sub = z.subs.get(st.id) ?? null;
      file(st.name, st.name, sub, sub?.body ?? null, st.id);
    }
  }
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > (z.files?.size ? ZIP_FILES_MAX_BYTES : ZIP_MAX_BYTES)) throw new ZipTooBig();
  files.push({ name: `_${safeFileName(d.zipIndex)}.txt`, data: Buffer.from(index.join("\r\n") + "\r\n", "utf8") });
  const who = z.only ? z.students.find((s) => s.id === z.only)?.name ?? "" : "";
  return { name: `${safeFileName(who ? `${z.title} - ${who}` : z.title, "work")}.zip`, bytes: zipFiles(files, z.when), count: files.length - 1 };
}
