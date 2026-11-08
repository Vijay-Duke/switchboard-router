// @ts-check
"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import os from "os";
import {
  HERMES_BACKUP_MARKER,
  buildHermesYaml,
  isNonEmptyString,
  isOptionalString,
  normalizeModelIds,
  removeHermesYaml,
} from "@/lib/cli/modelCatalog.js";
import { writeCliFile, replaceCliFiles } from "@/lib/cli/fileIo.js";
import {
  AUX_ROLE_KEY_RE,
  HERMES_API_KEY_ENV,
  HERMES_PROVIDER_REF,
  hasLegacySwitchboardModel,
  parseLegacyModelBlock,
  readHermesSettings,
  removeEnvVar,
  removeLegacyModelBlock,
  upsertEnvVar,
} from "@/lib/cli/hermesConfig.js";
import { isProfileHome, listProfiles, resolveHermesHome } from "./hermesProfiles.js";

const execAsync = promisify(exec);

const PROVIDER_NAME = "switchboard";

// Profile comes from ?profile= on GET (all-statuses calls GET() with no argument at all,
// so every reader must tolerate a missing request) and from the JSON body on POST/DELETE.
// POST/DELETE fall back to the query string — callers reach for either.
const getQueryParam = (request, key) => {
  if (!request) return null;
  try {
    const url = request.nextUrl || (typeof request.url === "string" ? new URL(request.url) : null);
    return url?.searchParams?.get(key) || null;
  } catch {
    return null;
  }
};

const truthy = (value) => value === true || value === "true" || value === "1";

const resolveHome = (profile) => {
  try {
    return { home: resolveHermesHome(profile) };
  } catch (error) {
    return { error: error.message };
  }
};

const readTextFile = async (file) => {
  try {
    return await fs.readFile(file, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

const readConfigYaml = (home) => readTextFile(home.configPath);
const readEnvFile = (home) => readTextFile(home.envPath);

// Named profile homes are created by `hermes profile create` — never by us: a directory
// without identity files is not a profile, and we must not fabricate one.
const writeHomeConfig = async (home, yaml) => {
  if (home.isDefault) await fs.mkdir(home.dir, { recursive: true });
  await writeCliFile(home.configPath, yaml, { secret: true });
};

// Only ever upserts the SWITCHBOARD_API_KEY line — per-profile .env files also carry bot
// tokens and messaging-channel credentials that must stay untouched.
const applyHomeConfig = async (home, yaml, apiKey) => {
  if (home.isDefault) await fs.mkdir(home.dir, { recursive: true });
  const operations = [{ filePath: home.configPath, content: yaml, secret: true }];
  if (isNonEmptyString(apiKey)) {
    operations.push({ filePath: home.envPath,
      content: upsertEnvVar(await readEnvFile(home), HERMES_API_KEY_ENV, apiKey), secret: true });
  }
  await replaceCliFiles(operations);
};

const checkHermesInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where hermes" : "which hermes";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(resolveHermesHome(null).configPath);
      return true;
    } catch {
      return false;
    }
  }
};

export async function GET(request) {
  try {
    const installed = await checkHermesInstalled();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Hermes Agent is not installed" });
    }

    const { home, error } = resolveHome(getQueryParam(request, "profile"));
    if (error) return NextResponse.json({ error }, { status: 400 });
    if (!home.isDefault && !(await isProfileHome(home.dir))) {
      return NextResponse.json({ error: `Hermes profile "${home.name}" not found` }, { status: 404 });
    }

    const settings = readHermesSettings(await readConfigYaml(home));
    return NextResponse.json({
      installed: true,
      profile: { name: home.name, dir: home.dir, isDefault: home.isDefault },
      settings: {
        model: settings.model,
        models: settings.models.length ? settings.models : (settings.defaultModel ? [settings.defaultModel] : []),
        defaultModel: settings.defaultModel,
        delegation: settings.delegation,
        auxiliary: settings.auxiliary,
        stt: settings.stt ? { enabled: settings.stt.enabled, provider: settings.stt.provider,
          model: settings.stt.model, base_url: settings.stt.base_url, hasApiKey: !!settings.stt.api_key } : null,
      },
      hasSwitchboard: settings.hasSwitchboard,
      hasSwitchboardStt: settings.hasSwitchboardStt,
      configPath: home.configPath,
    });
  } catch (error) {
    console.log("Error checking hermes settings:", error);
    return NextResponse.json({ error: "Failed to check hermes settings" }, { status: 500 });
  }
}

