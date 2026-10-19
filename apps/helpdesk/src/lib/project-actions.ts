"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { requireUser } from "./auth";
import { notifyUsers } from "./notify";
import { canEdit, canManage, loadProject, parseDate, PROJECT_COLORS, PROJECT_STATUSES, TASK_STATUSES, MEMBER_ROLES } from "./projects";
import type { FormState } from "./actions";

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

const path = (id: string) => `/projects/${id}`;

async function logUpdate(projectId: string, authorId: string, body: string) {
  await prisma.projectUpdate.create({ data: { projectId, authorId, body, system: true } });
  await prisma.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
}

/* ---------- Projects ---------- */

export async function createProject(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const title = field(formData, "title");
  if (!title) return { error: "Give the project a name." };
  if (title.length > 120) return { error: "That name is too long." };
  const color = field(formData, "color");
  const project = await prisma.project.create({
    data: {
      title,
      description: field(formData, "description").slice(0, 5000),
      color: (PROJECT_COLORS as readonly string[]).includes(color) ? color : "p2",
      visibility: field(formData, "visibility") === "SCHOOL" ? "SCHOOL" : "MEMBERS",
      startDate: parseDate(field(formData, "startDate")),
      dueDate: parseDate(field(formData, "dueDate")),
      tenantId: user.tenantId,
      ownerId: user.id,
      members: { create: { userId: user.id, role: "LEAD" } },
    },
  });
  await logUpdate(project.id, user.id, `${user.name} started the project.`);
  redirect(path(project.id));
}

export async function updateProject(projectId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  if (!canManage(project, user)) return { error: "Only a lead can change the project." };
  const title = field(formData, "title");
  if (!title) return { error: "Give the project a name." };
  const color = field(formData, "color");
  const status = field(formData, "status");
  await prisma.project.update({
    where: { id: projectId },
    data: {
      title: title.slice(0, 120),
      description: field(formData, "description").slice(0, 5000),
      color: (PROJECT_COLORS as readonly string[]).includes(color) ? color : project.color,
      status: PROJECT_STATUSES[status] ? status : project.status,
      visibility: field(formData, "visibility") === "SCHOOL" ? "SCHOOL" : "MEMBERS",
      startDate: parseDate(field(formData, "startDate")),
      dueDate: parseDate(field(formData, "dueDate")),
    },
  });
  if (status && status !== project.status && PROJECT_STATUSES[status]) {
    await logUpdate(projectId, user.id, `${user.name} marked the project ${PROJECT_STATUSES[status].label.toLowerCase()}.`);
  }
  revalidatePath(path(projectId));
  return { message: "Saved." };
}

export async function setProjectArchived(projectId: string, archived: boolean) {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  if (!canManage(project, user)) return;
  await prisma.project.update({ where: { id: projectId }, data: { archived } });
  await logUpdate(projectId, user.id, `${user.name} ${archived ? "archived" : "brought back"} the project.`);
  revalidatePath(path(projectId));
  revalidatePath("/projects");
}

export async function deleteProject(projectId: string, formData: FormData) {
  const user = await requireUser();
  if (field(formData, "confirm") !== "yes") return;
  const project = await loadProject(projectId, user);
  if (!(project.ownerId === user.id || user.role === "ADMIN")) return;
  await prisma.project.delete({ where: { id: projectId } });
  redirect("/projects?msg=Project+deleted.");
}

/* ---------- People ---------- */

