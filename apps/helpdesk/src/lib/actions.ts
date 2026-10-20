"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { isAgent, requireAdmin, requireAgent, requireUser } from "./auth";
import { saveAttachments } from "./files";
import { createTicketFor } from "./tickets";
import { canUseForm, FIELD_TYPE_VALUES, parseFields, type FormFieldDef } from "./forms";
import { slugify } from "./kb";
import { ASK_VALUES, COLORS, SHAPES, categoriesFor, categoryByKey, readAnswers } from "./categories";
import { STATUSES, PRIORITIES } from "./labels";
import {
  isEmailEnabled,
  notifyNewTicket,
  notifyRequesterComment,
  notifyTeamOfReply,
  sendMail,
} from "./mail";
import { APP_TITLE } from "./config";
import { notifyUsers } from "./notify";
import { eventsForRole, type NotifyPrefs } from "./notify-prefs";

export type FormState = { error?: string; message?: string };

const PRIORITY_VALUES = ["LOW", "NORMAL", "HIGH", "URGENT"];
const STATUS_VALUES = ["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"];

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function activeAgents() {
  return prisma.user.findMany({
    where: { active: true, role: { in: ["ADMIN", "TECH"] } },
  });
}

/* ---------- Public: submit & view requests ---------- */

export async function submitTicket(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const category = field(formData, "category");
  const title = field(formData, "title");
  const description = field(formData, "description");
  const location = field(formData, "location");
  const device = field(formData, "device");
  const priority = field(formData, "priority") || "NORMAL";

  const kind = (await categoriesFor(user)).find((c) => c.key === category);
  if (!kind) return { error: "Please pick a category for your request." };
  if (!title) return { error: "Please add a short summary of what you need." };
  if (!PRIORITY_VALUES.includes(priority)) return { error: "Invalid priority." };
  if (kind.askLocation === "REQUIRED" && !location) return { error: "Please say where this is." };
  if (kind.askDevice === "REQUIRED" && !device) return { error: "Please say which device this is about." };
  // Only the questions of the category picked count; the others were hidden.
  const answers = readAnswers(kind.fields, (name) => formData.get(name));
  if ("error" in answers) return answers;

  const deviceTag = field(formData, "deviceTag").toUpperCase();
  const linkedDevice = deviceTag
    ? await prisma.device.findUnique({ where: { tag: deviceTag } })
    : null;

  const ticket = await createTicketFor(user, {
    title,
    description,
    category,
    priority,
    location: kind.askLocation === "HIDDEN" ? "" : location,
    device: kind.askDevice === "HIDDEN" ? "" : device,
    deviceId: linkedDevice?.id ?? null,
    answers: answers.values,
  });

  const files = formData
    .getAll("photos")
    .filter((f): f is File => f instanceof File && f.size > 0);
  try {
    await saveAttachments(ticket.id, files);
  } catch (error) {
    console.error("Saving attachments failed:", error);
  }

  redirect(`/t/${ticket.token}?new=1`);
}

export async function addRequesterReply(
  token: string,
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const body = field(formData, "body");
  if (!body) return { error: "Write a message first." };

  const ticket = await prisma.ticket.findUnique({ where: { token } });
  if (!ticket) return { error: "Request not found." };

  await prisma.comment.create({
    data: { ticketId: ticket.id, authorName: ticket.requesterName, body, internal: false },
  });

  const reopened = ["RESOLVED", "CLOSED"].includes(ticket.status);
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: reopened ? { status: "OPEN", resolvedAt: null } : { updatedAt: new Date() },
  });

  await notifyTeamOfReply(ticket, body);
  const targets = ticket.assignedToId
    ? await prisma.user.findMany({ where: { id: ticket.assignedToId, active: true } })
    : await activeAgents();
  await notifyUsers(targets, "reply", {
    title: `Reply on #${ticket.id}`,
    body: `${ticket.requesterName}: ${body}`,
    url: `/dashboard/tickets/${ticket.id}`,
  });
  revalidatePath(`/t/${token}`);
  return { message: reopened ? "Reply sent — we've reopened your request." : "Reply sent." };
}

