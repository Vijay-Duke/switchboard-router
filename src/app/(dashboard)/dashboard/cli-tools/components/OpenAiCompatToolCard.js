"use client";
// @ts-check

/**
 * Shared card for OpenAI-compatible CLI tools (Grok, Pi, Aider, Gemini CLI, …).
 * Expects API shape:
 *   GET  → { installed, hasSwitchboard, settings: { baseUrl, model, apiKeySet? }, configPath?, envPath? }
 *   POST → { baseUrl, apiKey, model }
 *   DELETE → reset
 */
import { useState, useEffect, useRef } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";
import ModelCatalogInput from "./ModelCatalogInput";
import { reportClientError } from "@/shared/utils/clientFeedback";
import { requestPickerLabels } from "./pickerLabelsClient";
import { buildClaudeCatalogDisplayNameMap } from "@/shared/claudeCatalogDisplay.js";

/**
 * @param {object} props
 * @param {object} props.tool
 * @param {string} props.endpoint - e.g. /api/cli-tools/grok-settings
 * @param {string} [props.installHint]
 * @param {string} [props.runHint]
 * @param {(ctx: { baseUrl: string, apiKey: string, model: string, models: string[], defaultModel: string, pickerLabels: Record<string, string> }) => Array<{filename: string, content: string}>} [props.buildManualConfigs]
 * @param {boolean} [props.multipleModels]
 * @param {boolean} [props.hasDefaultModel]
 * @param {boolean} [props.requiresModelScope]
 * @param {boolean} [props.supportsModelLabels]
 * @param {boolean} props.isExpanded
 * @param {Function} props.onToggle
 * @param {boolean} [props.hasActiveProviders]
 * @param {Array} [props.apiKeys]
 * @param {Array} [props.activeProviders]
 * @param {boolean} [props.cloudEnabled]
 * @param {object} [props.initialStatus]
 * @param {boolean} [props.tunnelEnabled]
 * @param {string} [props.tunnelPublicUrl]
 * @param {boolean} [props.tailscaleEnabled]
 * @param {string} [props.tailscaleUrl]
 */
