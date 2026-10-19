import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { FormBuilder } from "@/components/form-builder";

export const dynamic = "force-dynamic";
export const metadata = { title: "New form" };

export default async function NewFormPage() {
  await requireAdmin();

  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/dashboard/forms" className="text-sm font-medium text-blue-700 hover:underline">
        ← All forms
      </Link>
      <h1 className="text-xl font-bold">New form</h1>
      <FormBuilder initial={null} />
    </div>
  );
}