export async function submitCustomTicket(
  formId: string,
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const user = await requireUser();
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form || !canUseForm(user, form)) {
    return { error: "This form isn't available anymore." };
  }

  const answers = readAnswers(parseFields(form.fieldsJson), (name) => formData.get(name));
  if ("error" in answers) return answers;
  const values = answers.values;

  const ticket = await prisma.ticket.create({
    data: {
      title: form.name,
      description: "",
      category: form.category,
      priority: "NORMAL",
      formId: form.id,
      formName: form.name,
      formData: JSON.stringify(values),
      requesterId: user.id,
      requesterName: user.name,
      requesterEmail: user.email,
      requesterRole: user.role === "STUDENT" ? "STUDENT" : "STAFF",
    },
  });

  const files = formData
    .getAll("photos")
    .filter((f): f is File => f instanceof File && f.size > 0);
  try {
    await saveAttachments(ticket.id, files);
  } catch (error) {
    console.error("Saving attachments failed:", error);
  }

  await notifyNewTicket(ticket);
  await notifyUsers(await activeAgents(), "new_ticket", {
    title: `New request #${ticket.id}`,
    body: `${user.name}: ${ticket.title}`,
    url: `/dashboard/tickets/${ticket.id}`,
  });
  redirect(`/t/${ticket.token}?new=1`);
}

/** Checks question definitions sent by the form builder (forms and categories share it). */
function cleanFields(rawFields: unknown[]): { error: string } | { fields: FormFieldDef[] } {
  const fields: FormFieldDef[] = [];
  for (const raw of rawFields as Record<string, unknown>[]) {
    const label = String(raw.label ?? "").trim();
    if (!label) return { error: "Every field needs a label." };
    const type = FIELD_TYPE_VALUES.includes(String(raw.type))
      ? (String(raw.type) as FormFieldDef["type"])
      : "TEXT";
    const options =
      type === "SELECT" && Array.isArray(raw.options)
        ? raw.options.map((o) => String(o).trim()).filter(Boolean)
        : [];
    if (type === "SELECT" && options.length === 0) {
      return { error: `The dropdown "${label}" needs at least one option.` };
    }
    fields.push({
      id: String(raw.id ?? "") || crypto.randomUUID(),
      label,
      type,
      required: Boolean(raw.required),
      options,
    });
  }
  return { fields };
}

/* ---------- Admin: manage forms ---------- */

export async function saveForm(
  formId: string | null,
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  await requireAdmin();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(field(formData, "payload"));
  } catch {
    return { error: "Something went wrong reading the form — try again." };
  }

  const name = String(payload.name ?? "").trim();
  const description = String(payload.description ?? "").trim();
  const category = String(payload.category ?? "");
  const active = Boolean(payload.active);
  const roles = Array.isArray(payload.roles)
    ? payload.roles.map(String).filter((r) => ["ADMIN", "TECH", "STAFF", "STUDENT"].includes(r))
    : [];

  if (!name) return { error: "Give the form a name." };
  if (!(await categoryByKey(category))) return { error: "Pick a category." };
  if (roles.length === 0) return { error: "Choose at least one role that can use this form." };

  const rawFields = Array.isArray(payload.fields) ? payload.fields : [];
  if (rawFields.length === 0) return { error: "Add at least one field." };
  if (rawFields.length > 30) return { error: "Forms are limited to 30 fields." };

  const parsed = cleanFields(rawFields);
  if ("error" in parsed) return parsed;
  const fields = parsed.fields;

  const data = {
    name,
    description,
    category,
    active,
    roles: JSON.stringify(roles),
    fieldsJson: JSON.stringify(fields),
  };

  if (formId) {
    await prisma.form.update({ where: { id: formId }, data });
  } else {
    await prisma.form.create({ data });
  }

  revalidatePath("/dashboard/forms");
  revalidatePath("/");
  redirect("/dashboard/forms?msg=" + encodeURIComponent(`Saved "${name}".`));
}

export async function setFormActive(formId: string, active: boolean) {
  await requireAdmin();
  await prisma.form.update({ where: { id: formId }, data: { active } });
  revalidatePath("/dashboard/forms");
  revalidatePath("/");
}

export async function deleteForm(formId: string) {
  await requireAdmin();
  await prisma.form.delete({ where: { id: formId } });
  revalidatePath("/dashboard/forms");
  revalidatePath("/");
  redirect("/dashboard/forms?msg=Form+deleted.+Existing+tickets+keep+their+answers.");
}

/* ---------- Devices ---------- */