/** Adds someone by picking them from the school, or by their school address. */
export async function addMember(projectId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  if (!canManage(project, user)) return { error: "Only a lead can add people." };

  const role = MEMBER_ROLES[field(formData, "role")] ? field(formData, "role") : "EDITOR";
  const userId = field(formData, "userId");
  const email = field(formData, "email").toLowerCase();

  let person = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  if (!person && email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "That address doesn't look right." };
    // Only addresses at your own school. Someone from outside can't be pulled
    // into a project with students just by typing their address.
    const myDomain = user.email.split("@")[1];
    if (user.role !== "ADMIN" && email.split("@")[1] !== myDomain) {
      return { error: `Only people with an @${myDomain} address can be added.` };
    }
    person = await prisma.user.findUnique({ where: { email } });
    if (!person) {
      // Not been to the help desk yet. A placeholder holds their place; the
      // first time they sign in with Signify ID, it becomes theirs.
      person = await prisma.user.create({
        data: { email, name: email.split("@")[0], role: "STAFF", tenantId: user.tenantId },
      });
    }
  }
  if (!person || !person.active) return { error: "Pick someone to add." };
  if (person.tenantId && user.tenantId && person.tenantId !== user.tenantId && user.role !== "ADMIN") {
    return { error: "That person is at a different school." };
  }

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: person.id } },
  });
  if (existing) return { error: `${person.name} is already on this project.` };

  await prisma.projectMember.create({ data: { projectId, userId: person.id, role } });
  await logUpdate(projectId, user.id, `${user.name} added ${person.name}.`);
  if (person.id !== user.id) {
    await notifyUsers([person], "projects", {
      title: `You're on “${project.title}”`,
      body: `${user.name} added you to the project.`,
      url: path(projectId),
    });
  }
  revalidatePath(path(projectId));
  return { message: `${person.name} added.` };
}

export async function setMemberRole(projectId: string, memberId: string, formData: FormData) {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  if (!canManage(project, user)) return;
  const role = field(formData, "role");
  if (!MEMBER_ROLES[role]) return;
  const member = await prisma.projectMember.findUnique({ where: { id: memberId } });
  if (!member || member.projectId !== projectId || member.userId === project.ownerId) return;
  await prisma.projectMember.update({ where: { id: memberId }, data: { role } });
  revalidatePath(path(projectId));
}

export async function removeMember(projectId: string, memberId: string) {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  const member = await prisma.projectMember.findUnique({ where: { id: memberId }, include: { user: true } });
  if (!member || member.projectId !== projectId || member.userId === project.ownerId) return;
  // A lead can remove anyone; anybody can take themselves off.
  if (!canManage(project, user) && member.userId !== user.id) return;
  await prisma.projectMember.delete({ where: { id: memberId } });
  await prisma.projectTask.updateMany({ where: { projectId, assigneeId: member.userId }, data: { assigneeId: null } });
  await logUpdate(
    projectId,
    user.id,
    member.userId === user.id ? `${user.name} left the project.` : `${user.name} took ${member.user.name} off the project.`
  );
  if (member.userId === user.id && !canManage(project, user)) redirect("/projects");
  revalidatePath(path(projectId));
}

/** People at your school who have used the help desk, for the "add someone" box. */
export async function searchPeople(projectId: string, q: string) {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  if (!canManage(project, user)) return [];
  const term = q.trim();
  if (term.length < 2) return [];
  const people = await prisma.user.findMany({
    where: {
      active: true,
      ...(user.role === "ADMIN" || !user.tenantId ? {} : { tenantId: user.tenantId }),
      OR: [{ name: { contains: term } }, { email: { startsWith: term } }],
      NOT: { projectMembers: { some: { projectId } } },
    },
    select: { id: true, name: true, email: true, roleLabel: true, role: true, picture: true },
    orderBy: { name: "asc" },
    take: 8,
  });
  return people;
}

/* ---------- Tasks ---------- */

async function checkAssignee(projectId: string, ownerId: string, assigneeId: string) {
  if (!assigneeId) return null;
  if (assigneeId === ownerId) return assigneeId;
  const m = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: assigneeId } } });
  return m ? assigneeId : null;
}

export async function addTask(projectId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  if (!canEdit(project, user)) return { error: "You can look at this project, but not change it." };
  const title = field(formData, "title");
  if (!title) return { error: "What needs doing?" };
  const status = TASK_STATUSES[field(formData, "status")] ? field(formData, "status") : "TODO";
  const assigneeId = await checkAssignee(projectId, project.ownerId, field(formData, "assigneeId"));
  const last = await prisma.projectTask.findFirst({ where: { projectId, status }, orderBy: { sortOrder: "desc" } });
  const task = await prisma.projectTask.create({
    data: {
      projectId,
      title: title.slice(0, 200),
      notes: field(formData, "notes").slice(0, 5000),
      kind: field(formData, "kind") === "MILESTONE" ? "MILESTONE" : "TASK",
      section: field(formData, "section").slice(0, 60),
      status,
      startDate: parseDate(field(formData, "startDate")),
      dueDate: parseDate(field(formData, "dueDate")),
      assigneeId,
      createdById: user.id,
      sortOrder: (last?.sortOrder ?? 0) + 1,
      completedAt: status === "DONE" ? new Date() : null,
    },
  });
  await prisma.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  if (assigneeId && assigneeId !== user.id) {
    const assignee = await prisma.user.findUnique({ where: { id: assigneeId } });
    if (assignee) {
      await notifyUsers([assignee], "projects", {
        title: `New task on “${project.title}”`,
        body: `${user.name} gave you: ${task.title}`,
        url: path(projectId),
      });
    }
  }
  revalidatePath(path(projectId));
  return { message: "Added." };
}

