// @ts-check
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/jsonError.js";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { runQuotaAutoPingTick } from "@/shared/services/quotaAutoPing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
};

// Secrets must never be mass-assigned from request body
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted", "oidcClientSecret"];

// Dashboard login / OIDC removed — ignore if clients still send these.
const IGNORED_SETTING_KEYS = [
  "requireLogin",
  "authMode",
  "oidcIssuerUrl",
  "oidcClientId",
  "oidcClientSecret",
  "oidcScopes",
  "oidcLoginLabel",
  "newPassword",
  "currentPassword",
  "password",
];

function sanitizeSettings(settings) {
  const {
    password,
    oidcClientSecret,
    oidcIssuerUrl,
    oidcClientId,
    oidcScopes,
    oidcLoginLabel,
    authMode,
    requireLogin,
    ...safe
  } = settings || {};
  return {
    ...safe,
    requireLogin: false,
    authMode: "none",
    oidcConfigured: false,
    hasPassword: false,
  };
}

export async function GET() {
  try {
    const settings = await getSettings();
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";

    return NextResponse.json(
      {
        ...sanitizeSettings(settings),
        enableRequestLogs,
        enableTranslator,
      },
      { headers: SETTINGS_RESPONSE_HEADERS }
    );
  } catch (error) {
    console.log("Error getting settings:", error);
    return jsonError(500, error);
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();

    for (const key of PROTECTED_SETTING_KEYS) delete body[key];
    for (const key of IGNORED_SETTING_KEYS) delete body[key];

    const settings = await updateSettings(body);

    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      runQuotaAutoPingTick().catch((error) => {
        console.warn("[AutoPing] settings-triggered tick failed:", error.message);
      });
    }

    return NextResponse.json(sanitizeSettings(settings), { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    console.log("Error updating settings:", error);
    return jsonError(500, error);
  }
}