const DEVICE_TYPE_VALUES = ["CHROMEBOOK", "IPAD", "LAPTOP", "DESKTOP", "PROJECTOR", "PRINTER", "OTHER"];
const DEVICE_STATUS_VALUES = ["ACTIVE", "REPAIR", "RETIRED"];

export async function saveDevice(
  deviceId: string | null,
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  await requireAgent();
  const tag = field(formData, "tag").toUpperCase();
  const type = field(formData, "type");
  const model = field(formData, "model");
  const location = field(formData, "location");
  const assignedTo = field(formData, "assignedTo");
  const status = field(formData, "status") || "ACTIVE";
  const notes = field(formData, "notes");

  if (!tag) return { error: "Every device needs an asset tag (e.g. C-104)." };
  if (!DEVICE_TYPE_VALUES.includes(type)) return { error: "Pick a device type." };
  if (!DEVICE_STATUS_VALUES.includes(status)) return { error: "Invalid status." };

  const existing = await prisma.device.findUnique({ where: { tag } });
  if (existing && existing.id !== deviceId) {
    return { error: `A device with tag ${tag} already exists.` };
  }

  const data = { tag, type, model, location, assignedTo, status, notes };
  if (deviceId) {
    await prisma.device.update({ where: { id: deviceId }, data });
  } else {
    await prisma.device.create({ data });
  }
  revalidatePath("/dashboard/devices");
  return { message: `Saved ${tag}.` };
}

export async function deleteDevice(deviceId: string) {
  await requireAgent();
  await prisma.device.delete({ where: { id: deviceId } });
  revalidatePath("/dashboard/devices");
  redirect("/dashboard/devices?msg=Device+deleted.+Tickets+keep+their+history.");
}

export async function linkTicketDevice(ticketId: number, formData: FormData) {
  await requireAgent();
  const tag = field(formData, "tag").toUpperCase();
  if (!tag) {
    await prisma.ticket.update({ where: { id: ticketId }, data: { deviceId: null } });
  } else {
    const device = await prisma.device.findUnique({ where: { tag } });
    if (!device) {
      redirect(`/dashboard/tickets/${ticketId}?err=${encodeURIComponent(`No device with tag ${tag}.`)}`);
    }
    await prisma.ticket.update({ where: { id: ticketId }, data: { deviceId: device.id } });
  }
  revalidatePath(`/dashboard/tickets/${ticketId}`);
}

export async function markDuplicate(ticketId: number, formData: FormData) {
  const user = await requireAgent();
  const parentId = Number(field(formData, "parent").replace(/\D/g, ""));
  if (!parentId || parentId === ticketId) {
    redirect(`/dashboard/tickets/${ticketId}?err=${encodeURIComponent("Enter a different ticket number.")}`);
  }
  const parent = await prisma.ticket.findUnique({ where: { id: parentId } });
  if (!parent) {
    redirect(`/dashboard/tickets/${ticketId}?err=${encodeURIComponent(`No ticket #${parentId}.`)}`);
  }
  if (parent.duplicateOfId) {
    redirect(
      `/dashboard/tickets/${ticketId}?err=${encodeURIComponent(
        `#${parentId} is itself a duplicate — use #${parent.duplicateOfId} instead.`
      )}`
    );
  }
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return;

  await prisma.ticket.update({
    where: { id: ticketId },
    data: { duplicateOfId: parent.id, status: "CLOSED" },
  });
  await prisma.comment.create({
    data: {
      ticketId,
      authorId: user.id,
      authorName: user.name,
      body: `marked this as a duplicate of #${parent.id}`,
      internal: true,
    },
  });
  const publicNote = `This is the same issue as ticket #${parent.id} — we're tracking it there, and updates will be posted here too.`;
  await prisma.comment.create({
    data: { ticketId, authorId: user.id, authorName: user.name, body: publicNote, internal: false },
  });
  if (ticket.requesterId) {
    const requester = await prisma.user.findUnique({ where: { id: ticket.requesterId } });
    if (requester && requester.active) {
      await notifyUsers([requester], "my_updates", {
        title: `Update on your request #${ticket.id}`,
        body: publicNote,
        url: `/t/${ticket.token}`,
      });
    }
  }
  revalidatePath(`/dashboard/tickets/${ticketId}`);
  revalidatePath(`/dashboard/tickets/${parent.id}`);
  revalidatePath("/dashboard");
}

/* ---------- Recurring tickets ---------- */

