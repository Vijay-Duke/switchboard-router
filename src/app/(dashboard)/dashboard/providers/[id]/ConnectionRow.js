"use client";
// @ts-check

import { useState, useEffect } from "react";
import { getStatusVariant as getConnectionStatusVariant } from "@/shared/utils/connectionStatus";
import PropTypes from "prop-types";
import { Badge, Toggle, Tooltip } from "@/shared/components";
import CooldownTimer from "./CooldownTimer";

export default function ConnectionRow({ connection, isOAuth, isFirst, isLast, onMoveUp, onMoveDown, onToggleActive, onEdit, onDelete, onAllowlistHost = null, oneByOneStatus = null, autoPing = null }) {
  const rowAuthType = connection.authType || (isOAuth ? "oauth" : "apikey");
  const isOAuthConnection = rowAuthType === "oauth";
  const isCookieConnection = rowAuthType === "cookie";
  const authIcon = isCookieConnection ? "cookie" : isOAuthConnection ? "lock" : "key";
  const authLabel = isOAuthConnection ? "OAuth" : isCookieConnection ? "Cookie" : "API Key";
  const displayName = connection.name?.trim()
    || connection.email?.trim()
    || connection.displayName?.trim()
    || (isOAuthConnection ? "OAuth Account" : isCookieConnection ? "Cookie Account" : "API Key");
  const secondaryDisplayName = connection.name?.trim() && connection.email?.trim() && connection.name.trim() !== connection.email.trim()
    ? connection.email.trim()
    : connection.name?.trim() && connection.displayName?.trim() && connection.name.trim() !== connection.displayName.trim()
      ? connection.displayName.trim()
      : null;

  // An SSRF block is the one error the user can self-resolve: the gateway is
  // reachable but resolves to a private/VPN IP the guard rejects by default.
  const isSsrfBlocked = /SSRF blocked|Blocked URL: (private IP|internal host)/i.test(connection.lastError || "");

  const formatConnectionError = (rawError) => {
    if (!rawError) return null;
    let text = String(rawError).trim();

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}$/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const extracted = parsed?.error?.message || parsed?.message || parsed?.error;
        if (typeof extracted === "string" && extracted.trim()) {
          text = extracted.trim();
        }
      }
    } catch {
      // not JSON
    }

    text = text.replace(/^\[\d+\]:\s*/, "");

    if (/not have a valid license|license of this product|license required/i.test(text)) {
      return {
        type: "license",
        title: "License Required",
        message: "No active Gemini Code Assist or Antigravity license found for this Google account. Visit antigravity.google to activate, or reconnect.",
        action: isOAuthConnection ? "reconnect" : null,
      };
    }

    if (/invalid_grant|token expired|credentials expired|expired or revoked|session expired/i.test(text)) {
      return {
        type: "auth",
        title: "Session Expired",
        message: "OAuth token expired or was revoked. Please reconnect.",
        action: isOAuthConnection ? "reconnect" : null,
      };
    }

    if (/rate limit|quota|429|resource has been exhausted/i.test(text)) {
      return {
        type: "quota",
        title: "Rate Limited",
        message: text || "Upstream rate limit reached.",
        action: null,
      };
    }

    if (isSsrfBlocked) {
      return {
        type: "ssrf",
        title: "Network Guard",
        message: "SSRF guard blocked local/private IP address.",
        action: "allowlist",
      };
    }

    return {
      type: "error",
      title: "Error",
      message: text,
      action: isOAuthConnection ? "reconnect" : null,
    };
  };

  const errorInfo = formatConnectionError(connection.lastError);
  const hasLegacyProxy = connection.providerSpecificData?.connectionProxyEnabled === true && !!connection.providerSpecificData?.connectionProxyUrl;
  const hasAnyProxy = hasLegacyProxy;
  const proxyDisplayText = hasLegacyProxy
    ? `Proxy: ${connection.providerSpecificData?.connectionProxyUrl}`
    : "";
  const autoPingTooltip = autoPing?.provider === "codex"
    ? "Auto-starts the next 5h Codex window after reset by sending a tiny gpt-5.5 request. Consumes a small amount of quota."
    : "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.";

  let maskedProxyUrl = "";
  if (connection.providerSpecificData?.connectionProxyUrl) {
    const rawProxyUrl = connection.providerSpecificData?.connectionProxyUrl;
    try {
      const parsed = new URL(rawProxyUrl);
      maskedProxyUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      maskedProxyUrl = rawProxyUrl;
    }
  }

  const noProxyText = connection.providerSpecificData?.connectionNoProxy || "";
  const proxyBadgeVariant = hasLegacyProxy ? "success" : "default";

  // Use useState + useEffect for impure Date.now() to avoid calling during render
  const [isCooldown, setIsCooldown] = useState(false);

  // Get earliest model lock timestamp (useEffect handles the Date.now() comparison)
  const modelLockUntil = Object.entries(connection)
    .filter(([k]) => k.startsWith("modelLock_"))
    .map(([, v]) => v)
    .filter(v => !!v)
    .sort()[0] || null;

  useEffect(() => {
    const checkCooldown = () => {
      const until = Object.entries(connection)
        .filter(([k]) => k.startsWith("modelLock_"))
        .map(([, v]) => v)
        .filter(v => v && new Date(v).getTime() > Date.now())
        .sort()[0] || null;
      setIsCooldown(!!until);
    };

    checkCooldown();
    const interval = modelLockUntil ? setInterval(checkCooldown, 1000) : null;
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [connection, modelLockUntil]);

  // Determine effective status (override unavailable if cooldown expired)
  const effectiveStatus = (connection.testStatus === "unavailable" && !isCooldown)
    ? "active"  // Cooldown expired → treat as active
    : connection.testStatus;

  const getStatusVariant = () => getConnectionStatusVariant(connection.isActive, effectiveStatus);

  const getOneByOneVariant = () => {
    if (!oneByOneStatus) return "default";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed") return "error";
    if (oneByOneStatus.state === "testing") return "primary";
    return "default";
  };

  const getOneByOneLabel = () => {
    if (!oneByOneStatus) return null;
    if (oneByOneStatus.state === "queued") return "queued";
    if (oneByOneStatus.state === "testing") return "testing";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed") return oneByOneStatus.error ? `failed: ${oneByOneStatus.error}` : "failed";
    return null;
  };

  return (
    <div className={`group flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-surface/40 p-3 transition-all hover:border-border hover:bg-surface/70 ${connection.isActive === false ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* Priority arrows */}
            <div className="flex shrink-0 flex-col">
              <button
                onClick={onMoveUp}
                disabled={isFirst}
                aria-label={`Move ${displayName} up`}
                title={`Move ${displayName} up`}
                className={`p-0.5 rounded ${isFirst ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
              >
                <span className="material-symbols-outlined text-sm" aria-hidden="true">keyboard_arrow_up</span>
              </button>
              <button
                onClick={onMoveDown}
                disabled={isLast}
                aria-label={`Move ${displayName} down`}
                title={`Move ${displayName} down`}
                className={`p-0.5 rounded ${isLast ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
              >
                <span className="material-symbols-outlined text-sm" aria-hidden="true">keyboard_arrow_down</span>
              </button>
            </div>
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 border border-border/40 text-text-muted">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                {authIcon}
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-main truncate">{displayName}</p>
              {secondaryDisplayName && (
                <p className="text-xs text-text-muted truncate">{secondaryDisplayName}</p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1">
              {autoPing && (
                <Tooltip text={autoPingTooltip}>
                  <button
                    onClick={() => autoPing.onToggle(!autoPing.on)}
                    className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-white/5 ${autoPing.on ? "text-primary bg-primary/10 font-medium" : "text-text-muted hover:text-primary"}`}
                  >
                    <span className="material-symbols-outlined text-[16px]">bolt</span>
                    <span className="hidden sm:inline text-xs">Auto-ping</span>
                  </button>
                </Tooltip>
              )}
              <button
                onClick={onEdit}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-text-muted hover:bg-white/5 hover:text-primary transition-colors"
                title="Edit connection"
              >
                <span className="material-symbols-outlined text-[16px]">edit</span>
                <span className="hidden sm:inline">Edit</span>
              </button>
              <button
                onClick={onDelete}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                title="Delete connection"
              >
                <span className="material-symbols-outlined text-[16px]">delete</span>
                <span className="hidden sm:inline">Delete</span>
              </button>
            </div>
            <div className="h-4 w-px bg-border/60 mx-1" />
            <Toggle
              size="sm"
              checked={connection.isActive ?? true}
              onChange={onToggleActive}
              title={(connection.isActive ?? true) ? "Disable connection" : "Enable connection"}
            />
          </div>
        </div>

        {/* Badges row */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-0 sm:pl-10">
          <Badge variant={getStatusVariant()} size="sm" dot>
            {connection.isActive === false ? "disabled" : (effectiveStatus || "Unknown")}
          </Badge>
          <Badge variant="default" size="sm">
            {authLabel}
          </Badge>
          {hasAnyProxy && (
            <Badge variant={proxyBadgeVariant} size="sm">
              Proxy
            </Badge>
          )}
          {isCooldown && connection.isActive !== false && <CooldownTimer until={modelLockUntil} />}
          <span className="text-xs text-text-muted">#{connection.priority}</span>
          {connection.globalPriority && (
            <span className="text-xs text-text-muted">Auto: {connection.globalPriority}</span>
          )}
          {getOneByOneLabel() && (
            <Badge variant={getOneByOneVariant()} size="sm">
              {getOneByOneLabel()}
            </Badge>
          )}
        </div>

        {/* Actionable Error Callout */}
        {errorInfo && connection.isActive !== false && (
          <div className="mt-1.5 flex min-w-0 flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-xs text-red-600 dark:text-red-400 sm:ml-10">
            <div className="flex min-w-0 items-start sm:items-center gap-2">
              <span className="material-symbols-outlined shrink-0 text-[16px] text-red-500 mt-0.5 sm:mt-0">
                {errorInfo.type === "license" ? "workspace_premium" : errorInfo.type === "auth" ? "key_off" : "error"}
              </span>
              <div className="min-w-0">
                <span className="font-semibold">{errorInfo.title}: </span>
                <span className="break-words">{errorInfo.message}</span>
              </div>
            </div>
            {errorInfo.action === "reconnect" && (
              <button
                onClick={onEdit}
                className="inline-flex shrink-0 items-center justify-center gap-1 rounded-md bg-red-500/15 hover:bg-red-500/25 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-300 transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">refresh</span>
                Reconnect
              </button>
            )}
            {errorInfo.action === "allowlist" && onAllowlistHost && (
              <button
                onClick={onAllowlistHost}
                className="inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-300 hover:bg-amber-500/20 transition-colors"
              >
                <span className="material-symbols-outlined text-[14px]">verified_user</span>
                Add to allow list
              </button>
            )}
          </div>
        )}

        {/* Proxy info row */}
        {hasAnyProxy && (
          <div className="mt-1 flex items-center gap-2 flex-wrap sm:ml-10">
            <span className="max-w-full truncate text-[11px] text-text-muted sm:max-w-[420px]" title={proxyDisplayText}>
              {proxyDisplayText}
            </span>
            {maskedProxyUrl && (
              <code className="max-w-full truncate rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] text-text-muted dark:bg-white/5 sm:max-w-[260px]">
                {maskedProxyUrl}
              </code>
            )}
            {noProxyText && (
              <span className="max-w-full truncate text-[11px] text-text-muted sm:max-w-[320px]" title={noProxyText}>
                no_proxy: {noProxyText}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

ConnectionRow.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    modelLockUntil: PropTypes.string,
    testStatus: PropTypes.string,
    isActive: PropTypes.bool,
    lastError: PropTypes.string,
    priority: PropTypes.number,
    globalPriority: PropTypes.number,
    providerSpecificData: PropTypes.object,
  }).isRequired,
  isOAuth: PropTypes.bool.isRequired,
  isFirst: PropTypes.bool.isRequired,
  isLast: PropTypes.bool.isRequired,
  onMoveUp: PropTypes.func.isRequired,
  onMoveDown: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onAllowlistHost: PropTypes.func,
  oneByOneStatus: PropTypes.shape({
    state: PropTypes.string,
    error: PropTypes.string,
  }),
  autoPing: PropTypes.shape({
    on: PropTypes.bool,
    onToggle: PropTypes.func,
    provider: PropTypes.string,
  }),
};
