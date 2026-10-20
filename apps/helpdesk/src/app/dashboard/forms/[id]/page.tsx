import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getAllCategories } from "@/lib/categories";
import { requireAdmin } from "@/lib/auth";
import { parseFields, parseRoles } from "@/lib/forms";
import { FormBuilder } from "@/components/form-builder";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit form" };

export default async function EditFormPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const categories = (await getAllCategories()).map((c) => ({ key: c.key, name: c.name }));
  const { id } = await params;
  const form = await prisma.form.findUnique({ where: { id } });
  if (!form) notFound();

  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/dashboard/forms" className="text-sm font-medium text-blue-700 hover:underline">
        ← All forms
      </Link>
      <h1 className="text-xl font-bold">Edit form</h1>
      <FormBuilder
          categories={categories}
        initial={{
          id: form.id,
          name: form.name,
          description: form.description,
          category: form.category,
          active: form.active,
          roles: parseRoles(form.roles),
          fields: parseFields(form.fieldsJson),
        }}
      />
    </div>
  );
}
