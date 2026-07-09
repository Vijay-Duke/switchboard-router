// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError";
import {
  loadSettings,
  resolveLibraryRoot,
  listMcpServers,
  upsertMcpServer,
  removeMcpServer,
} from "@/lib/agent-library/index.js";

async function activeRoot() {
  const settings = await loadSettings();
  return resolveLibraryRoot(settings);
}

export async function GET() {
  try {
    const root = await activeRoot();
    const servers = await listMcpServers(root);
    return NextResponse.json({ servers, libraryRoot: root });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!body.id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    // Security: warn if env looks like raw secrets (still allow — user choice)
    const warnings = [];
    if (body.env) {
      for (const [k, v] of Object.entries(body.env)) {
        if (
          typeof v === "string" &&
          v.length > 8 &&
          !v.includes("${") &&
          /secret|token|key|password/i.test(k)
        ) {
          warnings.push(
            `env.${k} does not use \${VAR} form — prefer environment references over embedding secrets`
          );
        }
      }
    }
    if (body.command && /curl.+|bash|rm -rf|powershell/i.test(String(body.command) + (body.args || []).join(" "))) {
      warnings.push(
        "Command looks potentially dangerous — review carefully before Apply sync"
      );
    }

    const root = await activeRoot();
    const entry = await upsertMcpServer(root, body);
    return NextResponse.json({ ok: true, server: entry, warnings });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const root = await activeRoot();
    const res = await removeMcpServer(root, id);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}
