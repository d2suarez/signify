import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { USER_ROLES, timeAgo } from "@/lib/labels";

export const dynamic = "force-dynamic";
export const metadata = { title: "People" };

const IDENTITY_URL = (process.env.SIGNIFY_ISSUER || "https://id.signify.one").replace(/\/+$/, "");

const GROUPS = [
  { title: "Help desk team", roles: ["ADMIN", "TECH"], shape: "square", tone: "text-p2" },
  { title: "Staff", roles: ["STAFF"], shape: "circle", tone: "text-p1" },
  { title: "Students", roles: ["STUDENT"], shape: "arch", tone: "text-p4" },
];

/**
 * Who has used the help desk. Accounts and roles live in Signify ID — this
 * page only shows them. A person's help desk role follows the permissions
 * their Signify ID role holds: helpdesk:admin, helpdesk:agent, or neither.
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";

  const users = await prisma.user.findMany({
    where: {
      active: true,
      ...(q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }] } : {}),
    },
    orderBy: { name: "asc" },
  });

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">People</h1>
        <form method="GET" className="flex gap-2">
          <input type="search" name="q" defaultValue={q} placeholder="Search name or email" className="input w-56" />
          <button type="submit" className="btn-secondary">Search</button>
        </form>
      </div>

      <div className="card p-5 text-sm text-slate-600">
        <p>
          Everyone signs in with Signify ID, and their role there decides what they can do here.
          Give someone the <span className="mono text-[13px]">helpdesk:agent</span> permission to let
          them answer tickets, or <span className="mono text-[13px]">helpdesk:admin</span> to let them
          run forms and settings too.
        </p>
        <a href={`${IDENTITY_URL}/admin`} className="btn-primary mt-4">Manage people in Signify ID</a>
      </div>

      {GROUPS.map((group) => {
        const members = users.filter((user) => group.roles.includes(user.role));
        if (members.length === 0 && q) return null;
        return (
          <section key={group.title}>
            <h2 className="eyebrow mb-2 flex items-center gap-2">
              <span aria-hidden className={`shape shape-${group.shape} ${group.tone}`} />
              {group.title} · {members.length}
            </h2>
            {members.length === 0 ? (
              <p className="card px-4 py-3 text-sm text-slate-400">Nobody here yet.</p>
            ) : (
              <ul className="card divide-y divide-slate-100">
                {members.map((user) => (
                  <li key={user.id} className="flex items-center gap-3 px-4 py-3">
                    {user.picture ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={user.picture} alt="" className="h-8 w-8 flex-none rounded-full" referrerPolicy="no-referrer" />
                    ) : (
                      <span aria-hidden className="grid h-8 w-8 flex-none place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-600">
                        {user.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">
                        {user.name}
                        {user.id === admin.id && <span className="ml-1.5 text-xs font-normal text-slate-400">(you)</span>}
                      </p>
                      <p className="truncate text-sm text-slate-500">{user.email}</p>
                    </div>
                    <div className="text-right text-xs text-slate-500">
                      <p className="font-semibold text-slate-700">{user.roleLabel || USER_ROLES[user.role]}</p>
                      {user.lastSeenAt && <p>seen {timeAgo(user.lastSeenAt)}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
