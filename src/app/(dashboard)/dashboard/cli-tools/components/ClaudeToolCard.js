"use client";
// @ts-check

import { useState, useEffect, useRef } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal, Tooltip } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";
import {
  beginClaudeToolOperation,
  buildClaudeSettingsMutation,
  finishClaudeToolOperation,
  isClaudeToolOperationCurrent,
  readClaudeModelMappings,
} from "./claudeSettingsForm";
import { reportClientError } from "@/shared/utils/clientFeedback";
import {
  buildClaudeFullCatalogProfile,
  CLAUDE_ROUTING_MODES,
  encodeClaudeCatalogModelId,
  readSwitchboardKeyFromCustomHeaders,
} from "@/shared/claudeGateway.js";
import {
  assignClaudeCatalogDisplayRows,
  buildClaudeCatalogPickerLabelsPayload,
} from "@/shared/claudeCatalogDisplay.js";

const CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_URL;

/**
 * @param {Record<string, string>} left
 * @param {Record<string, string>} right
 */
const aliasMapsEqual = (left, right) => {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right[key] === value);
};

export default function ClaudeToolCard({
  tool,
  isExpanded,
  onToggle,
  activeProviders,
  modelMappings,
  onModelMappingChange,
  baseUrl,
  hasActiveProviders,
  apiKeys,
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [claudeStatus, setClaudeStatus] = useState(initialStatus || null);
  const [fullCatalogProfile, setFullCatalogProfile] = useState(null);
  const [checkingClaude, setCheckingClaude] = useState(false);
  const [operation, setOperation] = useState("idle");
  const [message, setMessage] = useState(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [currentEditingAlias, setCurrentEditingAlias] = useState(null);
  const [showFullCatalogModelSelect, setShowFullCatalogModelSelect] = useState(false);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [modelAliases, setModelAliases] = useState({});
  const [fullCatalogModels, setFullCatalogModels] = useState(
    /** @type {Array<{id: string, value: string, label: string, labelCustom: boolean}>} */ ([]),
  );
  const [pickerNamingModel, setPickerNamingModel] = useState("");
  const [generatingLabelRowId, setGeneratingLabelRowId] = useState(null);
  const [routingMode, setRoutingMode] = useState(
    initialStatus?.routingMode === CLAUDE_ROUTING_MODES.PROXY
      ? CLAUDE_ROUTING_MODES.FULL_CATALOG
      : CLAUDE_ROUTING_MODES.PASS_THROUGH,
  );
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [ccFilterNaming, setCcFilterNaming] = useState(false);
  const hasInitializedModels = useRef(false);
  const hasInitializedFullCatalogModels = useRef(false);
  const fullCatalogRowIdRef = useRef(0);
  const mountedRef = useRef(true);
  const statusRequestGenerationRef = useRef(0);
  const fullCatalogRequestGenerationRef = useRef(0);
  const aliasRequestGenerationRef = useRef(0);
  const operationRef = useRef({ kind: "idle", generation: 0 });

  const getConfigStatus = () => {
    if (!claudeStatus?.installed) return null;
    const currentUrl = claudeStatus.settings?.env?.ANTHROPIC_BASE_URL;
    if (!currentUrl) return "not_configured";
    if (matchKnownEndpoint(currentUrl, { tunnelPublicUrl, tailscaleUrl, cloudUrl: cloudEnabled ? CLOUD_URL : null })) return "configured";
    return "other";
  };

  const configStatus = getConfigStatus();

  /** @param {{kind: "idle"|"apply"|"disconnect", generation: number}} token */
  const isCurrentOperation = (token) => (
    mountedRef.current
    && isClaudeToolOperationCurrent(operationRef, token)
  );

  /** @param {{kind: "idle"|"apply"|"disconnect", generation: number}} token */
  const finishOperation = (token) => {
    if (!mountedRef.current || !finishClaudeToolOperation(operationRef, token)) return;
    setOperation("idle");
  };

  const createFullCatalogModelRows = (entries) => {
    const assigned = assignClaudeCatalogDisplayRows(entries);
    return assigned.map((entry) => ({
      id: `claude-catalog-${fullCatalogRowIdRef.current += 1}`,
      value: entry.value,
      label: entry.label,
      labelCustom: entry.labelCustom,
    }));
  };

  const refreshFullCatalogLabels = (rows) => {
    const assigned = assignClaudeCatalogDisplayRows(rows);
    return rows.map((row, index) => ({
      ...row,
      label: assigned[index]?.label || row.label,
      labelCustom: row.labelCustom || assigned[index]?.labelCustom || false,
    }));
  };

  const buildPickerLabelsPayload = () => buildClaudeCatalogPickerLabelsPayload(fullCatalogModels);

  const buildExistingPickerLabels = (excludeValue = "") => Object.fromEntries(
    fullCatalogModels
      .filter((model) => model.value && model.value !== excludeValue && model.label?.trim())
      .map((model) => [model.value, model.label.trim()]),
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statusRequestGenerationRef.current += 1;
      fullCatalogRequestGenerationRef.current += 1;
      aliasRequestGenerationRef.current += 1;
      operationRef.current = {
        kind: "idle",
        generation: operationRef.current.generation + 1,
      };
    };
  }, []);

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) {
      statusRequestGenerationRef.current += 1;
      setCheckingClaude(false);
      setClaudeStatus(initialStatus);
    }
  }, [initialStatus]);

  useEffect(() => {
    if (isExpanded && !claudeStatus) {
      const controller = new AbortController();
      checkClaudeStatus({ signal: controller.signal }).catch(() => {});
      return () => controller.abort();
    }
  }, [isExpanded, claudeStatus]);

  useEffect(() => {
    if (isExpanded) {
      const controller = new AbortController();
      Promise.all([
        fetchModelAliases({ signal: controller.signal }),
        checkFullCatalogProfile({ signal: controller.signal }),
      ]).catch(() => {});
      return () => controller.abort();
    }
  // Request helpers use generation refs; changing helper identity must not
  // refetch and overwrite an in-progress catalog edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        if (mountedRef.current) setCcFilterNaming(!!data.ccFilterNaming);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const handleCcFilterNamingToggle = async (e) => {
    const value = e.target.checked;
    setCcFilterNaming(value);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ccFilterNaming: value }),
    }).catch(() => {});
  };

  /**
   * @param {{signal?: AbortSignal, canCommit?: () => boolean}} [options]
   */
  const fetchModelAliases = async ({
    signal,
    canCommit = () => true,
  } = {}) => {
    const generation = aliasRequestGenerationRef.current + 1;
    aliasRequestGenerationRef.current = generation;
    const mayCommit = () => (
      mountedRef.current
      && aliasRequestGenerationRef.current === generation
      && canCommit()
    );
    try {
      const res = await fetch("/api/models/alias", { signal });
      const data = await res.json();
      if (res.ok && mayCommit()) {
        const aliases = data.aliases || {};
        setModelAliases((current) => aliasMapsEqual(current, aliases) ? current : aliases);
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        reportClientError("Error fetching model aliases:", error);
      }
    }
  };

  /** @param {{signal?: AbortSignal, canCommit?: () => boolean}} [options] */
  const checkFullCatalogProfile = async ({ signal, canCommit = () => true } = {}) => {
    const generation = fullCatalogRequestGenerationRef.current + 1;
    fullCatalogRequestGenerationRef.current = generation;
    const mayCommit = () => (
      mountedRef.current
      && fullCatalogRequestGenerationRef.current === generation
      && canCommit()
    );
    try {
      const res = await fetch("/api/cli-tools/claude-full-catalog", { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to read full-catalog profile");
      if (mayCommit()) {
        setFullCatalogProfile(data);
        if (!hasInitializedFullCatalogModels.current) {
          hasInitializedFullCatalogModels.current = true;
          const pickerLabels = data.pickerLabels && typeof data.pickerLabels === "object"
            ? data.pickerLabels
            : {};
          setFullCatalogModels(createFullCatalogModelRows(
            (Array.isArray(data.models) ? data.models : []).map((value) => ({
              value,
              label: pickerLabels[value] || "",
              labelCustom: Boolean(pickerLabels[value]),
            })),
          ));
        }
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") return null;
      throw error;
    }
  };

  useEffect(() => {
    if (claudeStatus?.installed && !hasInitializedModels.current) {
      hasInitializedModels.current = true;
      const env = claudeStatus.settings?.env || {};
      setRoutingMode(claudeStatus.routingMode === CLAUDE_ROUTING_MODES.PROXY
        ? CLAUDE_ROUTING_MODES.FULL_CATALOG
        : CLAUDE_ROUTING_MODES.PASS_THROUGH);
      const mappings = readClaudeModelMappings(tool.defaultModels, claudeStatus.settings);
      Object.entries(mappings).forEach(([alias, value]) => onModelMappingChange(alias, value));
      // Only set selectedApiKey if it exists in apiKeys list
      const tokenFromFile = env.ANTHROPIC_AUTH_TOKEN
        || readSwitchboardKeyFromCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS);
      if (tokenFromFile && apiKeys?.some(k => k.key === tokenFromFile)) {
        setSelectedApiKey(tokenFromFile);
      }
    }
  }, [claudeStatus, apiKeys, tool.defaultModels, onModelMappingChange]);

  /**
   * @param {{signal?: AbortSignal, canCommit?: () => boolean}} [options]
   */
  const checkClaudeStatus = async ({ signal, canCommit = () => true } = {}) => {
    const generation = statusRequestGenerationRef.current + 1;
    statusRequestGenerationRef.current = generation;
    const mayCommit = () => (
      mountedRef.current
      && statusRequestGenerationRef.current === generation
      && canCommit()
    );
    if (mayCommit()) setCheckingClaude(true);
    try {
      const res = await fetch("/api/cli-tools/claude-settings", { signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to read Claude Code settings");
      if (mayCommit()) setClaudeStatus(data);
      return data;
    } catch (error) {
      if (error?.name === "AbortError") return null;
      if (mayCommit()) setClaudeStatus({ installed: false, error: error.message });
      throw error;
    } finally {
      if (mayCommit()) setCheckingClaude(false);
    }
  };

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || baseUrl;
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const getDisplayUrl = () => {
    const url = customBaseUrl || baseUrl;
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const handleApplySettings = async () => {
    const operationToken = beginClaudeToolOperation(operationRef, "apply");
    if (!operationToken) return;
    setOperation("apply");
    setMessage(null);
    try {
      // Get key from dropdown, fallback to first key or sk_switchboard for localhost
      const keyToUse = selectedApiKey?.trim()
        || (apiKeys?.length > 0 ? apiKeys[0].key : null)
        || (!cloudEnabled ? "sk_switchboard" : null);

      if (!keyToUse) {
        throw new Error("Select a Switchboard API key for this endpoint.");
      }
      const isFullCatalog = routingMode === CLAUDE_ROUTING_MODES.FULL_CATALOG;
      const endpoint = isFullCatalog
        ? "/api/cli-tools/claude-full-catalog"
        : "/api/cli-tools/claude-settings";
      if (isFullCatalog) fullCatalogRequestGenerationRef.current += 1;
      const body = isFullCatalog
        ? {
            baseUrl: getEffectiveBaseUrl(),
            gatewayKey: keyToUse,
            models: fullCatalogModels.map((model) => model.value),
            pickerLabels: buildPickerLabelsPayload(),
          }
        : buildClaudeSettingsMutation({
            baseUrl: getEffectiveBaseUrl(),
            gatewayKey: keyToUse,
            models: tool.defaultModels,
            modelMappings,
          });
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!isCurrentOperation(operationToken)) return;
      if (res.ok) {
        const canCommit = () => isCurrentOperation(operationToken);
        if (isFullCatalog) {
          setFullCatalogProfile(data);
          const pickerLabels = data.pickerLabels && typeof data.pickerLabels === "object"
            ? data.pickerLabels
            : buildPickerLabelsPayload();
          setFullCatalogModels(createFullCatalogModelRows(
            (Array.isArray(data.models) ? data.models : fullCatalogModels.map((model) => model.value))
              .map((value) => ({
                value,
                label: pickerLabels[value] || "",
                labelCustom: Boolean(pickerLabels[value]),
              })),
          ));
        }
        else await checkClaudeStatus({ canCommit });
        if (isCurrentOperation(operationToken)) {
          setMessage({ type: "success", text: data.message || "Claude Code connected to Switchboard." });
        }
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      if (isCurrentOperation(operationToken)) {
        setMessage({ type: "error", text: error.message });
      }
    } finally {
      finishOperation(operationToken);
    }
  };

  const handleDisconnect = async () => {
    const operationToken = beginClaudeToolOperation(operationRef, "disconnect");
    if (!operationToken) return;
    setOperation("disconnect");
    setMessage(null);
    try {
      const isFullCatalog = routingMode === CLAUDE_ROUTING_MODES.FULL_CATALOG;
      if (isFullCatalog) fullCatalogRequestGenerationRef.current += 1;
      const res = await fetch(
        isFullCatalog
          ? "/api/cli-tools/claude-full-catalog"
          : "/api/cli-tools/claude-settings",
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!isCurrentOperation(operationToken)) return;
      if (res.ok) {
        if (isFullCatalog) {
          setFullCatalogProfile(data);
          setFullCatalogModels([]);
          hasInitializedFullCatalogModels.current = true;
          setMessage({ type: "success", text: data.message || "Full catalog profile removed." });
          return;
        }
        const status = await checkClaudeStatus({
          canCommit: () => isCurrentOperation(operationToken),
        });
        if (!status || !isCurrentOperation(operationToken)) return;
        const restoredEnv = status.settings?.env || {};
        const restoredMappings = readClaudeModelMappings(tool.defaultModels, status.settings);
        Object.entries(restoredMappings).forEach(([alias, value]) => onModelMappingChange(alias, value));
        const restoredToken = restoredEnv.ANTHROPIC_AUTH_TOKEN;
        setSelectedApiKey(
          restoredToken && apiKeys?.some((key) => key.key === restoredToken)
            ? restoredToken
            : "",
        );
        setMessage({
          type: data.restored ? "success" : "warning",
          text: data.message || "Claude Code disconnected from Switchboard.",
        });
      } else {
        setMessage({ type: "error", text: data.error || "Failed to disconnect Claude Code" });
      }
    } catch (error) {
      if (isCurrentOperation(operationToken)) {
        setMessage({ type: "error", text: error.message });
      }
    } finally {
      finishOperation(operationToken);
    }
  };

  const openModelSelector = (alias) => {
    setCurrentEditingAlias(alias);
  };

  const handleModelSelect = (model) => {
    if (currentEditingAlias) onModelMappingChange(currentEditingAlias, model.value);
  };

  const handleFullCatalogModelSelect = (model) => {
    const value = String(model?.value || model?.name || model || "").trim();
    if (!value) return;
    setFullCatalogModels((current) => {
      if (current.some((entry) => entry.value === value)) return current;
      const next = [
        ...current,
        {
          id: `claude-catalog-${fullCatalogRowIdRef.current += 1}`,
          value,
          label: "",
          labelCustom: false,
        },
      ];
      return refreshFullCatalogLabels(next);
    });
  };

  const handleFullCatalogModelDeselect = (model) => {
    const value = String(model?.value || model?.name || model || "").trim();
    setFullCatalogModels((current) => current.filter((entry) => entry.value !== value));
  };

  const handlePickerLabelChange = (rowId, label) => {
    setFullCatalogModels((current) => current.map((entry) => (
      entry.id === rowId ? { ...entry, label, labelCustom: true } : entry
    )));
  };

  const handleGeneratePickerLabel = async (rowId) => {
    const row = fullCatalogModels.find((entry) => entry.id === rowId);
    if (!row?.value || generatingLabelRowId) return;

    setGeneratingLabelRowId(rowId);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/claude-picker-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelIds: [row.value],
          namingModel: pickerNamingModel.trim() || undefined,
          existingLabels: buildExistingPickerLabels(row.value),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate picker label");
      const nextLabel = data.labels?.[row.value];
      if (!nextLabel) throw new Error("Label model returned no suggestion");
      handlePickerLabelChange(rowId, nextLabel);
      setMessage({
        type: "success",
        text: data.source === "ai"
          ? "AI picker label generated."
          : "Picker label generated from heuristics. Set a labeling model for AI suggestions.",
      });
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to generate picker label",
      });
    } finally {
      setGeneratingLabelRowId(null);
    }
  };

  // Generate settings.json content for manual copy
  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_switchboard" : "<API_KEY_FROM_DASHBOARD>");
    const isFullCatalog = routingMode === CLAUDE_ROUTING_MODES.FULL_CATALOG;
    const settings = isFullCatalog
      ? buildClaudeFullCatalogProfile({
          baseUrl: getEffectiveBaseUrl(),
          gatewayKey: keyToUse,
          models: fullCatalogModels.map((model) => model.value),
          pickerLabels: buildPickerLabelsPayload(),
        })
      : {
          hasCompletedOnboarding: true,
          ...buildClaudeSettingsMutation({
            baseUrl: getEffectiveBaseUrl(),
            gatewayKey: keyToUse,
            models: tool.defaultModels,
            modelMappings,
          }),
        };
    const manualSettings = settings.env && settings.removeEnvKeys
      ? { hasCompletedOnboarding: true, env: settings.env }
      : settings;

    return [
      {
        filename: isFullCatalog
          ? (fullCatalogProfile?.settingsPath || "~/.switchboard/claude-code/full-catalog-settings.json")
          : "~/.claude/settings.json",
        content: JSON.stringify(manualSettings, null, 2),
      },
    ];
  };

  const controlsLocked = operation !== "idle" || generatingLabelRowId !== null;
  const isFullCatalog = routingMode === CLAUDE_ROUTING_MODES.FULL_CATALOG;
  const fullCatalogModelValues = fullCatalogModels.map((model) => model.value);
  const nonEmptyFullCatalogModels = fullCatalogModelValues.filter((model) => model.trim());
  const firstFullCatalogModel = nonEmptyFullCatalogModels[0] || null;
  const hybridConfigured = configStatus === "configured"
    && claudeStatus?.routingMode === CLAUDE_ROUTING_MODES.PASS_THROUGH;

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src="/providers/claude.png" alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {hybridConfigured && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Subscription hybrid ready</span>}
              {fullCatalogProfile?.configured && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Full catalog ready</span>}
              {!hybridConfigured && !fullCatalogProfile?.configured && configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checkingClaude && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Claude CLI...</span>
            </div>
          )}

          {!checkingClaude && claudeStatus && !claudeStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-yellow-500">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-yellow-600 dark:text-yellow-400">Claude CLI not detected locally</p>
                    <p className="text-sm text-text-muted">Manual configuration is still available if switchboard is deployed on a remote server.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowInstallGuide(!showInstallGuide)}>
                    <span className="material-symbols-outlined text-[18px] mr-1">{showInstallGuide ? "expand_less" : "help"}</span>
                    {showInstallGuide ? "Hide" : "How to Install"}
                  </Button>
                </div>
              </div>
              {showInstallGuide && (
                <div className="p-4 bg-surface border border-border rounded-lg">
                  <h4 className="font-medium mb-3">Installation Guide</h4>
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-text-muted mb-1">macOS / Linux / Windows:</p>
                      <code className="block px-3 py-2 bg-black/5 dark:bg-white/5 rounded font-mono text-xs">npm install -g @anthropic-ai/claude-code</code>
                    </div>
                    <p className="text-text-muted">After installation, run <code className="px-1 bg-black/5 dark:bg-white/5 rounded">claude</code> to verify.</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {!checkingClaude && claudeStatus?.installed && (
            <>
              <fieldset disabled={controlsLocked} className="rounded-lg border border-border bg-surface/30 p-3 disabled:opacity-70">
                <legend className="px-1 text-sm font-semibold text-text-main">Claude workflows</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${routingMode === CLAUDE_ROUTING_MODES.PASS_THROUGH ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}>
                    <input
                      type="radio"
                      name="claude-routing-mode"
                      value={CLAUDE_ROUTING_MODES.PASS_THROUGH}
                      checked={routingMode === CLAUDE_ROUTING_MODES.PASS_THROUGH}
                      onChange={() => setRoutingMode(CLAUDE_ROUTING_MODES.PASS_THROUGH)}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-main">
                        Subscription hybrid
                        <span className="rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-green-600 dark:text-green-400">Recommended</span>
                        {hybridConfigured && <span className="rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-green-600 dark:text-green-400">Configured</span>}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-text-muted">Keep Claude subscription OAuth and optionally replace the visible Opus, Sonnet, Fable, or Haiku slots with Switchboard models.</span>
                    </span>
                  </label>
                  <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${isFullCatalog ? "border-blue-500/70 bg-blue-500/5" : "border-border hover:border-blue-500/50"}`}>
                    <input
                      type="radio"
                      name="claude-routing-mode"
                      value={CLAUDE_ROUTING_MODES.FULL_CATALOG}
                      checked={isFullCatalog}
                      onChange={() => setRoutingMode(CLAUDE_ROUTING_MODES.FULL_CATALOG)}
                      className="mt-0.5 size-4 accent-blue-500"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-main">
                        Curated Switchboard catalog
                        <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">{nonEmptyFullCatalogModels.length} selected</span>
                        {fullCatalogProfile?.configured && <span className="rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-green-600 dark:text-green-400">Configured</span>}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-text-muted">Choose which Switchboard models and combos appear in the separate launcher&apos;s <code>/model</code> picker. Uses provider credentials stored in Switchboard, not the Claude subscription.</span>
                    </span>
                  </label>
                </div>
              </fieldset>

              <fieldset disabled={controlsLocked} className="flex flex-col gap-2 disabled:opacity-70">
                {/* Endpoint (selector) */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getDisplayUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                  />
                </div>

                {/* Current configured */}
                {(isFullCatalog ? fullCatalogProfile?.baseUrl : claudeStatus?.settings?.env?.ANTHROPIC_BASE_URL) && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {isFullCatalog ? fullCatalogProfile.baseUrl : claudeStatus.settings.env.ANTHROPIC_BASE_URL}
                    </span>
                  </div>
                )}

                {/* API Key */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Switchboard key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                {!isFullCatalog && (
                  <>
                    <div className="pt-2">
                      <h4 className="text-sm font-semibold text-text-main">Visible routing slots</h4>
                      <p className="mt-1 text-xs leading-relaxed text-text-muted">Leave a slot empty to keep its native Claude subscription model. Map a slot to make that Switchboard model available through Claude Code&apos;s normal <code>/model</code> picker and agent model aliases.</p>
                    </div>

                    {tool.defaultModels.map((model) => (
                      <div key={model.alias} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                        <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">{model.name}</span>
                        <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                        <div className="relative w-full min-w-0">
                          <input disabled={controlsLocked} aria-label={`${model.name} model override`} type="text" value={modelMappings[model.alias] || ""} onChange={(e) => onModelMappingChange(model.alias, e.target.value)} placeholder="Native Claude (no override)" className="w-full min-w-0 pl-2 pr-7 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-60 sm:py-1.5" />
                          {modelMappings[model.alias] && <button disabled={controlsLocked} type="button" onClick={() => onModelMappingChange(model.alias, "")} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-red-500 rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50" title="Clear"><span className="material-symbols-outlined text-[14px]">close</span></button>}
                        </div>
                        <button type="button" onClick={() => openModelSelector(model.alias)} disabled={controlsLocked || !hasActiveProviders} className={`w-full sm:w-auto rounded border px-2 py-2 text-xs transition-colors sm:py-1.5 whitespace-nowrap sm:shrink-0 ${!controlsLocked && hasActiveProviders ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}>Select Model</button>
                      </div>
                    ))}
                  </>
                )}

                {isFullCatalog ? (
                  <div className="mt-2 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
                    <div className="flex items-start gap-3">
                      <span className="material-symbols-outlined text-blue-500">account_tree</span>
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm font-semibold text-text-main">Selected models and combos</h4>
                        <p className="mt-1 text-xs leading-relaxed text-text-muted">Only the entries selected here are published to Claude Code. Each row gets an auto label; use the AI button for a smarter short name, or edit the label directly.</p>

                        <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center">
                          <span className="text-xs font-semibold text-text-main sm:text-right">Labeling model</span>
                          <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                          <input
                            disabled={controlsLocked}
                            type="text"
                            value={pickerNamingModel}
                            onChange={(event) => setPickerNamingModel(event.target.value)}
                            placeholder="Cheap model for AI labels (optional)"
                            className="w-full min-w-0 rounded border border-border bg-surface px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-60 sm:py-1.5"
                          />
                        </div>

                        {fullCatalogModels.length === 0 ? (
                          <div className="mt-3 rounded-lg border border-dashed border-border bg-surface/50 px-3 py-4 text-center">
                            <span className="material-symbols-outlined text-xl text-text-muted">playlist_add</span>
                            <p className="mt-1 text-xs text-text-muted">No models or combos selected</p>
                          </div>
                        ) : (
                          <div className="mt-3 flex max-h-56 flex-col gap-1.5 overflow-y-auto">
                            {fullCatalogModels.map((model, index) => (
                              <div key={model.id} className="flex min-w-0 items-center gap-2 rounded border border-border bg-surface px-2 py-1.5">
                                <span className="material-symbols-outlined shrink-0 text-[15px] text-blue-500">smart_toy</span>
                                <div className="min-w-0 flex-1">
                                  <input
                                    disabled={controlsLocked}
                                    type="text"
                                    value={model.label}
                                    onChange={(event) => handlePickerLabelChange(model.id, event.target.value)}
                                    aria-label={`Picker label for ${model.value}`}
                                    className="w-full min-w-0 rounded border border-border bg-background px-2 py-1 text-xs font-medium text-text-main focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
                                  />
                                  <code className="mt-1 block truncate text-[10px] text-text-muted" title={model.value}>
                                    {model.value}
                                  </code>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleGeneratePickerLabel(model.id)}
                                  disabled={controlsLocked}
                                  className="rounded p-1 text-text-muted transition-colors hover:bg-blue-500/10 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                                  title="Generate picker label with AI"
                                  aria-label={`Generate AI picker label for ${model.value}`}
                                >
                                  <span className={`material-symbols-outlined text-[15px] ${generatingLabelRowId === model.id ? "animate-spin" : ""}`}>
                                    {generatingLabelRowId === model.id ? "progress_activity" : "auto_awesome"}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setFullCatalogModels((current) => current.filter((_, entryIndex) => entryIndex !== index))}
                                  className="rounded p-1 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
                                  aria-label={`Remove ${model.value || `selection ${index + 1}`}`}
                                >
                                  <span className="material-symbols-outlined text-[15px]">delete</span>
                                </button>
                              </div>
                            ))}
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={() => setShowFullCatalogModelSelect(true)}
                          className="mt-2 flex min-h-10 w-full items-center justify-center gap-1 rounded-lg border border-dashed border-blue-500/40 px-3 text-xs font-medium text-blue-600 transition-colors hover:border-blue-500 hover:bg-blue-500/10 dark:text-blue-400"
                        >
                          <span className="material-symbols-outlined text-[16px]">add</span>
                          Add models or combos
                        </button>

                        <div className="mt-3 rounded border border-border bg-surface px-3 py-2">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Launch command</p>
                          <code className="mt-1 block break-all text-xs text-text-main">claude-switchboard</code>
                        </div>
                        {firstFullCatalogModel && (
                          <div className="mt-2 rounded border border-border bg-surface px-3 py-2">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Fast model switch</p>
                            <code className="mt-1 block break-all text-xs text-text-main">/model {encodeClaudeCatalogModelId(firstFullCatalogModel)}</code>
                            <p className="mt-1 text-[11px] leading-relaxed text-text-muted">The same discovered ID works with <code>--model</code> and agent frontmatter.</p>
                          </div>
                        )}
                        {fullCatalogProfile?.settingsPath && (
                          <p className="mt-2 break-all text-[11px] text-text-muted">Direct fallback: <code>claude --settings &quot;{fullCatalogProfile.settingsPath}&quot;</code></p>
                        )}
                        <p className="mt-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">Claude subscription OAuth is not used in this launcher. Claude models require an Anthropic-compatible provider credential configured in Switchboard.</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 rounded-lg border border-border bg-surface/30 p-3 text-xs leading-relaxed text-text-muted">
                    Agent example: if the Haiku slot maps to GPT, a custom agent with <code>model: haiku</code> uses GPT while unmapped slots continue using the Claude subscription.
                  </div>
                )}

                {/* CC Filter Naming */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Filter naming</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={ccFilterNaming} onChange={handleCcFilterNamingToggle} className="w-3.5 h-3.5 accent-primary cursor-pointer" />
                    <span className="text-xs text-text-muted">Filter naming requests</span>
                    <Tooltip text="Intercepts Claude Code's topic-naming requests and returns a fake response locally, saving API tokens.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </label>
                </div>
              </fieldset>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : message.type === "warning" ? "bg-amber-500/10 text-amber-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : message.type === "warning" ? "warning" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" onClick={handleApplySettings} disabled={controlsLocked || (isFullCatalog && (!hasActiveProviders || nonEmptyFullCatalogModels.length === 0))} loading={operation === "apply"}>
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>{isFullCatalog ? "Save full catalog" : "Save subscription hybrid"}
                </Button>
                <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={controlsLocked || (isFullCatalog ? !fullCatalogProfile?.configured : !claudeStatus?.hasSwitchboard)} loading={operation === "disconnect"} title={isFullCatalog ? "Remove the separate full-catalog launch profile" : (claudeStatus?.hasBackup ? "Restore the pre-Switchboard Claude Code settings" : "Remove Switchboard settings from Claude Code")}>
                  <span className="material-symbols-outlined text-[14px] mr-1">link_off</span>{isFullCatalog ? "Remove full catalog" : "Disconnect hybrid"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)}>
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <ModelSelectModal isOpen={currentEditingAlias !== null} onClose={() => setCurrentEditingAlias(null)} onSelect={handleModelSelect} selectedModel={currentEditingAlias ? modelMappings[currentEditingAlias] : null} activeProviders={activeProviders} modelAliases={modelAliases} title={currentEditingAlias ? `Select model for ${currentEditingAlias}` : "Select model"} />

      <ModelSelectModal
        isOpen={showFullCatalogModelSelect}
        onClose={() => setShowFullCatalogModelSelect(false)}
        onSelect={handleFullCatalogModelSelect}
        onDeselect={handleFullCatalogModelDeselect}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title="Choose Claude catalog models"
        addedModelValues={fullCatalogModelValues}
        closeOnSelect={false}
        selectionHint="Select the provider models and combos that should appear in Claude Code. Click a selected entry again to remove it."
      />

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Claude CLI - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
