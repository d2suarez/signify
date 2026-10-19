import nodemailer from "nodemailer";
import { APP_TITLE } from "./config";

type TicketInfo = {
  id: number;
  token: string;
  title: string;
  requesterName: string;
  requesterEmail: string;
};

const host = process.env.SMTP_HOST;

const transporter = host
  ? nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null;

const FROM = process.env.MAIL_FROM || `${APP_TITLE} <helpdesk@localhost>`;
const NOTIFY_EMAIL = process.env.HELPDESK_NOTIFY_EMAIL;

export const smtpConfigured = Boolean(host);
export const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

/** True when outgoing mail is set up (SMTP). */
export async function isEmailEnabled(): Promise<boolean> {
  return smtpConfigured;
}

type Attachment = { filename: string; content: Buffer };

/** SMTP, when it is configured. */
async function deliver(
  to: string | undefined,
  subject: string,
  text: string,
  attachment?: Attachment
): Promise<{ ok: boolean; error?: string }> {
  if (!to) return { ok: false, error: "No recipient" };

  if (!transporter) return { ok: false, error: "Email isn't set up" };
  try {
    await transporter.sendMail({
      from: FROM,
      to,
      subject,
      text,
      attachments: attachment ? [attachment] : undefined,
    });
    return { ok: true };
  } catch (error) {
    console.error("Email failed:", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendMail(
  to: string | undefined,
  subject: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  return deliver(to, subject, text);
}

const send = sendMail;

export async function sendMailWithAttachment(
  to: string | undefined,
  subject: string,
  text: string,
  filename: string,
  content: Buffer
): Promise<{ ok: boolean; error?: string }> {
  return deliver(to, subject, text, { filename, content });
}

export async function notifyNewTicket(ticket: TicketInfo) {
  await send(
    NOTIFY_EMAIL,
    `New request #${ticket.id}: ${ticket.title}`,
    `${ticket.requesterName} (${ticket.requesterEmail}) submitted a new request.\n\n` +
      `"${ticket.title}"\n\nManage it here:\n${APP_URL}/dashboard/tickets/${ticket.id}`
  );
}

export async function notifyRequesterComment(ticket: TicketInfo, body: string) {
  await send(
    ticket.requesterEmail,
    `Update on your request #${ticket.id}`,
    `There's an update on your request "${ticket.title}":\n\n${body}\n\n` +
      `View or reply here:\n${APP_URL}/t/${ticket.token}`
  );
}

export async function notifyTeamOfReply(ticket: TicketInfo, body: string) {
  await send(
    NOTIFY_EMAIL,
    `Reply on #${ticket.id}: ${ticket.title}`,
    `${ticket.requesterName} replied to request #${ticket.id}:\n\n${body}\n\n` +
      `${APP_URL}/dashboard/tickets/${ticket.id}`
  );
}
