import { parseRoles } from "./forms";

/** Agents see everything (including drafts); others need a published article listing their role. */
export function canReadArticle(
  user: { role: string },
  article: { published: boolean; roles: string }
): boolean {
  if (user.role === "ADMIN" || user.role === "TECH") return true;
  return article.published && parseRoles(article.roles).includes(user.role);
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "article"
  );
}
