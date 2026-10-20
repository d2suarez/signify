import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { deleteForm, setFormActive } from "@/lib/actions";
import { parseFields, parseRoles } from "@/lib/forms";
import { USER_ROLES } from "@/lib/labels";
import { getAllCategories } from "@/lib/categories";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Forms" };

export default async function FormsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const forms = await prisma.form.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { tickets: true } } },
  });
  const categoryNames = new Map((await getAllCategories()).map((c) => [c.key, c.name]));

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Forms</h1>
        <Link href="/dashboard/forms/new" className="btn-primary">New form</Link>
      </div>

      {sp.msg && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {sp.msg}
        </div>
      )}

      <p className="text-sm text-slate-500">
        Forms show up as cards on the request page for the roles you pick — e.g. a
        field-trip form only staff can see. Submissions become regular tickets.
      </p>

      {forms.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-slate-500">
          No forms yet — everyone sees just the general help request form.
        </div>
      ) : (
        <ul className="space-y-3">
          {forms.map((form) => {
            const fieldCount = parseFields(form.fieldsJson).length;
            const roles = parseRoles(form.roles);
            return (
              <li key={form.id} className={`card p-4 ${form.active ? "" : "opacity-70"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">{form.name}</p>
                  {!form.active && (
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                      Hidden
                    </span>
                  )}
                  {roles.map((role) => (
                    <span
                      key={role}
                      className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700"
                    >
                      {USER_ROLES[role] ?? role}
                    </span>
                  ))}
                </div>
                {form.description && (
                  <p className="mt-0.5 text-sm text-slate-500">{form.description}</p>
                )}
                <p className="mt-1 text-xs text-slate-400">
                  {categoryNames.get(form.category) ?? form.category} · {fieldCount}{" "}
                  {fieldCount === 1 ? "field" : "fields"} · {form._count.tickets}{" "}
                  {form._count.tickets === 1 ? "ticket" : "tickets"}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-sm">
                  <Link
                    href={`/dashboard/forms/${form.id}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    Edit
                  </Link>
                  <Link
                    href={`/f/${form.id}`}
                    target="_blank"
                    className="font-medium text-blue-700 hover:underline"
                  >
                    Preview ↗
                  </Link>
                  <form action={setFormActive.bind(null, form.id, !form.active)}>
                    <SubmitButton
                      className="cursor-pointer font-medium text-slate-600 hover:underline"
                      pendingText="…"
                    >
                      {form.active ? "Hide" : "Publish"}
                    </SubmitButton>
                  </form>
                  <details>
                    <summary className="cursor-pointer font-medium text-red-600 hover:underline">
                      Delete
                    </summary>
                    <form action={deleteForm.bind(null, form.id)} className="mt-2">
                      <SubmitButton
                        className="btn-secondary text-red-600"
                        pendingText="Deleting…"
                      >
                        Yes, delete this form
                      </SubmitButton>
                    </form>
                  </details>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