export async function updateTask(projectId: string, taskId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  if (!canEdit(project, user)) return { error: "You can look at this project, but not change it." };
  const task = await prisma.projectTask.findUnique({ where: { id: taskId } });
  if (!task || task.projectId !== projectId) return { error: "That task has gone." };
  const title = field(formData, "title");
  if (!title) return { error: "A task needs a name." };
  const status = TASK_STATUSES[field(formData, "status")] ? field(formData, "status") : task.status;
  const assigneeId = await checkAssignee(projectId, project.ownerId, field(formData, "assigneeId"));
  await prisma.projectTask.update({
    where: { id: taskId },
    data: {
      title: title.slice(0, 200),
      notes: field(formData, "notes").slice(0, 5000),
      kind: field(formData, "kind") === "MILESTONE" ? "MILESTONE" : "TASK",
      section: field(formData, "section").slice(0, 60),
      status,
      startDate: parseDate(field(formData, "startDate")),
      dueDate: parseDate(field(formData, "dueDate")),
      assigneeId,
      completedAt: status === "DONE" ? task.completedAt ?? new Date() : null,
    },
  });
  if (assigneeId && assigneeId !== task.assigneeId && assigneeId !== user.id) {
    const assignee = await prisma.user.findUnique({ where: { id: assigneeId } });
    if (assignee) {
      await notifyUsers([assignee], "projects", {
        title: `New task on “${project.title}”`,
        body: `${user.name} gave you: ${title}`,
        url: path(projectId),
      });
    }
  }
  await prisma.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  revalidatePath(path(projectId));
  return { message: "Saved." };
}

/** Moves a task to another column (or ticks it off). */
export async function moveTask(projectId: string, taskId: string, status: string) {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  if (!canEdit(project, user) || !TASK_STATUSES[status]) return;
  const task = await prisma.projectTask.findUnique({ where: { id: taskId } });
  if (!task || task.projectId !== projectId || task.status === status) return;
  const last = await prisma.projectTask.findFirst({ where: { projectId, status }, orderBy: { sortOrder: "desc" } });
  await prisma.projectTask.update({
    where: { id: taskId },
    data: { status, sortOrder: (last?.sortOrder ?? 0) + 1, completedAt: status === "DONE" ? new Date() : null },
  });
  if (status === "DONE") await logUpdate(projectId, user.id, `${user.name} finished “${task.title}”.`);
  else await prisma.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  revalidatePath(path(projectId));
}

export async function deleteTask(projectId: string, taskId: string) {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  if (!canEdit(project, user)) return;
  await prisma.projectTask.deleteMany({ where: { id: taskId, projectId } });
  revalidatePath(path(projectId));
}

/* ---------- Updates ---------- */

export async function postUpdate(projectId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const project = await loadProject(projectId, user);
  if (!canEdit(project, user)) return { error: "You can look at this project, but not post to it." };
  const body = field(formData, "body");
  if (!body) return { error: "Write something first." };
  await prisma.projectUpdate.create({ data: { projectId, authorId: user.id, body: body.slice(0, 5000) } });
  await prisma.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  revalidatePath(path(projectId));
  return { message: "Posted." };
}

/* ---------- Tickets ---------- */

/** Links a help desk ticket to a project (agents, from the ticket page). */
export async function linkTicketToProject(ticketId: number, formData: FormData) {
  const user = await requireUser();
  if (user.role !== "ADMIN" && user.role !== "TECH") return;
  const projectId = field(formData, "projectId");
  if (projectId) {
    const project = await loadProject(projectId, user);
    if (!canEdit(project, user)) return;
  }
  await prisma.ticket.update({ where: { id: ticketId }, data: { projectId: projectId || null } });
  revalidatePath(`/dashboard/tickets/${ticketId}`);
  if (projectId) revalidatePath(path(projectId));
}