export async function saveRecurringTask(formData: FormData) {
  const user = await requireAgent();
  const title = field(formData, "title");
  const description = field(formData, "description");
  const category = field(formData, "category");
  const everyDays = Number(field(formData, "everyDays"));
  const firstRun = field(formData, "firstRun");
  const assignedToId = field(formData, "assignedToId") || null;

  if (!title) redirect("/dashboard/recurring?err=Give+the+task+a+title.");
  if (!(await categoryByKey(category))) redirect("/dashboard/recurring?err=Pick+a+category.");
  if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > 365) {
    redirect("/dashboard/recurring?err=Repeat+must+be+between+1+and+365+days.");
  }
  const nextRunAt = firstRun ? new Date(`${firstRun}T12:00:00Z`) : new Date();
  if (Number.isNaN(nextRunAt.getTime())) redirect("/dashboard/recurring?err=Invalid+start+date.");

  await prisma.recurringTask.create({
    data: { title, description, category, everyDays, nextRunAt, assignedToId, createdById: user.id },
  });
  revalidatePath("/dashboard/recurring");
  redirect("/dashboard/recurring?msg=" + encodeURIComponent(`Scheduled "${title}".`));
}

export async function setRecurringActive(taskId: string, active: boolean) {
  await requireAgent();
  await prisma.recurringTask.update({ where: { id: taskId }, data: { active } });
  revalidatePath("/dashboard/recurring");
}

export async function deleteRecurringTask(taskId: string) {
  await requireAgent();
  await prisma.recurringTask.delete({ where: { id: taskId } });
  revalidatePath("/dashboard/recurring");
  redirect("/dashboard/recurring?msg=Deleted.");
}

/* ---------- Saved replies ---------- */

export async function saveSnippet(snippetId: string | null, formData: FormData) {
  await requireAgent();
  const title = field(formData, "title");
  const body = field(formData, "body");
  if (!title || !body) redirect("/dashboard/snippets?err=Both+a+name+and+the+reply+text+are+required.");
  if (snippetId) {
    await prisma.snippet.update({ where: { id: snippetId }, data: { title, body } });
  } else {
    await prisma.snippet.create({ data: { title, body } });
  }
  revalidatePath("/dashboard/snippets");
  redirect("/dashboard/snippets?msg=" + encodeURIComponent(`Saved "${title}".`));
}

export async function deleteSnippet(snippetId: string) {
  await requireAgent();
  await prisma.snippet.delete({ where: { id: snippetId } });
  revalidatePath("/dashboard/snippets");
  redirect("/dashboard/snippets?msg=Deleted.");
}

/* ---------- Knowledge base ---------- */

export async function saveArticle(
  articleId: string | null,
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const user = await requireAgent();

  const title = field(formData, "title");
  const body = field(formData, "body");
  const category = field(formData, "category");
  const published = formData.get("published") === "on";
  const roles = formData
    .getAll("roles")
    .map(String)
    .filter((r) => ["ADMIN", "TECH", "STAFF", "STUDENT"].includes(r));

  if (!title) return { error: "Give the article a title." };
  if (!body) return { error: "Write something in the article body." };
  if (!(await categoryByKey(category))) return { error: "Pick a category." };
  if (roles.length === 0) return { error: "Choose at least one role that can read this." };

  const data = {
    title,
    body,
    category,
    published,
    roles: JSON.stringify(roles),
  };

  if (articleId) {
    await prisma.article.update({ where: { id: articleId }, data });
  } else {
    let slug = slugify(title);
    for (let i = 2; await prisma.article.findUnique({ where: { slug } }); i++) {
      slug = `${slugify(title)}-${i}`;
    }
    await prisma.article.create({ data: { ...data, slug, authorId: user.id } });
  }

  revalidatePath("/kb");
  revalidatePath("/dashboard/kb");
  redirect("/dashboard/kb?msg=" + encodeURIComponent(`Saved "${title}".`));
}

export async function deleteArticle(articleId: string) {
  await requireAgent();
  await prisma.article.delete({ where: { id: articleId } });
  revalidatePath("/kb");
  revalidatePath("/dashboard/kb");
  redirect("/dashboard/kb?msg=Article+deleted.");
}

/* ---------- Auth ---------- */

export async function logout() {
  // Signify ID ends the session centrally, so every app signs out together.
  redirect("/auth/logout");
}

