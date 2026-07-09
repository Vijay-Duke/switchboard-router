// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError.js";
import { sendToChild, findPlugin } from "@/lib/mcp/stdioSseBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  const { plugin } = await params;
  if (!findPlugin(plugin)) {
    return NextResponse.json({ error: `Unknown plugin: ${plugin}` }, { status: 404 });
  }
  try {
    const body = await request.json();
    sendToChild(plugin, body);
    return new Response(null, { status: 202 });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}
