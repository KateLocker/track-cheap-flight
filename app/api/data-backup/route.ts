import { NextResponse } from "next/server";
import { exportStoreJSON, importStoreJSON } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const json = exportStoreJSON();
    const res = new NextResponse(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="flights-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const text = await req.text();
    const ok = importStoreJSON(text);
    return NextResponse.json({ success: ok });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
