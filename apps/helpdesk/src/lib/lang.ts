import { cookies } from "next/headers";
import { DICTS, type Dict, type Lang } from "./i18n";

export async function getLang(): Promise<Lang> {
  const cookieStore = await cookies();
  return cookieStore.get("lang")?.value === "es" ? "es" : "en";
}

export async function getDict(): Promise<{ lang: Lang; t: Dict }> {
  const lang = await getLang();
  return { lang, t: DICTS[lang] };
}
