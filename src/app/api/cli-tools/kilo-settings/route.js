// @ts-check
"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { buildKiloConfig, isNonEmptyString, normalizeModelIds } from "@/lib/cli/modelCatalog.js";
import { snapshotObjectKeys, writeCliFile } from "@/lib/cli/fileIo.js";

const execAsync = promisify(exec);
const FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" };

const getConfigDir = () => {
  if (os.platform() === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "kilo");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "kilo");
};

const resolveConfigPath = async () => {
  const jsoncPath = path.join(getConfigDir(), "kilo.jsonc");
  try { await fs.access(jsoncPath); return jsoncPath; } catch { return path.join(getConfigDir(), "kilo.json"); }
};
const getBackupPath = () => path.join(getConfigDir(), "switchboard-backup.json");

const readBackup = async () => {
  try { return JSON.parse(await fs.readFile(getBackupPath(), "utf-8")); }
  catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
};

const checkInstalled = async () => {
  try {
    await execAsync(os.platform() === "win32" ? "where kilo" : "which kilo", { windowsHide: true });
    return true;
  } catch {
    try { await fs.access(await resolveConfigPath()); return true; } catch { return false; }
  }
};

const readConfig = async () => {
  const configPath = await resolveConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const errors = [];
    const config = parseJsonc(raw, errors) || {};
    if (errors.length) throw new Error(`Invalid Kilo JSONC (${errors[0].error})`);
    return { configPath, raw, config, exists: true };
  } catch (error) {
    if (error.code === "ENOENT") return { configPath, raw: "{}\n", config: {}, exists: false };
    throw error;
  }
};

const updateJsonc = (raw, pathSegments, value) => applyEdits(
  raw,
  modify(raw, pathSegments, value, { formattingOptions: FORMATTING }),
);

export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) return NextResponse.json({ installed: false, settings: null, message: "Kilo Code CLI is not installed" });
    const { configPath, config } = await readConfig();
    const provider = config?.provider?.switchboard;
    const models = provider?.models && typeof provider.models === "object" ? Object.keys(provider.models) : [];
    const defaultModel = typeof config?.model === "string" && config.model.startsWith("switchboard/")
      ? config.model.slice("switchboard/".length)
      : null;
    return NextResponse.json({
      installed: true,
      hasSwitchboard: Boolean(provider),
      settings: { baseUrl: provider?.options?.baseURL || null, models, model: defaultModel, defaultModel },
      configPath,
    });
  } catch (error) {
    console.log("Error checking kilo settings:", error);
    return NextResponse.json({ error: "Failed to check kilo settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models: requestedModels, defaultModel } = await request.json();
    const models = normalizeModelIds(requestedModels ?? model);
    if (!isNonEmptyString(baseUrl) || !isNonEmptyString(apiKey) || models.length === 0) {
      return NextResponse.json({ error: "baseUrl, apiKey, and at least one model are required" }, { status: 400 });
    }
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const { configPath, raw, config } = await readConfig();
    const existingBackup = await readBackup();
    const backup = existingBackup.version === 1 ? existingBackup : {
      version: 1,
      model: snapshotObjectKeys(config, ["model"]).model,
      provider: snapshotObjectKeys(config.provider || {}, ["switchboard"]).switchboard,
    };
    await writeCliFile(getBackupPath(), JSON.stringify(backup, null, 2), { secret: true });
    const next = buildKiloConfig(config, { baseUrl: normalizedBaseUrl, apiKey, models, defaultModel: defaultModel || model });
    let nextRaw = updateJsonc(raw, ["provider", "switchboard"], next.provider.switchboard);
    nextRaw = updateJsonc(nextRaw, ["model"], next.model);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeCliFile(configPath, nextRaw, { secret: true });
    return NextResponse.json({ success: true, message: `Kilo configured with ${models.length} model${models.length === 1 ? "" : "s"}.`, configPath });
  } catch (error) {
    console.log("Error updating kilo settings:", error);
    return NextResponse.json({ error: "Failed to update kilo settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const { configPath, raw, config, exists } = await readConfig();
    if (!exists) return NextResponse.json({ success: true, message: "No settings file to reset" });
    const backup = await readBackup();
    let nextRaw = updateJsonc(
      raw,
      ["provider", "switchboard"],
      backup.version === 1 && backup.provider?.exists ? backup.provider.value : undefined,
    );
    if (typeof config?.model === "string" && config.model.startsWith("switchboard/")) {
      nextRaw = updateJsonc(
        nextRaw,
        ["model"],
        backup.version === 1 && backup.model?.exists ? backup.model.value : undefined,
      );
    }
    await writeCliFile(configPath, nextRaw, { secret: true });
    try { await fs.unlink(getBackupPath()); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return NextResponse.json({ success: true, message: "Switchboard removed from Kilo Code" });
  } catch (error) {
    if (error.code === "ENOENT") return NextResponse.json({ success: true, message: "No settings file to reset" });
    console.log("Error resetting kilo settings:", error);
    return NextResponse.json({ error: "Failed to reset kilo settings" }, { status: 500 });
  }
}
