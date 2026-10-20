import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser, isAgent } from "@/lib/auth";
import { canReadArticle } from "@/lib/kb";
import { getAllCategories } from "@/lib/categories";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Help Center" };

export default async function HelpCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  const q = (await searchParams).q?.trim() ?? "";

  // Normalized substring match so "wifi" finds "Wi-Fi" — fine at school-KB scale.
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const terms = q.split(/\s+/).map(normalize).filter(Boolean);

  const articles = (
    await prisma.article.findMany({
      orderBy: [{ category: "asc" }, { title: "asc" }],
    })
  )
    .filter((article) => canReadArticle(user, article))
    .filter((article) => {
      if (terms.length === 0) return true;
      const haystack = normalize(`${article.title} ${article.body}`);
      return terms.every((term) => haystack.includes(term));
    });

  const categories = await getAllCategories();
  const byCategory = categories
    .map((c) => ({
      key: c.key,
      meta: { label: c.name, shape: c.shape, tone: `text-${c.color}` },
      articles: articles.filter((a) => a.category === c.key),
    }))
    .filter((group) => group.articles.length > 0);

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">Help Center</h1>
          <p className="mt-1 text-sm text-slate-600">
            Quick fixes and how-tos — check here first, it might save you a ticket.
          </p>
        </div>

        <form method="GET" className="mb-6 flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search articles…"
            className="input flex-1"
          />
          <button type="submit" className="btn-primary">Search</button>
        </form>

        {byCategory.length === 0 ? (
          <div className="card px-6 py-12 text-center text-sm text-slate-500">
            {q ? (
              <>
                Nothing found for &ldquo;{q}&rdquo;.{" "}
                <Link href="/" className="font-medium text-blue-700 hover:underline">
                  Submit a request
                </Link>{" "}
                and we&apos;ll help.
              </>
            ) : (
              "No articles yet — check back soon."
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {byCategory.map((group) => (
              <section key={group.key}>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
                  <span aria-hidden className={`shape shape-${group.meta.shape} ${group.meta.tone}`} /> {group.meta.label}
                </h2>
                <ul className="card divide-y divide-slate-100">
                  {group.articles.map((article) => (
                    <li key={article.id}>
                      <Link
                        href={`/kb/${article.slug}`}
                        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
                      >
                        <span className="font-medium text-slate-800">
                          {article.title}
                          {!article.published && (
                            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                              Draft
                            </span>
                          )}
                        </span>
                        <span aria-hidden className="text-slate-300">→</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        <p className="mt-8 text-center text-sm text-slate-500">
          Didn&apos;t find it?{" "}
          <Link href="/" className="font-medium text-blue-700 hover:underline">
            Submit a request
          </Link>
        </p>
      </main>
    </div>
  );
}