export default function OpenAiCompatToolCard({
  tool,
  endpoint,
  installHint,
  runHint,
  buildManualConfigs,
  multipleModels = false,
  hasDefaultModel = true,
  requiresModelScope = false,
  supportsModelLabels = false,
  isExpanded,
  onToggle,
  hasActiveProviders,
  apiKeys,
  activeProviders,
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [status, setStatus] = useState(initialStatus || null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedModels, setSelectedModels] = useState([]);
  const [pickerLabels, setPickerLabels] = useState({});
  const [pickerLabelOverrides, setPickerLabelOverrides] = useState({});
  const [pickerNamingModel, setPickerNamingModel] = useState("");
  const [generatingPickerLabels, setGeneratingPickerLabels] = useState(false);
  const [modelDraft, setModelDraft] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const hasInitializedModel = useRef(false);

  /**
   * Visual status for header badge:
   *  - not_installed | configured | not_configured | other | checking | null
   */
  const getConfigStatus = () => {
    if (checking && !status) return "checking";
    if (!status) return null;
    if (!status.installed) return "not_installed";
    const base = status.settings?.baseUrl;
    if (!base) return "not_configured";
    const endpointMatches = status.hasSwitchboard
      || matchKnownEndpoint(base, { tunnelPublicUrl, tailscaleUrl });
    const modelScopeMatches = !requiresModelScope || status.settings?.scopeConfigured === true;
    if (endpointMatches && modelScopeMatches) {
      return "configured";
    }
    return "other";
  };

  const configStatus = getConfigStatus();
  const controlsLocked = applying || restoring || generatingPickerLabels;

  /** Notes that are install-only should not appear once the binary is present. */
  const visibleNotes = (tool.notes || []).filter((note) => {
    if (!note) return false;
    if (note.when === "not_installed" || note.type === "install") {
      return status && !status.installed;
    }
    if (note.when === "installed") {
      return status?.installed;
    }
    // Heuristic: legacy "Install: …" warnings only when not installed
    if (
      note.type === "warning" &&
      typeof note.text === "string" &&
      /^\s*install\b/i.test(note.text)
    ) {
      return status && !status.installed;
    }
    // Info/config notes only useful when installed (or always when status unknown)
    if (note.when === "always") return true;
    if (!status) return true;
    if (!status.installed) return false;
    return true;
  });

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (isExpanded && !status) {
      checkStatus();
      fetchModelAliases();
    }
    if (isExpanded) fetchModelAliases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded]);

  const fetchModelAliases = async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      reportClientError("Error fetching model aliases:", error);
    }
  };

  useEffect(() => {
    if (status?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
      const configuredModels = Array.isArray(status.settings?.models)
        ? status.settings.models.filter((model) => typeof model === "string" && model.trim())
        : status.settings?.model
          ? [status.settings.model]
          : [];
      setSelectedModels([...new Set(configuredModels)]);
      if (supportsModelLabels) {
        const savedLabels = status.settings?.pickerLabels;
        const displayNames = buildClaudeCatalogDisplayNameMap(configuredModels);
        setPickerLabels(Object.fromEntries(configuredModels.map((model) => [
          model,
          String(savedLabels?.[model] || displayNames.get(model) || model),
        ])));
        setPickerLabelOverrides({});
      }
      if (status.settings?.defaultModel || status.settings?.model) {
        setSelectedModel(status.settings.defaultModel || status.settings.model);
      } else if (configuredModels[0]) {
        setSelectedModel(configuredModels[0]);
      }
    }
  }, [status, supportsModelLabels]);

  const checkStatus = async () => {
    setChecking(true);
    try {
      const res = await fetch(endpoint);
      const data = await res.json();
      setStatus(data);
    } catch (error) {
      setStatus({ installed: false, error: error.message });
    } finally {
      setChecking(false);
    }
  };

  const normalizeLocalhost = (url) => url.replace("://localhost", "://127.0.0.1");

  const getLocalBaseUrl = () => {
    if (typeof window !== "undefined") {
      return normalizeLocalhost(window.location.origin);
    }
    return "http://127.0.0.1:20128";
  };

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || getLocalBaseUrl();
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const resolveApiKey = () =>
    selectedApiKey?.trim()
    || (apiKeys?.length > 0 ? apiKeys[0].key : null)
    || (!cloudEnabled ? "sk_switchboard" : null);

  const fillPickerLabels = (models, currentLabels) => {
    const displayNames = buildClaudeCatalogDisplayNameMap(models);
    return Object.fromEntries(models.map((model) => [
      model,
      currentLabels[model] !== undefined
        ? String(currentLabels[model])
        : String(displayNames.get(model) || model).slice(0, 48),
    ]));
  };

  const addModel = (value = modelDraft) => {
    if (controlsLocked) return;
    const model = value.trim();
    if (!model) return;
    if (selectedModels.includes(model)) return;
    const next = [...selectedModels, model];
    setSelectedModels(next);
    if (supportsModelLabels) {
      const updated = fillPickerLabels(next, pickerLabels);
      setPickerLabels(updated);
      setPickerLabelOverrides((overrides) => ({
        ...overrides,
        [model]: updated[model],
      }));
    }
    if (hasDefaultModel && !selectedModel) setSelectedModel(model);
    setModelDraft("");
  };

  const removeModel = (model) => {
    if (controlsLocked) return;
    const next = selectedModels.filter((entry) => entry !== model);
    setSelectedModels(next);
    if (supportsModelLabels) {
      setPickerLabels((labels) => fillPickerLabels(next, labels));
      setPickerLabelOverrides((overrides) => Object.fromEntries(
        Object.entries(overrides).filter(([modelId]) => modelId !== model),
      ));
    }
    if (selectedModel === model) setSelectedModel(next[0] || "");
  };

  const handleApply = async () => {
    if (controlsLocked) return;
    setApplying(true);
    setMessage(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: resolveApiKey(),
          model: multipleModels ? (selectedModel || selectedModels[0]) : selectedModel,
          models: multipleModels ? selectedModels : undefined,
          defaultModel: multipleModels && hasDefaultModel ? (selectedModel || selectedModels[0]) : undefined,
          pickerLabels: supportsModelLabels ? pickerLabelOverrides : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || "Settings applied successfully!" });
        if (supportsModelLabels && data.pickerLabels && typeof data.pickerLabels === "object") {
          setPickerLabels(data.pickerLabels);
        }
        setPickerLabelOverrides({});
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    if (controlsLocked) return;
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: data.message || "Settings reset successfully!" });
        setSelectedModel("");
        setSelectedModels([]);
        setPickerLabels({});
        setPickerLabelOverrides({});
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const handleModelSelect = (model) => {
    if (controlsLocked) return;
    if (multipleModels) {
      addModel(model.value);
    } else {
      setSelectedModel(model.value);
      setModalOpen(false);
    }
  };

  const handleGeneratePickerLabels = async () => {
    if (selectedModels.length === 0 || controlsLocked) return;
    setGeneratingPickerLabels(true);
    setMessage(null);
    try {
      const data = await requestPickerLabels({
        modelIds: selectedModels,
        namingModel: pickerNamingModel,
        existingLabels: fillPickerLabels(selectedModels, pickerLabels),
      });
      const labels = data.labels && typeof data.labels === "object" ? data.labels : {};
      setPickerLabels((current) => fillPickerLabels(selectedModels, {
        ...current,
        ...labels,
      }));
      setPickerLabelOverrides((current) => ({
        ...current,
        ...labels,
      }));
      setMessage({
        type: "success",
        text: data.source === "ai"
          ? `Improved ${Object.keys(labels).length} Pi model labels with AI. Click Apply to save.`
          : `Refreshed ${Object.keys(labels).length} Pi model labels. Click Apply to save.`,
      });
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to generate model labels",
      });
    } finally {
      setGeneratingPickerLabels(false);
    }
  };

  const getManualConfigs = () => {
    const keyToUse = resolveApiKey() || "<API_KEY_FROM_DASHBOARD>";
    const base = getEffectiveBaseUrl();
    const models = multipleModels
      ? (selectedModels.length > 0 ? selectedModels : ["provider/model-id"])
      : [selectedModel || "provider/model-id"];
    const model = selectedModel || models[0];
    if (typeof buildManualConfigs === "function") {
      return buildManualConfigs({
        baseUrl: base,
        apiKey: keyToUse,
        model,
        models,
        defaultModel: selectedModel || models[0],
        pickerLabels: fillPickerLabels(models, pickerLabels),
      });
    }
    return [
      {
        filename: "env",
        content: `export OPENAI_API_KEY="${keyToUse}"\nexport OPENAI_BASE_URL="${base}"\nexport OPENAI_MODEL="${model}"\n`,
      },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            {tool.image ? (
              <Image
                src={tool.image}
                alt={tool.name}
                width={32}
                height={32}
                className="size-8 object-contain rounded-lg"
                sizes="32px"
                onError={(e) => { e.target.style.display = "none"; }}
              />
            ) : (
              <span className="material-symbols-outlined text-[28px]" style={{ color: tool.color || "#888" }}>
                {tool.icon || "terminal"}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "checking" && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-gray-500/10 text-gray-500 rounded-full">
                  Checking…
                </span>
              )}
              {configStatus === "not_installed" && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-orange-500/15 text-orange-600 dark:text-orange-400 rounded-full border border-orange-500/25">
                  Not installed
                </span>
              )}
              {configStatus === "configured" && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full border border-green-500/20">
                  Connected
                </span>
              )}
              {configStatus === "not_configured" && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-full border border-amber-500/25">
                  <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                  Installed · not configured
                </span>
              )}
              {configStatus === "other" && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full border border-blue-500/20">
                  <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
                  Installed · other endpoint
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span
          className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}
        >
          expand_more
        </span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checking && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking {tool.name}…</span>
            </div>
          )}

          {!checking && status && !status.installed && (
            <div className="flex flex-col gap-3 p-4 bg-orange-500/10 border border-orange-500/30 rounded-lg">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-orange-500 shrink-0">download</span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-orange-600 dark:text-orange-400">
                    {tool.name} is not installed
                  </p>
                  <p className="text-sm text-text-muted mt-1">
                    Install it on this machine first, then come back to connect Switchboard.
                  </p>
                  {installHint ? (
                    <div className="mt-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-600/80 dark:text-orange-400/80 mb-1.5">
                        Install steps
                      </p>
                      <code className="block p-2.5 bg-black/25 rounded text-xs font-mono whitespace-pre-wrap text-text-main">
                        {installHint}
                      </code>
                    </div>
                  ) : null}
                  {/* Extra notes only (skip install-type when installHint already shown) */}
                  {visibleNotes.filter((n) => !(installHint && (n.type === "install" || n.when === "not_installed"))).length >
                    0 && (
                    <div className="flex flex-col gap-2 mt-3">
                      {visibleNotes
                        .filter((n) => !(installHint && (n.type === "install" || n.when === "not_installed")))
                        .map((note, idx) => (
                          <p key={idx} className="text-xs text-text-muted">
                            {note.text}
                          </p>
                        ))}
                    </div>
                  )}
                  <p className="text-sm text-text-muted mt-3">
                    Already installed on another machine? Copy the config files instead.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 pl-0 sm:pl-9">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowManualConfigModal(true)}
                  className="!bg-orange-500/20 !border-orange-500/40 !text-orange-700 dark:!text-orange-300 hover:!bg-orange-500/30"
                >
                  <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                  Manual Config
                </Button>
                <Button variant="ghost" size="sm" onClick={checkStatus} disabled={checking}>
                  <span className="material-symbols-outlined text-[18px] mr-1">refresh</span>
                  Recheck
                </Button>
              </div>
            </div>
          )}

          {!checking && status?.installed && (
            <>
              <div
                className={`flex items-start gap-2 p-2.5 rounded-lg text-xs border ${
                  configStatus === "configured"
                    ? "bg-green-500/10 border-green-500/25 text-green-700 dark:text-green-400"
                    : "bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                }`}
              >
                <span className="material-symbols-outlined text-[16px] mt-0.5 shrink-0">
                  {configStatus === "configured" ? "check_circle" : "verified"}
                </span>
                <div className="min-w-0">
                  <p className="font-medium">
                    {configStatus === "configured"
                      ? `${tool.name} is installed and connected to Switchboard`
                      : `${tool.name} is installed — configure Switchboard below`}
                  </p>
                  {runHint && configStatus === "configured" ? (
                    <p className="mt-1 font-mono text-[11px] opacity-90">{runHint}</p>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                {visibleNotes.length > 0 && (
                  <div className="flex flex-col gap-2 mb-2">
                    {visibleNotes.map((note, idx) => (
                      <div
                        key={idx}
                        className={`flex items-start gap-2 p-2 rounded text-xs ${
                          note.type === "warning"
                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : note.type === "error"
                              ? "bg-red-500/10 text-red-600 dark:text-red-400"
                              : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        }`}
                      >
                        <span className="material-symbols-outlined text-[14px] mt-0.5">
                          {note.type === "warning" ? "warning" : note.type === "error" ? "error" : "info"}
                        </span>
                        <span>{note.text}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">
                    Select Endpoint
                  </span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">
                    arrow_forward
                  </span>
                  <BaseUrlSelect
                    value={customBaseUrl || getEffectiveBaseUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                  />
                </div>

                {status?.settings?.baseUrl && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">
                      arrow_forward
                    </span>
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {status.settings.baseUrl}
                      {status.settings.models?.length
                        ? ` · ${status.settings.models.length} models`
                        : status.settings.model ? ` · ${status.settings.model}` : ""}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">
                    arrow_forward
                  </span>
                  <ApiKeySelect
                    value={selectedApiKey}
                    onChange={setSelectedApiKey}
                    apiKeys={apiKeys}
                    cloudEnabled={cloudEnabled}
                  />
                </div>

                {multipleModels ? (
                  <>
                    <ModelCatalogInput
                      models={selectedModels}
                      draft={modelDraft}
                      onDraftChange={setModelDraft}
                      onAdd={() => addModel()}
                      onRemove={removeModel}
                      onOpenPicker={() => setModalOpen(true)}
                      canOpenPicker={Boolean(hasActiveProviders) && !controlsLocked}
                      defaultModel={hasDefaultModel ? selectedModel : undefined}
                      onDefaultChange={hasDefaultModel ? setSelectedModel : undefined}
                      label={hasDefaultModel ? "Models" : "Available Models"}
                    />
                    {supportsModelLabels && selectedModels.length > 0 && (
                      <div className="mt-2 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
                        <h4 className="text-sm font-semibold text-text-main">Pi model labels</h4>
                        <p className="mt-1 text-xs leading-relaxed text-text-muted">
                          These names appear in Pi&apos;s <code>/model</code> picker. Edit them directly, or optionally use a model to improve all labels with AI.
                        </p>
                        <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                          <label htmlFor={`${tool.id}-picker-labeling-model`} className="text-xs font-semibold text-text-main sm:text-right">
                            Labeling model
                          </label>
                          <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                          <input
                            id={`${tool.id}-picker-labeling-model`}
                            type="text"
                            disabled={controlsLocked}
                            value={pickerNamingModel}
                            onChange={(event) => setPickerNamingModel(event.target.value)}
                            placeholder="Cheap model for AI labels (optional)"
                            className="w-full min-w-0 rounded border border-border bg-surface px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                          />
                          <button
                            type="button"
                            onClick={handleGeneratePickerLabels}
                            disabled={controlsLocked}
                            className="flex min-h-10 items-center justify-center gap-1 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 text-xs font-medium text-blue-700 transition-colors hover:border-blue-500 hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-300"
                          >
                            <span className={`material-symbols-outlined text-[16px] ${generatingPickerLabels ? "animate-spin" : ""}`}>
                              {generatingPickerLabels ? "progress_activity" : "auto_awesome"}
                            </span>
                            {generatingPickerLabels
                              ? "Generating..."
                              : pickerNamingModel.trim()
                                ? "Improve labels with AI"
                                : "Refresh labels"}
                          </button>
                        </div>
                        <div className="mt-3 flex max-h-56 flex-col gap-1.5 overflow-y-auto">
                          {selectedModels.map((model) => (
                            <div key={model} className="rounded border border-border bg-surface px-2 py-1.5">
                              <input
                                type="text"
                                disabled={controlsLocked}
                                value={pickerLabels[model] || ""}
                                maxLength={48}
                                onChange={(event) => {
                                  const label = event.target.value;
                                  setPickerLabels((current) => ({ ...current, [model]: label }));
                                  setPickerLabelOverrides((current) => ({ ...current, [model]: label }));
                                }}
                                aria-label={`Pi picker label for ${model}`}
                                className="w-full min-w-0 rounded border border-border bg-background px-2 py-1 text-xs font-medium text-text-main focus:outline-none focus:ring-1 focus:ring-primary/50"
                              />
                              <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-text-muted">
                                <code className="min-w-0 flex-1 truncate" title={model}>{model}</code>
                                <span className="shrink-0">{(pickerLabels[model] || "").length}/48</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">
                    Default Model
                  </span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">
                    arrow_forward
                  </span>
                  <div className="relative w-full min-w-0">
                    <input
                      type="text"
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      placeholder="provider/model-id"
                      className="w-full min-w-0 pl-2 pr-7 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                    />
                    {selectedModel && (
                      <button
                        onClick={() => setSelectedModel("")}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-red-500 rounded transition-colors"
                        title="Clear"
                      >
                        <span className="material-symbols-outlined text-[14px]">close</span>
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => setModalOpen(true)}
                    disabled={!hasActiveProviders}
                    className={`w-full sm:w-auto rounded border px-2 py-2 text-xs transition-colors sm:py-1.5 whitespace-nowrap sm:shrink-0 ${
                      hasActiveProviders
                        ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer"
                        : "opacity-50 cursor-not-allowed border-border"
                    }`}
                  >
                    Select
                  </button>
                </div>
                )}

                {runHint && configStatus !== "configured" ? (
                  <p className="text-[11px] text-text-subtle font-mono mt-1">{runHint}</p>
                ) : null}
              </div>

              {message && (
                <div
                  className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
                    message.type === "success"
                      ? "bg-green-500/10 text-green-600"
                      : "bg-red-500/10 text-red-600"
                  }`}
                >
                  <span className="material-symbols-outlined text-[14px]">
                    {message.type === "success" ? "check_circle" : "error"}
                  </span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleApply}
                  disabled={controlsLocked || (multipleModels ? selectedModels.length === 0 : !selectedModel)}
                  loading={applying}
                >
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>
                  Apply
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReset}
                  disabled={controlsLocked || !status?.hasSwitchboard}
                  loading={restoring}
                >
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>
                  Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)}>
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>
                  Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <ModelSelectModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelect={handleModelSelect}
        onDeselect={multipleModels ? (model) => removeModel(model.value) : undefined}
        selectedModel={multipleModels ? null : selectedModel}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        addedModelValues={multipleModels ? selectedModels : []}
        closeOnSelect={!multipleModels}
        selectionHint={multipleModels
          ? "Select any number of models. Close this picker when finished, then click Apply to save."
          : undefined}
        title={`${multipleModels ? "Add Models" : "Select Model"} for ${tool.name}`}
      />

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title={`${tool.name} — Manual Configuration`}
        configs={getManualConfigs()}
      />
    </Card>
  );
}
