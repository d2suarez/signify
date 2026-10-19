import { getCurrentUser } from "@/lib/auth";
import { createBackupGzip } from "@/lib/backup";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") {
    return new Response("Forbidden", { status: 403 });
  }
  const { filename, content } = await createBackupGzip();
  return new Response(new Uint8Array(content), {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
