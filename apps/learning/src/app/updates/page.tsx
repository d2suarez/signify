import { redirect } from "next/navigation";

/**
 * No separate Updates page (Desmond, 2026-11-23): the home page shows every
 * update and each class page its own. Old links and bookmarks land on home.
 * One post with its comments is still /updates/[id].
 */
export default function UpdatesPage() {
  redirect("/");
}
