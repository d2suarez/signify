import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { deleteArticle } from "@/lib/actions";
import { parseRoles } from "@/lib/forms";
import { USER_ROLES, timeAgo } from "@/lib/labels";
import { getAllCategories } from "@/lib/categories";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Articles" };

export default async function ArticlesAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  await requireAgent();
  const sp = await searchParams;
  const articles = await prisma.article.findMany({
    orderBy: [{ category: "asc" }, { title: "asc" }],
  });
  const categoryNames = new Map((await getAllCategories()).map((c) => [c.key, c.name]));

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Help Center articles</h1>
        <Link href="/dashboard/kb/new" className="btn-primary">New article</Link>
      </div>

      {sp.msg && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {sp.msg}
        </div>
      )}

      <p className="text-sm text-slate-500">
        Articles appear in the{" "}
        <Link href="/kb" className="font-medium text-blue-700 hover:underline">Help Center</Link>{" "}
        for the roles you pick — write up the fixes you repeat all the time and let people help
        themselves.
      </p>

      {articles.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-slate-500">
          No articles yet. Start with your most common question — Wi-Fi, printers, forgotten
          passwords…
        </div>
      ) : (
        <ul className="space-y-3">
          {articles.map((article) => (
            <li key={article.id} className={`card p-4 ${article.published ? "" : "opacity-70"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{article.title}</p>
                {!article.published && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                    Draft
                  </span>
                )}
                {parseRoles(article.roles).map((role) => (
                  <span key={role} className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                    {USER_ROLES[role] ?? role}
                  </span>
                ))}
                <span className="ml-auto text-xs text-slate-400">
                  Updated {timeAgo(article.updatedAt)}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {categoryNames.get(article.category) ?? article.category} · /kb/{article.slug}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-sm">
                <Link href={`/dashboard/kb/${article.id}`} className="font-medium text-blue-700 hover:underline">
                  Edit
                </Link>
                <Link href={`/kb/${article.slug}`} target="_blank" className="font-medium text-blue-700 hover:underline">
                  View ↗
                </Link>
                <details>
                  <summary className="cursor-pointer font-medium text-red-600 hover:underline">Delete</summary>
                  <form action={deleteArticle.bind(null, article.id)} className="mt-2">
                    <SubmitButton className="btn-secondary text-red-600" pendingText="Deleting…">
                      Yes, delete this article
                    </SubmitButton>
                  </form>
                </details>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
