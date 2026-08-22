// @ts-check
import { NextResponse } from "next/server";
import { jsonError } from "@/lib/jsonError.js";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { runQuotaAutoPingTick } from "@/shared/services/quotaAutoPing";
import { findAutoComboMissingRouter } from "@/lib/combos/comboWrites.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// findAutoComboMissingRouter now lives in comboWrites.js (shared with the
// management API) — imported above.
const PROVIDER_STRATEGIES = new Set([
  "off",
  "priority",
  "round-robin",
  "fastest",
  "quota-first",
]);

function findInvalidProviderPreference(comboStrategies) {
  if (!comboStrategies || typeof comboStrategies !== "object") return null;
  for (const [name, strat] of Object.entries(comboStrategies)) {
    if (!strat || typeof strat !== "object" || Array.isArray(strat)) continue;
    if (
      Object.prototype.hasOwnProperty.call(strat, "providerStrategy") &&
      !PROVIDER_STRATEGIES.has(strat.providerStrategy)
    ) {
      return `Combo "${name}" providerStrategy must be one of: off, priority, round-robin, fastest, quota-first.`;
    }
    if (
      Object.prototype.hasOwnProperty.call(strat, "providerOrder") &&
      (!Array.isArray(strat.providerOrder) ||
        !strat.providerOrder.every((provider) => typeof provider === "string"))
    ) {
      return `Combo "${name}" providerOrder must be an array of provider name strings.`;
    }
    if (
      Object.prototype.hasOwnProperty.call(strat, "providerLatencyGuardMs") &&
      (!Number.isFinite(strat.providerLatencyGuardMs) || strat.providerLatencyGuardMs <= 0)
    ) {
      return `Combo "${name}" providerLatencyGuardMs must be a positive finite number.`;
    }
  }
  return null;
}

function findInvalidAccountScheduler(providerStrategies) {
  if (!providerStrategies || typeof providerStrategies !== "object" || Array.isArray(providerStrategies)) {
    return "providerStrategies must be an object.";
  }

  for (const [providerId, strategy] of Object.entries(providerStrategies)) {
    if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) continue;
    const scheduler = strategy.accountScheduler;
    if (scheduler === undefined) continue;
    if (!scheduler || typeof scheduler !== "object" || Array.isArray(scheduler)) {
      return `Provider "${providerId}" accountScheduler must be an object.`;
    }
    if (typeof scheduler.enabled !== "boolean") {
      return `Provider "${providerId}" accountScheduler.enabled must be boolean.`;
    }
    const ttl = scheduler.sessionAffinityTtlSeconds;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) {
      return `Provider "${providerId}" accountScheduler.sessionAffinityTtlSeconds must be an integer from 60 to 86400.`;
    }
  }

  return null;
}

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

    // Normalize the SSRF trust list: array of non-empty lowercased hosts, deduped.
    if (Object.prototype.hasOwnProperty.call(body, "ssrfAllowHosts")) {
      const raw = body.ssrfAllowHosts;
      if (!Array.isArray(raw)) {
        return NextResponse.json(
          { error: "ssrfAllowHosts must be an array of host strings." },
          { status: 400, headers: SETTINGS_RESPONSE_HEADERS }
        );
      }
      body.ssrfAllowHosts = [
        ...new Set(
          raw
            .filter((h) => typeof h === "string")
            .map((h) => h.trim().toLowerCase().replace(/^\[|\]$/g, ""))
            .filter(Boolean)
        ),
      ];
    }

    // Auto combos require an explicit routerModel — there is no default.
    if (Object.prototype.hasOwnProperty.call(body, "comboStrategies")) {
      const invalidAuto = findAutoComboMissingRouter(body.comboStrategies);
      if (invalidAuto) {
        return NextResponse.json(
          {
            error: `Auto combo "${invalidAuto}" requires a router model — select one in the combo's Auto settings (a cheap, fast model such as Haiku works well).`,
          },
          { status: 400, headers: SETTINGS_RESPONSE_HEADERS }
        );
      }
      const invalidProviderPreference = findInvalidProviderPreference(body.comboStrategies);
      if (invalidProviderPreference) {
        return NextResponse.json(
          { error: invalidProviderPreference },
          { status: 400, headers: SETTINGS_RESPONSE_HEADERS }
        );
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "providerStrategies")) {
      const invalidScheduler = findInvalidAccountScheduler(body.providerStrategies);
      if (invalidScheduler) {
        return NextResponse.json(
          { error: invalidScheduler },
          { status: 400, headers: SETTINGS_RESPONSE_HEADERS },
        );
      }
    }

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