// Endpoint + API key across every profile: refresh the Switchboard wiring each profile
// already has (models stay per-profile), and wire up profiles that have no main model yet
// using the model chosen in this request. Profiles on another provider are reported,
// never rewritten.
const applyToAllProfiles = async ({ normalizedBaseUrl, apiKey, model }) => {
  const profiles = await listProfiles();
  const results = [];
  for (const profile of profiles) {
    const home = resolveHermesHome(profile.name);
    try {
      const yaml = await readConfigYaml(home);
      const settings = readHermesSettings(yaml);
      const providerManaged = settings.hasSwitchboard;

      if (providerManaged) {
        // buildHermesYaml keeps role/stt wiring that is already ours when the
        // corresponding params are absent, so this refresh only moves the
        // endpoint (and migrates a legacy model block onto the named provider).
        const baseYaml = yaml;
        const models = settings.models.length ? settings.models : (settings.defaultModel ? [settings.defaultModel] : []);
        const defaultModel = settings.defaultModel;
        await applyHomeConfig(home, buildHermesYaml(baseYaml, {
          baseUrl: normalizedBaseUrl,
          models,
          defaultModel,
        }), apiKey);
        results.push({ profile: profile.name, status: "updated", model: defaultModel });
      } else if (settings.defaultModel) {
        results.push({
          profile: profile.name,
          status: "skipped",
          reason: `main model uses provider "${settings.model?.provider || "unknown"}" — configure this profile individually`,
        });
      } else if (model) {
        await applyHomeConfig(home, buildHermesYaml(yaml, {
          baseUrl: normalizedBaseUrl,
          models: [model],
          defaultModel: model,
        }), apiKey);
        results.push({ profile: profile.name, status: "updated", model });
      } else {
        results.push({ profile: profile.name, status: "skipped", reason: "no main model configured" });
      }
    } catch (error) {
      results.push({ profile: profile.name, status: "failed", reason: error.message });
    }
  }
  const updated = results.filter((r) => r.status === "updated").length;
  return NextResponse.json({
    success: updated > 0,
    bulk: true,
    results,
    updated,
    skipped: results.length - updated,
    message: `Updated endpoint on ${updated} profile(s)`,
  });
};

