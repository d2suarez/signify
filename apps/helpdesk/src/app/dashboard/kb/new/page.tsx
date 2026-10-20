import Link from "next/link";
import { getAllCategories } from "@/lib/categories";
import { requireAgent } from "@/lib/auth";
import { ArticleForm } from "@/components/article-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "New article" };

export default async function NewArticlePage() {
  await requireAgent();
  const categories = (await getAllCategories()).map((c) => ({ key: c.key, name: c.name }));

  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/dashboard/kb" className="text-sm font-medium text-blue-700 hover:underline">
        ← All articles
      </Link>
      <h1 className="text-xl font-bold">New article</h1>
      <div className="card p-5">
        <ArticleForm initial={null} categories={categories} />
      </div>
    </div>
  );
}