export async function setLang(lang: string) {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  cookieStore.set("lang", lang === "es" ? "es" : "en", {
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
}

/* ---------- Staff: manage tickets ---------- */

export async function updateTicket(ticketId: number, formData: FormData) {
  const user = await requireAgent();
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return;

  const data: Record<string, unknown> = {};
  const notes: string[] = [];

  const status = field(formData, "status");
  if (status && STATUS_VALUES.includes(status) && status !== ticket.status) {
    data.status = status;
    if (status === "RESOLVED") data.resolvedAt = new Date();
    if (["OPEN", "IN_PROGRESS", "WAITING"].includes(status)) data.resolvedAt = null;
    notes.push(`marked this ${STATUSES[status].label}`);
  }

  const priority = field(formData, "priority");
  if (priority && PRIORITY_VALUES.includes(priority) && priority !== ticket.priority) {
    data.priority = priority;
    notes.push(`set priority to ${PRIORITIES[priority].label}`);
  }

  if (formData.has("assignedToId")) {
    const newId = field(formData, "assignedToId") || null;
    if (newId !== ticket.assignedToId) {
      data.assignedToId = newId;
      if (newId) {
        const assignee = await prisma.user.findUnique({ where: { id: newId } });
        if (assignee) {
          notes.push(`assigned this to ${assignee.name}`);
          if (assignee.id !== user.id) {
            await notifyUsers([assignee], "assigned", {
              title: `Assigned to you: #${ticket.id}`,
              body: ticket.title,
              url: `/dashboard/tickets/${ticket.id}`,
            });
          }
        }
      } else {
        notes.push("unassigned this");
      }
    }
  }

  if (Object.keys(data).length > 0) {
    await prisma.ticket.update({ where: { id: ticketId }, data });
    await prisma.comment.create({
      data: {
        ticketId,
        authorId: user.id,
        authorName: user.name,
        body: notes.join(" · "),
        internal: true,
      },
    });

    if (data.status === "RESOLVED" && ticket.requesterId) {
      const requester = await prisma.user.findUnique({ where: { id: ticket.requesterId } });
      if (requester && requester.active) {
        await notifyUsers([requester], "my_updates", {
          title: `Your request #${ticket.id} was resolved`,
          body: ticket.title,
          url: `/t/${ticket.token}`,
        });
      }
    }
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/tickets/${ticketId}`);
}

export async function addStaffComment(ticketId: number, formData: FormData) {
  const user = await requireAgent();
  const body = field(formData, "body");
  if (!body) return;
  const internal = formData.get("internal") === "on";

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return;

  await prisma.comment.create({
    data: { ticketId, authorId: user.id, authorName: user.name, body, internal },
  });
  await prisma.ticket.update({ where: { id: ticketId }, data: { updatedAt: new Date() } });

  // Public updates fan out to any tickets marked as duplicates of this one
  if (!internal) {
    const duplicates = await prisma.ticket.findMany({ where: { duplicateOfId: ticketId } });
    for (const dup of duplicates) {
      await prisma.comment.create({
        data: { ticketId: dup.id, authorId: user.id, authorName: user.name, body, internal: false },
      });
      if (dup.requesterId) {
        const dupRequester = await prisma.user.findUnique({ where: { id: dup.requesterId } });
        if (dupRequester && dupRequester.active) {
          await notifyUsers([dupRequester], "my_updates", {
            title: `Update on your request #${dup.id}`,
            body,
            url: `/t/${dup.token}`,
          });
        }
      }
      revalidatePath(`/t/${dup.token}`);
      revalidatePath(`/dashboard/tickets/${dup.id}`);
    }
  }

  if (!internal) {
    if (ticket.requesterId) {
      const requester = await prisma.user.findUnique({ where: { id: ticket.requesterId } });
      if (requester && requester.active) {
        await notifyUsers([requester], "my_updates", {
          title: `Update on your request #${ticket.id}`,
          body,
          url: `/t/${ticket.token}`,
        });
      }
    } else {
      // Legacy tickets submitted before accounts existed
      await notifyRequesterComment(ticket, body);
    }
  }

  revalidatePath(`/dashboard/tickets/${ticketId}`);
  revalidatePath(`/t/${ticket.token}`);
}


/* ---------- Notification settings ---------- */