export async function POST(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { baseUrl, apiKey, model, models: requestedModels, defaultModel, delegation, auxiliary, audio, selections } = body || {};

    // selections: [{role, model}] — "default" plus any auxiliary/delegation slots.
    // Legacy callers (CLI quick setup) send a bare `model` → treated as the default.
    let effectiveDefault = defaultModel || model;
    let effectiveModels = requestedModels;
    let effectiveDelegation = delegation;
    if (auxiliary != null && (typeof auxiliary !== "object" || Array.isArray(auxiliary))) {
      return NextResponse.json({ error: "auxiliary must be a role mapping" }, { status: 400 });
    }
    let effectiveAuxiliary = auxiliary ? { ...auxiliary } : undefined;
    if (Array.isArray(selections)) {
      effectiveAuxiliary = effectiveAuxiliary || {};
      for (const { role, model: roleModel } of selections.filter((s) => s?.role)) {
        if (role === "default") effectiveDefault = roleModel;
        else if (role === "delegation") effectiveDelegation = roleModel;
        else effectiveAuxiliary[role] = roleModel;
      }
    }
    const models = normalizeModelIds(effectiveModels ?? effectiveDefault);

    // audio: { enabled, model } — wire Hermes speech-to-text through the gateway's
    // /v1/audio/transcriptions. Absent = leave the stt section untouched (legacy CLI
    // callers). enabled:true needs a provider-qualified STT model (the gateway routes
    // on it); enabled:false removes exactly the wiring this endpoint writes.
    const audioEnabled = audio ? truthy(audio.enabled) : false;
    const audioModel = typeof audio?.model === "string" ? audio.model.trim() : "";
    if (audioEnabled && !audioModel) {
      return NextResponse.json({ error: "audio.model is required when enabling audio transcription" }, { status: 400 });
    }

    if (!isNonEmptyString(baseUrl) || !isOptionalString(apiKey) || models.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }
    if (effectiveDelegation != null && typeof effectiveDelegation !== "string") {
      return NextResponse.json({ error: "delegation must be a model ID or null" }, { status: 400 });
    }
    if (effectiveAuxiliary != null && (typeof effectiveAuxiliary !== "object" || Array.isArray(effectiveAuxiliary))) {
      return NextResponse.json({ error: "auxiliary must be a role mapping" }, { status: 400 });
    }
    for (const [role, value] of Object.entries(effectiveAuxiliary || {})) {
      if (value != null && typeof value !== "string") return NextResponse.json({ error: "role models must be strings or null" }, { status: 400 });
      if (!AUX_ROLE_KEY_RE.test(role)) {
        return NextResponse.json({ error: `Invalid Hermes role name "${role}"` }, { status: 400 });
      }
    }

    let parsedBase;
    try { parsedBase = new URL(baseUrl); } catch { return NextResponse.json({ error: "Invalid baseUrl" }, { status: 400 }); }
    if (!["http:", "https:"].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password) {
      return NextResponse.json({ error: "baseUrl must be an HTTP(S) endpoint without credentials" }, { status: 400 });
    }
    const cleanBase = baseUrl.trim().replace(/\/+$/, "");
    const normalizedBaseUrl = cleanBase.endsWith("/v1") ? cleanBase : `${cleanBase}/v1`;

    // applyToAll refreshes endpoint + API key only (and the blocks those belong to);
    // role and stt wiring is per-profile and follows the single-profile path below.
    if (truthy(body.applyToAll ?? getQueryParam(request, "applyToAll"))) {
      return await applyToAllProfiles({ normalizedBaseUrl, apiKey, model: models[0] || null });
    }

    // Profile target: JSON body first, then ?profile= — callers reach for either.
    const { home, error } = resolveHome(body.profile ?? getQueryParam(request, "profile"));
    if (error) return NextResponse.json({ error }, { status: 400 });
    if (!home.isDefault && !(await isProfileHome(home.dir))) {
      return NextResponse.json({ error: `Hermes profile "${home.name}" not found` }, { status: 404 });
    }

    // Migrate a legacy (pre custom_providers) Switchboard model block off the file
    // before writing — buildHermesYaml snapshots everything still present.
    const existingYaml = await readConfigYaml(home);
    const baseYaml = existingYaml;
    const newYaml = buildHermesYaml(baseYaml, {
      baseUrl: normalizedBaseUrl,
      models,
      defaultModel: effectiveDefault,
      delegation: effectiveDelegation,
      auxiliary: effectiveAuxiliary,
      stt: audio ? { enabled: audioEnabled, model: audioModel } : undefined,
    });
    await applyHomeConfig(home, newYaml, apiKey);

    const settings = readHermesSettings(newYaml);
    const scope = home.isDefault ? "" : ` to profile "${home.name}"`;
    return NextResponse.json({
      success: true,
      message: `Hermes configured with ${models.length} model${models.length === 1 ? "" : "s"}${scope}.`,
      profile: { name: home.name, dir: home.dir, isDefault: home.isDefault },
      hasSwitchboardStt: settings.hasSwitchboardStt,
      configPath: home.configPath,
    });
  } catch (error) {
    console.log("Error updating hermes settings:", error);
    return NextResponse.json({ error: "Failed to update hermes settings" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    let body = null;
    if (request && typeof request.json === "function") {
      try {
        body = await request.json();
      } catch {
        body = null; // CLI reset sends an empty body → default profile
      }
    }

    const { home, error } = resolveHome(body?.profile ?? getQueryParam(request, "profile"));
    if (error) return NextResponse.json({ error }, { status: 400 });
    if (!home.isDefault && !(await isProfileHome(home.dir))) {
      return NextResponse.json({ error: `Hermes profile "${home.name}" not found` }, { status: 404 });
    }

    let yaml = "";
    try {
      yaml = await fs.readFile(home.configPath, "utf-8");
    } catch (readError) {
      if (readError.code === "ENOENT") {
        return NextResponse.json({ success: true, profile: home.name, message: "No config file to reset" });
      }
      throw readError;
    }

    // Managed docs restore their pre-Switchboard state from the backup marker
    // (model slots, roles and stt alike). A legacy model block is stripped by
    // hand; anything else is the user's own configuration and stays untouched.
    const managed = yaml.includes(HERMES_BACKUP_MARKER);
    if (managed) {
      await writeHomeConfig(home, removeHermesYaml(yaml));
    } else {
      const legacyModel = parseLegacyModelBlock(yaml);
      if (!hasLegacySwitchboardModel(legacyModel)) {
        return NextResponse.json({
          success: true,
          profile: home.name,
          message: "Config was not Switchboard-managed; left unchanged",
        });
      }
      await writeHomeConfig(home, removeLegacyModelBlock(yaml));
    }

    // The API key line is ours; the rest of the .env (bot tokens, channel
    // credentials) is not.
    try {
      const env = await readEnvFile(home);
      await writeCliFile(home.envPath, removeEnvVar(env, HERMES_API_KEY_ENV), { secret: true });
    } catch { /* optional env */ }

    const scope = home.isDefault ? "" : ` in profile "${home.name}"`;
    return NextResponse.json({
      success: true,
      profile: home.name,
      message: `${PROVIDER_NAME} blocks removed${scope}`,
    });
  } catch (error) {
    console.log("Error resetting hermes settings:", error);
    return NextResponse.json({ error: "Failed to reset hermes settings" }, { status: 500 });
  }
}
