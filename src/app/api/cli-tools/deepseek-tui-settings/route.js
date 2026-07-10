// @ts-check
"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseTOML, stringifyTOML } from "confbox";
import { writeCliFile } from "@/lib/cli/fileIo.js";
import { isNonEmptyString, isOptionalString } from "@/lib/cli/modelCatalog.js";

const execAsync = promisify(exec);

const PROVIDER_NAME = "switchboard";

const getDeepSeekDir = () => path.join(os.homedir(), ".deepseek");
const getDeepSeekConfigPath = () => path.join(getDeepSeekDir(), "config.toml");
const getBackupPath = () => path.join(getDeepSeekDir(), "switchboard-backup.json");

const checkDeepSeekInstalled = async () => {
    try {
        const isWindows = os.platform() === "win32";
        const command = isWindows ? "where deepseek" : "which deepseek";
        await execAsync(command, { windowsHide: true });
        return true;
    } catch {
        try {
            await fs.access(getDeepSeekConfigPath());
            return true;
        } catch {
            return false;
        }
    }
};

const readConfigToml = async () => {
    try {
        return await fs.readFile(getDeepSeekConfigPath(), "utf-8");
    } catch (error) {
        if (error.code === "ENOENT") return "";
        throw error;
    }
};

// Detect Switchboard by checking if provider is "openai" and base_url points to localhost/127.0.0.1
const hasSwitchboardConfig = (config) => {
    if (!config) return false;
    const provider = config.provider;
    if (provider !== "openai") return false;
    const openaiSection = config.providers?.openai;
    if (!openaiSection?.base_url) return false;
    return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(openaiSection.base_url);
};

export async function GET() {
    try {
        const installed = await checkDeepSeekInstalled();
        if (!installed) {
            return NextResponse.json({ installed: false, settings: null, message: "DeepSeek TUI is not installed" });
        }
        const toml = await readConfigToml();
        const config = toml ? parseTOML(toml) : {};
        return NextResponse.json({
            installed: true,
            settings: config,
            hasSwitchboard: hasSwitchboardConfig(config),
            configPath: getDeepSeekConfigPath(),
        });
    } catch (error) {
        console.log("Error checking deepseek-tui settings:", error);
        return NextResponse.json({ error: "Failed to check deepseek-tui settings" }, { status: 500 });
    }
}

export async function POST(request) {
    try {
        const { baseUrl, apiKey, model } = await request.json();
        if (!isNonEmptyString(baseUrl) || !isNonEmptyString(model) || !isOptionalString(apiKey)) {
            return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
        }

        const dir = getDeepSeekDir();
        await fs.mkdir(dir, { recursive: true });

        const existing = await readConfigToml();
        const config = existing ? parseTOML(existing) : {};
        let backup;
        try {
            backup = JSON.parse(await fs.readFile(getBackupPath(), "utf-8"));
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
            backup = {
                provider: config.provider,
                openai: config.providers?.openai,
            };
        }
        const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
        backup.managedBaseUrl = normalizedBaseUrl;
        await writeCliFile(getBackupPath(), JSON.stringify(backup, null, 2), { secret: true });
        config.provider = "openai";
        config.providers = { ...(config.providers || {}), openai: {
            ...(config.providers?.openai || {}),
            base_url: normalizedBaseUrl,
            api_key: apiKey || "sk_switchboard",
            model,
        } };
        await writeCliFile(getDeepSeekConfigPath(), stringifyTOML(config), { secret: true });

        return NextResponse.json({
            success: true,
            message: "DeepSeek TUI settings applied successfully!",
            configPath: getDeepSeekConfigPath(),
        });
    } catch (error) {
        console.log("Error updating deepseek-tui settings:", error);
        return NextResponse.json({ error: "Failed to update deepseek-tui settings" }, { status: 500 });
    }
}

export async function DELETE() {
    try {
        const configPath = getDeepSeekConfigPath();
        try {
            await fs.access(configPath);
        } catch {
            return NextResponse.json({ success: true, message: "No config file to reset" });
        }

        const current = parseTOML(await fs.readFile(configPath, "utf-8"));
        let backup = null;
        try { backup = JSON.parse(await fs.readFile(getBackupPath(), "utf-8")); } catch { /* legacy */ }
        const managed = current.provider === "openai"
            && current.providers?.openai?.base_url === backup?.managedBaseUrl;
        if (managed) {
            if (backup?.provider) current.provider = backup.provider;
            else delete current.provider;
            if (current.providers?.openai) {
                if (backup?.openai) current.providers.openai = backup.openai;
                else delete current.providers.openai;
                if (Object.keys(current.providers).length === 0) delete current.providers;
            }
            await writeCliFile(configPath, stringifyTOML(current), { secret: true });
        }
        try { await fs.unlink(getBackupPath()); } catch { /* optional */ }
        return NextResponse.json({
            success: true,
            message: managed ? `${PROVIDER_NAME} config restored` : "Config no longer points to Switchboard; left unchanged",
        });
    } catch (error) {
        console.log("Error resetting deepseek-tui settings:", error);
        return NextResponse.json({ error: "Failed to reset deepseek-tui settings" }, { status: 500 });
    }
}
