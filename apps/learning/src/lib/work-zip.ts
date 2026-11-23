import type { Dict } from "./i18n";
import type { Submission } from "./assignments";
import type { Group } from "./groups";
import { workFor, type GroupWork } from "./group-work";
import { safeFileName, zipFiles } from "./zip-write";

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
};

const stamp = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

/** The most a zip may hold before it is refused (text only, so a whole class is a few MB). */
export const ZIP_MAX_BYTES = 50 * 1024 * 1024;
export class ZipTooBig extends Error {}

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
  const file = (base: string, heading: string, s: Submission | null, body: string | null) => {
    index.push(`${heading}: ${body && body.trim() ? status(s) : d.zipNothing}`);
    if (!body || !body.trim()) return;
    const text = `${heading}\n${z.title}\n${status(s)}\n\n${body.replace(/\r?\n/g, "\r\n")}\r\n`;
    files.push({ name: unique(base), data: Buffer.from(text, "utf8") });
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
      file(`${g.name} - ${names.join(", ")}`, `${g.name}: ${names.join(", ")}`, sub, workFor(sub, z.work.get(g.id) ?? null));
    } else if (g) {
      // "each": every member hands in their own copy of the group's text; the zip keeps each one.
      const sub = z.subs.get(st.id) ?? null;
      file(`${st.name} (${g.name})`, `${st.name} · ${g.name}`, sub, workFor(sub, z.work.get(g.id) ?? null));
    } else {
      const sub = z.subs.get(st.id) ?? null;
      file(st.name, st.name, sub, sub?.body ?? null);
    }
  }
  if (files.reduce((n, f) => n + f.data.length, 0) > ZIP_MAX_BYTES) throw new ZipTooBig();
  files.push({ name: `_${safeFileName(d.zipIndex)}.txt`, data: Buffer.from(index.join("\r\n") + "\r\n", "utf8") });
  const who = z.only ? z.students.find((s) => s.id === z.only)?.name ?? "" : "";
  return { name: `${safeFileName(who ? `${z.title} - ${who}` : z.title, "work")}.zip`, bytes: zipFiles(files, z.when), count: files.length - 1 };
}
