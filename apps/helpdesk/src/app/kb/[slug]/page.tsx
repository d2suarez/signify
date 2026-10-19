import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canReadArticle } from "@/lib/kb";
import { CategoryLabel } from "@/components/badges";
import { formatDateTime } from "@/lib/labels";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const user = await requireUser();
  const { slug } = await params;
  const article = await prisma.article.findUnique({ where: { slug } });
  if (!article || !canReadArticle(user, article)) notFound();

  const html = await marked.parse(article.body);

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link href="/kb" className="text-sm font-medium text-blue-700 hover:underline">
          ← Help Center
        </Link>

        <article className="card mt-4 p-5 sm:p-8">
          {!article.published && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Draft — only the help desk team can see this.
            </div>
          )}
          <h1 className="text-2xl font-bold tracking-tight">{article.title}</h1>
          <p className="mt-1 text-xs text-slate-400">
            <CategoryLabel category={article.category} /> · Updated{" "}
            {formatDateTime(article.updatedAt)}
          </p>
          <div
            className="kb-content mt-6"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </article>

        <div className="mt-6 text-center text-sm text-slate-500">
          Still stuck?{" "}
          <Link href="/" className="font-medium text-blue-700 hover:underline">
            Submit a request
          </Link>{" "}
          and a real person will help.
        </div>
      </main>
    </div>
  );
}
