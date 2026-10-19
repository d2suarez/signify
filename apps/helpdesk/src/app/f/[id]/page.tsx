import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canUseForm, parseFields } from "@/lib/forms";
import { DynamicForm } from "@/components/dynamic-form";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

export default async function CustomFormPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const form = await prisma.form.findUnique({ where: { id } });
  if (!form) notFound();
  if (!canUseForm(user, form)) redirect("/");

  const fields = parseFields(form.fieldsJson);

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-3xl px-4 py-8">
        {!form.active && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            This form is hidden — only admins can see it right now.
          </div>
        )}
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">{form.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {form.description || "Fill this out and the right person will follow up."}{" "}
            Submitting as <span className="font-medium text-slate-800">{user.name}</span> ({user.email}).
          </p>
        </div>

        <div className="card p-5 sm:p-8">
          <DynamicForm formId={form.id} fields={fields} />
        </div>
      </main>
    </div>
  );
}