export async function saveNotificationPrefs(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const user = await requireUser();

  const prefs: NotifyPrefs = {};
  for (const event of eventsForRole(user.role)) {
    prefs[event.key] = {
      email: formData.get(`pref_${event.key}_email`) === "on",
      push: formData.get(`pref_${event.key}_push`) === "on",
      sms: formData.get(`pref_${event.key}_sms`) === "on",
    };
  }

  const rawPhone = field(formData, "phone");
  let phone: string | null = null;
  if (rawPhone) {
    const cleaned = rawPhone.replace(/[^\d+]/g, "");
    const normalized = cleaned.startsWith("+")
      ? cleaned
      : cleaned.length === 10
        ? `+1${cleaned}`
        : `+${cleaned}`;
    if (normalized.replace(/\D/g, "").length < 10) {
      return { error: "That phone number doesn't look right — e.g. 555-123-4567." };
    }
    phone = normalized;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { notifyPrefs: JSON.stringify(prefs), phone },
  });
  return { message: "Notification settings saved." };
}

export async function sendTestEmail(_prev: FormState, _formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  if (!(await isEmailEnabled())) {
    return { error: "Email isn't set up on this server yet." };
  }
  const result = await sendMail(
    admin.email,
    `${APP_TITLE} test email`,
    "If you're reading this, email notifications are working!"
  );
  if (!result.ok) {
    return { error: `Sending failed: ${result.error}` };
  }
  return { message: `Test email sent to ${admin.email} — check your inbox (and spam folder).` };
}

export async function savePushSubscription(subscriptionJson: string) {
  const user = await requireUser();
  let sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    sub = JSON.parse(subscriptionJson);
  } catch {
    return;
  }
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return;
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    update: { userId: user.id, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    create: {
      userId: user.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
    },
  });
}

export async function removePushSubscription(endpoint: string) {
  const user = await requireUser();
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: user.id } });
}

/* ---------- Admin: request categories and locations ---------- */

/** A key for a new category: its name in capitals, kept unique. Never changes after. */
async function newCategoryKey(name: string) {
  const base =
    name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) ||
    "CATEGORY";
  for (let i = 0; ; i++) {
    const key = i === 0 ? base : `${base}_${i + 1}`;
    if (!(await prisma.category.findUnique({ where: { key } }))) return key;
  }
}

export async function saveCategory(
  categoryId: string | null,
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  await requireAdmin();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(field(formData, "payload"));
  } catch {
    return { error: "Something went wrong reading the form — try again." };
  }
  const text = (k: string, max: number) => String(payload[k] ?? "").trim().slice(0, max);
  const pick = <T extends string>(k: string, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(String(payload[k])) ? (String(payload[k]) as T) : fallback;

  const name = text("name", 60);
  if (!name) return { error: "Give the category a name." };
  const roles = Array.isArray(payload.roles)
    ? payload.roles.map(String).filter((r) => ["ADMIN", "TECH", "STAFF", "STUDENT"].includes(r))
    : [];
  if (roles.length === 0) return { error: "Choose at least one role that can pick this category." };

  const rawFields = Array.isArray(payload.fields) ? payload.fields : [];
  if (rawFields.length > 20) return { error: "A category can ask up to 20 extra questions." };
  const parsed = cleanFields(rawFields);
  if ("error" in parsed) return parsed;

  const data = {
    name,
    nameEs: text("nameEs", 60),
    hint: text("hint", 200),
    hintEs: text("hintEs", 200),
    shape: pick("shape", SHAPES, "arch"),
    color: pick("color", COLORS, "p4"),
    titlePrompt: text("titlePrompt", 120),
    askLocation: pick("askLocation", ASK_VALUES, "OPTIONAL"),
    askDevice: pick("askDevice", ASK_VALUES, "HIDDEN"),
    fieldsJson: JSON.stringify(parsed.fields),
    roles: JSON.stringify(roles),
    active: Boolean(payload.active),
  };

  if (categoryId) {
    await prisma.category.update({ where: { id: categoryId }, data });
  } else {
    const last = await prisma.category.findFirst({ orderBy: { sortOrder: "desc" } });
    await prisma.category.create({
      data: { ...data, key: await newCategoryKey(name), sortOrder: (last?.sortOrder ?? 0) + 1 },
    });
  }

  revalidatePath("/", "layout");
  redirect("/dashboard/categories?msg=" + encodeURIComponent(`Saved "${name}".`));
}

