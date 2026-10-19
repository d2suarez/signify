export const CATEGORIES: Record<string, { label: string; shape: string; tone: string }> = {
  TECHNOLOGY: { label: "Technology", shape: "square", tone: "text-p2" },
  MAINTENANCE: { label: "Maintenance & Facilities", shape: "circle", tone: "text-p1" },
  OTHER: { label: "Other", shape: "arch", tone: "text-p4" },
};

export const STATUSES: Record<string, { label: string; badge: string }> = {
  OPEN: { label: "Open", badge: "bg-blue-100 text-blue-800" },
  IN_PROGRESS: { label: "In progress", badge: "bg-violet-100 text-violet-800" },
  WAITING: { label: "Waiting", badge: "bg-amber-100 text-amber-800" },
  RESOLVED: { label: "Resolved", badge: "bg-green-100 text-green-800" },
  CLOSED: { label: "Closed", badge: "bg-slate-200 text-slate-600" },
};

export const PRIORITIES: Record<string, { label: string; badge: string; rank: number }> = {
  LOW: { label: "Low", badge: "bg-slate-100 text-slate-600", rank: 0 },
  NORMAL: { label: "Normal", badge: "bg-sky-100 text-sky-700", rank: 1 },
  HIGH: { label: "High", badge: "bg-orange-100 text-orange-700", rank: 2 },
  URGENT: { label: "Urgent", badge: "bg-red-100 text-red-700", rank: 3 },
};

export const ROLES: Record<string, string> = {
  STAFF: "Staff",
  STUDENT: "Student",
};

export const USER_ROLES: Record<string, string> = {
  ADMIN: "Admin",
  TECH: "Technician",
  STAFF: "Staff",
  STUDENT: "Student",
};

export const DEVICE_TYPES: Record<string, string> = {
  CHROMEBOOK: "Chromebook",
  IPAD: "iPad",
  LAPTOP: "Laptop",
  DESKTOP: "Desktop",
  PROJECTOR: "Projector",
  PRINTER: "Printer",
  OTHER: "Other",
};

export const DEVICE_STATUSES: Record<string, { label: string; badge: string }> = {
  ACTIVE: { label: "Active", badge: "bg-green-100 text-green-800" },
  REPAIR: { label: "In repair", badge: "bg-amber-100 text-amber-800" },
  RETIRED: { label: "Retired", badge: "bg-slate-200 text-slate-600" },
};

export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
