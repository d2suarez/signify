import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getAllCategories } from "@/lib/categories";
import { requireAgent } from "@/lib/auth";
import { parseRoles } from "@/lib/forms";
import { ArticleForm } from "@/components/article-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit article" };

export default async function EditArticlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAgent();
  const categories = (await getAllCategories()).map((c) => ({ key: c.key, name: c.name }));
  const { id } = await params;
  const article = await prisma.article.findUnique({ where: { id } });
  if (!article) notFound();

  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/dashboard/kb" className="text-sm font-medium text-blue-700 hover:underline">
        ← All articles
      </Link>
      <h1 className="text-xl font-bold">Edit article</h1>
      <div className="card p-5">
        <ArticleForm
          categories={categories}
          initial={{
            id: article.id,
            title: article.title,
            body: article.body,
            category: article.category,
            published: article.published,
            roles: parseRoles(article.roles),
          }}
        />
      </div>
    </div>
  );
}
