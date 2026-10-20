import { PRIORITIES, STATUSES } from "@/lib/labels";
import { categoryByKey, categoryName } from "@/lib/categories";
import { getLang } from "@/lib/lang";

const base = "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium";

export function StatusBadge({ status }: { status: string }) {
  const s = STATUSES[status] ?? { label: status, badge: "bg-slate-100 text-slate-600" };
  return <span className={`${base} ${s.badge}`}>{s.label}</span>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const p = PRIORITIES[priority] ?? { label: priority, badge: "bg-slate-100 text-slate-600" };
  return <span className={`${base} ${p.badge}`}>{p.label}</span>;
}

export async function CategoryLabel({ category, className = "" }: { category: string; className?: string }) {
  const [c, lang] = await Promise.all([categoryByKey(category), getLang()]);
  const shape = c?.shape ?? "arch";
  const color = c?.color ?? "p4";
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap ${className}`}>
      <span aria-hidden className={`shape shape-${shape} text-${color}`} />
      {c ? categoryName(c, lang) : category}
    </span>
  );
}
