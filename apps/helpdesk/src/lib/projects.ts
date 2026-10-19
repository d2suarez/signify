import "server-only";
import { notFound } from "next/navigation";
import { prisma } from "./db";

/**
 * Who may do what with a project.
 *
 *   look   — members; anyone at the school when the project is set to
 *            "Everyone at school"; and help desk admins, always, so nothing
 *            planned between staff and students is out of an adult's sight.
 *   edit   — leads and editors (add tasks, move them, post updates).
 *   manage — the owner, leads and help desk admins (details, people, delete).
 */

type Viewer = { id: string; role: string; tenantId: string | null };
type ProjectAccess = {
  ownerId: string;
  visibility: string;
  tenantId: string | null;
  members: { userId: string; role: string }[];
};

export const PROJECT_STATUSES: Record<string, { label: string; badge: string }> = {
  PLANNING: { label: "Planning", badge: "bg-amber-100 text-amber-800" },
  ACTIVE: { label: "Under way", badge: "bg-blue-100 text-blue-800" },
  ON_HOLD: { label: "On hold", badge: "bg-slate-200 text-slate-600" },
  DONE: { label: "Done", badge: "bg-green-100 text-green-800" },
};

export const TASK_STATUSES: Record<string, { label: string; shape: string; tone: string }> = {
  TODO: { label: "To do", shape: "circle", tone: "text-p1" },
  DOING: { label: "Doing", shape: "triangle", tone: "text-p3" },
  DONE: { label: "Done", shape: "square", tone: "text-p4" },
};

export const MEMBER_ROLES: Record<string, { label: string; hint: string }> = {
  LEAD: { label: "Lead", hint: "Can change the project and who is on it" },
  EDITOR: { label: "Helper", hint: "Can add and move tasks and post updates" },
  VIEWER: { label: "Watching", hint: "Can see the project, but not change it" },
};

/** The four block colours a project can wear. */
export const PROJECT_COLORS = ["p2", "p1", "p4", "p3"] as const;
export const COLOR_SHAPE: Record<string, string> = { p1: "circle", p2: "square", p3: "triangle", p4: "arch" };

export function memberRole(project: ProjectAccess, user: Viewer): string | null {
  if (project.ownerId === user.id) return "LEAD";
  return project.members.find((m) => m.userId === user.id)?.role ?? null;
}

export function canView(project: ProjectAccess, user: Viewer) {
  if (user.role === "ADMIN") return true;
  if (memberRole(project, user)) return true;
  return project.visibility === "SCHOOL" && !!user.tenantId && project.tenantId === user.tenantId;
}

export function canEdit(project: ProjectAccess, user: Viewer) {
  if (user.role === "ADMIN") return true;
  const role = memberRole(project, user);
  return role === "LEAD" || role === "EDITOR";
}

export function canManage(project: ProjectAccess, user: Viewer) {
  if (user.role === "ADMIN") return true;
  return memberRole(project, user) === "LEAD";
}

/** Loads a project with what the access checks need, or 404s. */
export async function loadProject(id: string, user: Viewer) {
  const project = await prisma.project.findUnique({
    where: { id },
    include: { members: { select: { userId: true, role: true } } },
  });
  if (!project || !canView(project, user)) notFound();
  return project;
}

/** Projects this person can see, for the list page. */
export async function projectsFor(user: Viewer) {
  const mine = {
    OR: [{ ownerId: user.id }, { members: { some: { userId: user.id } } }],
  };
  const school = user.tenantId ? { visibility: "SCHOOL", tenantId: user.tenantId } : null;
  return prisma.project.findMany({
    where: user.role === "ADMIN" ? {} : school ? { OR: [mine, school] } : mine,
    include: {
      owner: { select: { id: true, name: true } },
      members: { select: { userId: true, role: true } },
      tasks: { select: { status: true, kind: true, dueDate: true } },
    },
    orderBy: [{ archived: "asc" }, { updatedAt: "desc" }],
  });
}

export { dateInput, parseDate, shortDate, dueLabel } from "./project-dates";