export async function moveCategory(categoryId: string, delta: number) {
  await requireAdmin();
  const all = await prisma.category.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  const index = all.findIndex((c) => c.id === categoryId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= all.length) return;
  [all[index], all[target]] = [all[target], all[index]];
  await prisma.$transaction(
    all.map((c, i) => prisma.category.update({ where: { id: c.id }, data: { sortOrder: i } }))
  );
  revalidatePath("/", "layout");
}

export async function setCategoryActive(categoryId: string, active: boolean) {
  await requireAdmin();
  if (!active) {
    const others = await prisma.category.count({ where: { active: true, id: { not: categoryId } } });
    if (others === 0) redirect("/dashboard/categories?err=" + encodeURIComponent("Keep at least one category showing."));
  }
  await prisma.category.update({ where: { id: categoryId }, data: { active } });
  revalidatePath("/", "layout");
}

/** Only a category nothing points at can go; anything in use is hidden instead. */
export async function deleteCategory(categoryId: string) {
  await requireAdmin();
  const category = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!category) redirect("/dashboard/categories");
  const where = { category: category.key };
  const [tickets, forms, articles, recurring, total] = await Promise.all([
    prisma.ticket.count({ where }),
    prisma.form.count({ where }),
    prisma.article.count({ where }),
    prisma.recurringTask.count({ where }),
    prisma.category.count(),
  ]);
  if (total <= 1) redirect("/dashboard/categories?err=" + encodeURIComponent("Keep at least one category."));
  if (tickets + forms + articles + recurring > 0) {
    redirect(
      "/dashboard/categories?err=" +
        encodeURIComponent(`"${category.name}" is in use (tickets, forms, articles or recurring tasks), so hide it instead.`)
    );
  }
  await prisma.category.delete({ where: { id: categoryId } });
  revalidatePath("/", "layout");
  redirect("/dashboard/categories?msg=" + encodeURIComponent(`Deleted "${category.name}".`));
}

/** Adds places to the Location dropdown; one per line, so a whole list can be pasted. */
export async function addLocations(formData: FormData) {
  await requireAdmin();
  const names = field(formData, "names")
    .split("\n")
    .map((n) => n.trim().slice(0, 80))
    .filter(Boolean);
  if (names.length === 0) redirect("/dashboard/categories?err=" + encodeURIComponent("Type at least one place.") + "#locations");
  const existing = await prisma.location.findMany();
  const known = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
  let next = existing.reduce((max, l) => Math.max(max, l.sortOrder), 0) + 1;
  let added = 0;
  const seen = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const same = known.get(lower);
    if (same) {
      if (!same.active) await prisma.location.update({ where: { id: same.id }, data: { active: true } });
      continue;
    }
    await prisma.location.create({ data: { name, sortOrder: next++ } });
    added++;
  }
  revalidatePath("/", "layout");
  redirect(
    "/dashboard/categories?msg=" +
      encodeURIComponent(added === 1 ? "Added 1 place." : `Added ${added} places.`) +
      "#locations"
  );
}

export async function renameLocation(locationId: string, formData: FormData) {
  await requireAdmin();
  const name = field(formData, "name").slice(0, 80);
  if (!name) return;
  const clash = await prisma.location.findFirst({ where: { name, id: { not: locationId } } });
  if (clash) redirect("/dashboard/categories?err=" + encodeURIComponent(`"${name}" is already on the list.`) + "#locations");
  await prisma.location.update({ where: { id: locationId }, data: { name } });
  revalidatePath("/", "layout");
}

export async function moveLocation(locationId: string, delta: number) {
  await requireAdmin();
  const all = await prisma.location.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const index = all.findIndex((l) => l.id === locationId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= all.length) return;
  [all[index], all[target]] = [all[target], all[index]];
  await prisma.$transaction(
    all.map((l, i) => prisma.location.update({ where: { id: l.id }, data: { sortOrder: i } }))
  );
  revalidatePath("/", "layout");
}

/** Old tickets keep the place as text, so removing it from the list loses nothing. */
export async function removeLocation(locationId: string) {
  await requireAdmin();
  await prisma.location.delete({ where: { id: locationId } });
  revalidatePath("/", "layout");
}

export async function sortLocationsByName() {
  await requireAdmin();
  const all = await prisma.location.findMany({ where: { active: true } });
  all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  await prisma.$transaction(
    all.map((l, i) => prisma.location.update({ where: { id: l.id }, data: { sortOrder: i } }))
  );
  revalidatePath("/", "layout");
}
