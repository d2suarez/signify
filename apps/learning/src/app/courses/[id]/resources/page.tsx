import { redirect } from "next/navigation";

/**
 * The Resources tab is gone (Desmond, 2026-11-23: "We don't need a separate
 * resources tab"): materials live in the class's folders, with "Not in a
 * folder", archived materials and "Present ticked" (Organize) on the class
 * page, and are made from its Create menu. Old links and bookmarks land
 * there; `?unit=` (a folder's old "Add material here") opens Create for it.
 */
export default async function ResourcesPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ unit?: string }>;
}) {
  const [{ id }, { unit }] = await Promise.all([params, searchParams]);
  const safe = (v: string | undefined) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) redirect("/");
  redirect(safe(unit) ? `/courses/${id}/new?what=link&in=${safe(unit)}` : `/courses/${id}`);
}
