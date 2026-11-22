import "server-only";
import type { MyCourse } from "./courses";
import { postablePlaces, materialChoices, type Viewer, type MaterialChoice } from "./updates";
import { uploadsOn } from "./files";
import type { ComposerPlace } from "@/components/PostComposer";

/**
 * What the update editor offers this person: every place they may post to
 * now (whole school first, then classes, then clubs), the Learning material
 * they may link (teachers), and whether they may add pictures and files.
 */
export async function composerSetup(v: Viewer, courses: MyCourse[], wholeSchool: string): Promise<{
  places: ComposerPlace[]; materials: MaterialChoice[]; canUpload: boolean; uploadFallback: string | null;
}> {
  const [{ courseIds, school }, materials] = await Promise.all([postablePlaces(v), materialChoices(v)]);
  const byId = new Map(courses.map((c) => [c.id, c]));
  const list = courseIds.map((id) => byId.get(id)).filter((c): c is MyCourse => !!c)
    .sort((a, b) => Number(a.kind === "club") - Number(b.kind === "club") || Number(b.role === "teacher") - Number(a.role === "teacher") || a.name.localeCompare(b.name));
  const places: ComposerPlace[] = [
    ...(school ? [{ id: "school", name: wholeSchool, kind: "school" as const, teach: false }] : []),
    ...list.map((c) => ({ id: c.id, name: c.name, kind: c.kind === "club" ? "club" as const : "class" as const, teach: c.role === "teacher" })),
  ];
  const taught = list.find((c) => c.role === "teacher");
  return {
    places, materials,
    canUpload: uploadsOn() && (!!taught || school),
    uploadFallback: taught?.id ?? null,
  };
}
