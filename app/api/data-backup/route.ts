import { NextResponse } from "next/server";
import { exportStoreJSON, importStoreJSON } from "@/lib/db";
import { requireAdmin, limitAdminAction } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;
  try {
    return new NextResponse(await exportStoreJSON(), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="flights-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Backup export failed." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;
  const limited = limitAdminAction("backup-import", 2);
  if (limited) return limited;
  try {
    const length = Number(request.headers.get("content-length"));
    if (length > 5_000_000) return NextResponse.json({ success: false, error: "Backup exceeds the 5 MB limit." }, { status: 413 });
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > 5_000_000) return NextResponse.json({ success: false, error: "Backup exceeds the 5 MB limit." }, { status: 413 });
    const success = await importStoreJSON(text);
    return NextResponse.json(success ? { success: true } : { success: false, error: "Backup does not match the required data schema." }, { status: success ? 200 : 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Backup import failed." }, { status: 503 });
  }
}
