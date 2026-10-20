import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { CategoryEditor } from "@/components/category-editor";

export const dynamic = "force-dynamic";
export const metadata = { title: "New category" };

export default async function NewCategoryPage() {
  await requireAdmin();
  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/dashboard/categories" className="text-sm font-medium text-blue-700 hover:underline">
        ← All categories
      </Link>
      <h1 className="text-xl font-bold">New category</h1>
      <CategoryEditor initial={null} />
    </div>
  );
}
