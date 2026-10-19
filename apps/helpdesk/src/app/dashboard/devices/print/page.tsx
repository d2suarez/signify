import QRCode from "qrcode";
import { prisma } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { APP_URL } from "@/lib/mail";
import { APP_TITLE } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Print QR labels" };

export default async function PrintLabelsPage() {
  await requireAgent();
  const devices = await prisma.device.findMany({
    where: { status: { not: "RETIRED" } },
    orderBy: { tag: "asc" },
  });

  const labels = await Promise.all(
    devices.map(async (device) => ({
      device,
      svg: await QRCode.toString(`${APP_URL}/?device=${encodeURIComponent(device.tag)}`, {
        type: "svg",
        margin: 0,
        width: 96,
      }),
    }))
  );

  return (
    <div>
      <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 print:hidden">
        {labels.length} labels — use your browser&apos;s Print (⌘P), ideally on sticker paper.
        Scanning a label opens the request form with that device prefilled.
      </div>
      {labels.length === 0 ? (
        <p className="text-sm text-slate-500">No active devices to print.</p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {labels.map(({ device, svg }) => (
            <div
              key={device.id}
              className="flex break-inside-avoid flex-col items-center gap-1 rounded border border-slate-300 p-3 text-center"
            >
              <div
                className="w-24 [&_svg]:h-auto [&_svg]:w-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
              <p className="text-sm font-bold">{device.tag}</p>
              <p className="text-[10px] leading-tight text-slate-500">
                Problem? Scan to report it
                <br />
                {APP_TITLE}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
