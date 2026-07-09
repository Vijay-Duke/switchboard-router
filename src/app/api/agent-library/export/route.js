// @ts-check
import { NextResponse } from "next/server";
import { jsonError, safeErrorMessage } from "@/lib/jsonError";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  loadSettings,
  resolveLibraryRoot,
  exportAgentSyncLayout,
  isPathInside,
} from "@/lib/agent-library/index.js";

/**
 * POST { destPath?: string } — export AgentSync-compatible .agents layout
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const settings = await loadSettings();
    const libraryRoot = resolveLibraryRoot(settings);

    let dest = body.destPath;
    if (!dest) {
      if (settings.scope === "project" && settings.projectPath) {
        dest = path.join(path.resolve(settings.projectPath), ".agents");
      } else {
        dest = path.join(os.homedir(), "switchboard-agents-export", ".agents");
      }
    }
    dest = path.resolve(dest);

    const home = path.resolve(os.homedir());
    const projectRoot =
      settings.scope === "project" && settings.projectPath
        ? path.resolve(settings.projectPath)
        : null;

    // Containment: use path.relative, not startsWith prefix tricks
    const underHome = isPathInside(dest, home);
    const underProject = projectRoot ? isPathInside(dest, projectRoot) : false;
    if (!underHome && !underProject) {
      return NextResponse.json(
        {
          error: "dest_not_allowed",
          message: "Export path must be under your home directory or project path",
        },
        { status: 400 }
      );
    }

    // Reject if any parent is a symlink outside allowed roots (best-effort)
    try {
      let cur = dest;
      // Walk parents; if a parent exists and is symlink, resolve and re-check
      while (cur !== path.dirname(cur)) {
        if (fs.existsSync(cur)) {
          const real = fs.realpathSync(cur);
          const realOk =
            isPathInside(real, home) ||
            (projectRoot && isPathInside(real, projectRoot));
          if (!realOk) {
            return NextResponse.json(
              {
                error: "dest_symlink_escape",
                message: "Export path resolves outside allowed directories",
              },
              { status: 400 }
            );
          }
          break;
        }
        cur = path.dirname(cur);
      }
    } catch {
      /* continue */
    }

    const res = await exportAgentSyncLayout(libraryRoot, dest);
    return NextResponse.json(res);
  } catch (e) {
    return jsonError(500, safeErrorMessage(e));
  }
}
