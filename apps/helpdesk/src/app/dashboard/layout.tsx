import { requireAgent } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requireAgent();

  return (
    <div className="min-h-screen">
      <AppHeader mode="agent" />
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
