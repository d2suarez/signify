import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createProject } from "@/lib/project-actions";
import { ProjectForm } from "@/components/projects/project-form";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "New project" };

export default async function NewProjectPage() {
  await requireUser();
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <Link href="/projects" className="text-sm font-medium text-slate-600 hover:text-slate-900">Projects</Link>
        <h1 className="mb-6 mt-1 text-3xl font-extrabold tracking-tight">New project</h1>
        <div className="card p-6">
          <ProjectForm action={createProject} submitLabel="Start the project" />
        </div>
        <p className="mt-4 text-sm text-slate-500">You can add people and tasks once it is started.</p>
      </main>
    </div>
  );
}
