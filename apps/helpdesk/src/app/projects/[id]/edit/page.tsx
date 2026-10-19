import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canManage, dateInput, loadProject } from "@/lib/projects";
import { deleteProject, setProjectArchived, updateProject } from "@/lib/project-actions";
import { ProjectForm } from "@/components/projects/project-form";
import { SiteHeader } from "@/components/site-header";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit project" };

export default async function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const project = await loadProject(id, user);
  if (!canManage(project, user)) redirect(`/projects/${id}`);
  const canDelete = project.ownerId === user.id || user.role === "ADMIN";

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <Link href={`/projects/${id}`} className="text-sm font-medium text-slate-600 hover:text-slate-900">{project.title}</Link>
        <h1 className="mb-6 mt-1 text-3xl font-extrabold tracking-tight">Edit project</h1>
        <div className="card p-6">
          <ProjectForm
            action={updateProject.bind(null, id)}
            submitLabel="Save"
            initial={{
              title: project.title,
              description: project.description,
              color: project.color,
              status: project.status,
              visibility: project.visibility,
              startDate: dateInput(project.startDate),
              dueDate: dateInput(project.dueDate),
            }}
          />
        </div>

        <div className="card mt-6 space-y-4 p-6">
          <div>
            <h2 className="text-lg font-bold">{project.archived ? "Bring it back" : "Archive"}</h2>
            <p className="text-sm text-slate-600">
              {project.archived
                ? "Put the project back with the current ones."
                : "Tidy a finished project away. Everything in it is kept, and you can bring it back."}
            </p>
            <form action={setProjectArchived.bind(null, id, !project.archived)} className="mt-3">
              <SubmitButton className="btn-secondary" pendingText="…">{project.archived ? "Bring back" : "Archive project"}</SubmitButton>
            </form>
          </div>
          {canDelete && (
            <div className="border-t border-slate-200 pt-4">
              <h2 className="text-lg font-bold">Delete</h2>
              <p className="text-sm text-slate-600">Deletes the project, its tasks and its updates for everyone. This can&apos;t be undone.</p>
              <form action={deleteProject.bind(null, id)} className="mt-3 space-y-3">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="confirm" value="yes" required className="h-4 w-4 accent-[var(--p1)]" />
                  Yes, delete it for everyone
                </label>
                <SubmitButton className="btn-danger" pendingText="Deleting…">Delete project</SubmitButton>
              </form>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
