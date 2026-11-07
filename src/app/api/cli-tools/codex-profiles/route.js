// @ts-check
// Codex CLI profiles: `codex -p <name>` layers $CODEX_HOME/<name>.config.toml on
// top of the base ~/.codex/config.toml, so each profile only needs to pick a
// model while reusing the [model_providers.switchboard] table Apply wrote.
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { writeCliFile } from "@/lib/cli/fileIo.js";
import {
  buildCodexProfileToml,
  isValidCodexProfileModel,
  isValidCodexProfileName,
  parseCodexProfileModel,
} from "@/app/(dashboard)/dashboard/cli-tools/components/codexConfig.js";

export const dynamic = "force-dynamic";

const getCodexDir = () => path.join(os.homedir(), ".codex");
const PROFILE_SUFFIX = ".config.toml";

const toProfile = (name, model) => ({ name, model, command: `codex -p ${name}` });

const readBody = async (request) => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

// GET - List all profiles from ~/.codex/<name>.config.toml
export async function GET() {
  try {
    const codexDir = getCodexDir();
    let files = [];
    try {
      files = await fs.readdir(codexDir);
    } catch (err) {
      if (err.code === "ENOENT") return NextResponse.json({ profiles: [] });
      throw err;
    }

    const names = files
      .filter((file) => file.endsWith(PROFILE_SUFFIX))
      .map((file) => file.slice(0, -PROFILE_SUFFIX.length))
      .filter(isValidCodexProfileName);

    const profiles = await Promise.all(
      names.map(async (name) => {
        try {
          const content = await fs.readFile(path.join(codexDir, `${name}${PROFILE_SUFFIX}`), "utf-8");
          return toProfile(name, parseCodexProfileModel(content));
        } catch {
          return toProfile(name, "");
        }
      }),
    );

    profiles.sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ profiles });
  } catch (error) {
    console.log("Error reading codex profiles:", error);
    return NextResponse.json({ error: "Failed to read profiles" }, { status: 500 });
  }
}

// POST - Create or update ~/.codex/<name>.config.toml
export async function POST(request) {
  try {
    const body = await readBody(request);
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

    const cleanName = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
    if (!isValidCodexProfileName(cleanName)) {
      return NextResponse.json(
        { error: "Profile name can only contain alphanumeric characters, dashes, underscores and cannot be 'config'" },
        { status: 400 },
      );
    }

    const cleanModel = typeof body.model === "string" ? body.model.trim() : "";
    if (!isValidCodexProfileModel(cleanModel)) {
      return NextResponse.json({ error: "Invalid model name" }, { status: 400 });
    }

    const codexDir = getCodexDir();
    await fs.mkdir(codexDir, { recursive: true });
    await writeCliFile(
      path.join(codexDir, `${cleanName}${PROFILE_SUFFIX}`),
      buildCodexProfileToml({ name: cleanName, model: cleanModel }),
    );

    return NextResponse.json({ success: true, profile: toProfile(cleanName, cleanModel) });
  } catch (error) {
    console.log("Error saving codex profile:", error);
    return NextResponse.json({ error: "Failed to save profile" }, { status: 500 });
  }
}

// DELETE - Remove ~/.codex/<name>.config.toml
export async function DELETE(request) {
  try {
    const body = await readBody(request);
    const cleanName = typeof body?.name === "string" ? body.name.trim().toLowerCase() : "";
    if (!isValidCodexProfileName(cleanName)) {
      return NextResponse.json({ error: "Invalid profile name" }, { status: 400 });
    }

    try {
      await fs.unlink(path.join(getCodexDir(), `${cleanName}${PROFILE_SUFFIX}`));
    } catch (err) {
      if (err.code === "ENOENT") {
        return NextResponse.json({ error: "Profile not found" }, { status: 404 });
      }
      throw err;
    }

    return NextResponse.json({ success: true, message: `Profile ${cleanName} deleted` });
  } catch (error) {
    console.log("Error deleting codex profile:", error);
    return NextResponse.json({ error: "Failed to delete profile" }, { status: 500 });
  }
}
