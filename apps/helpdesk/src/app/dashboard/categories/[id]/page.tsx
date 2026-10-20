import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getAllCategories } from "@/lib/categories";
import { CategoryEditor } from "@/components/category-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit category" };

export default async function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const category = (await getAllCategories()).find((c) => c.id === id);
  if (!category) notFound();

  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/dashboard/categories" className="text-sm font-medium text-blue-700 hover:underline">
        ← All categories
      </Link>
      <h1 className="text-xl font-bold">Edit {category.name}</h1>
      <CategoryEditor initial={category} />
    </div>
  );
}
