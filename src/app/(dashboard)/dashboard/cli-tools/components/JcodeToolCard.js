"use client";
// @ts-check

import { useState, useEffect, useRef } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";
import ModelCatalogInput from "./ModelCatalogInput";
import { reportClientError } from "@/shared/utils/clientFeedback";

export default function JcodeToolCard({
  tool,
  isExpanded,
  onToggle,
  baseUrl,
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
  const [jcodeStatus, setJcodeStatus] = useState(initialStatus || null);
  const [checkingJcode, setCheckingJcode] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedModels, setSelectedModels] = useState([]);
  const [modelDraft, setModelDraft] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const hasInitializedModel = useRef(false);

  const getConfigStatus = () => {
    if (!jcodeStatus?.installed) return null;
    if (!jcodeStatus?.hasSwitchboard) return "not_configured";
    const currentProvider = jcodeStatus.config?.providers?.["switchboard"];
    if (!currentProvider) return "not_configured";
    return matchKnownEndpoint(currentProvider.base_url, { tunnelPublicUrl, tailscaleUrl }) ? "configured" : "other";
  };

  const configStatus = getConfigStatus();

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) setJcodeStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (isExpanded && !jcodeStatus) {
      checkJcodeStatus();
      fetchModelAliases();
    }
    if (isExpanded) fetchModelAliases();
  }, [isExpanded, jcodeStatus]);

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
    if (jcodeStatus?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
      const provider = jcodeStatus.config?.providers?.["switchboard"];
      if (provider) {
        const models = Array.isArray(provider.models)
          ? provider.models.map((entry) => entry?.id).filter(Boolean)
          : [];
        const configuredModels = models.length ? models : (provider.default_model ? [provider.default_model] : []);
        setSelectedModels([...new Set(configuredModels)]);
        if (provider.default_model) {
          setSelectedModel(provider.default_model);
        }
        // Try to match API key from env file
        const envApiKey = jcodeStatus.envApiKey;
        if (envApiKey && apiKeys?.some(k => k.key === envApiKey)) {
          setSelectedApiKey(envApiKey);
        }
      }
    }
  }, [jcodeStatus, apiKeys]);

  const checkJcodeStatus = async () => {
    setCheckingJcode(true);
    try {
      const res = await fetch("/api/cli-tools/jcode-settings");
      const data = await res.json();
      setJcodeStatus(data);
    } catch (error) {
      setJcodeStatus({ installed: false, error: error.message });
    } finally {
      setCheckingJcode(false);
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

  const getDisplayUrl = () => {
    const url = customBaseUrl || getLocalBaseUrl();
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const addModel = (value = modelDraft) => {
    const model = value.trim();
    if (!model) return;
    setSelectedModels((current) => current.includes(model) ? current : [...current, model]);
    if (!selectedModel) setSelectedModel(model);
    setModelDraft("");
  };

  const removeModel = (model) => {
    setSelectedModels((current) => {
      const next = current.filter((entry) => entry !== model);
      if (selectedModel === model) setSelectedModel(next[0] || "");
      return next;
    });
  };

  const handleApplySettings = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const keyToUse = selectedApiKey?.trim()
        || (apiKeys?.length > 0 ? apiKeys[0].key : null)
        || (!cloudEnabled ? "sk_switchboard" : null);

      const res = await fetch("/api/cli-tools/jcode-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyToUse,
          models: selectedModels,
          defaultModel: selectedModel || selectedModels[0],
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings applied successfully!" });
        checkJcodeStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleResetSettings = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/jcode-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully!" });
        setSelectedModel("");
        setSelectedModels([]);
        setSelectedApiKey("");
        checkJcodeStatus();
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
    addModel(model.value);
  };

  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_switchboard" : "<API_KEY_FROM_DASHBOARD>");

    const models = selectedModels.length ? selectedModels : ["cc/claude-opus-4-7"];
    const activeModel = selectedModel || models[0];
    const modelBlocks = models.map((model) => `[[providers.switchboard.models]]\nid = "${model}"`).join("\n\n");
    const configToml = `[providers.switchboard]
type = "openai-compatible"
base_url = "${getEffectiveBaseUrl()}"
auth = "bearer"
api_key_env = "JCODE_SWITCHBOARD_API_KEY"
env_file = "provider-switchboard.env"
default_model = "${activeModel}"
model_catalog = true
requires_api_key = true

${modelBlocks}`;

    const envContent = `JCODE_SWITCHBOARD_API_KEY="${keyToUse}"`;

    return [
      {
        filename: "~/.jcode/config.toml",
        content: configToml,
      },
      {
        filename: "~/.config/jcode/provider-switchboard.env",
        content: envContent,
      },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src={tool.image || "/providers/jcode.png"} alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Connected</span>}
              {configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checkingJcode && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking jcode CLI...</span>
            </div>
          )}

          {!checkingJcode && jcodeStatus && !jcodeStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-yellow-500">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-yellow-600 dark:text-yellow-400">jcode CLI not detected locally</p>
                    <p className="text-sm text-text-muted mt-1">Install jcode to enable automatic configuration:</p>
                    <code className="block mt-2 p-2 bg-black/20 rounded text-xs font-mono">
                      curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash
                    </code>
                    <p className="text-sm text-text-muted mt-2">Manual configuration is still available if switchboard is deployed on a remote server.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!checkingJcode && jcodeStatus?.installed && (
            <>
              <div className="flex flex-col gap-2">
                {/* Info notes */}
                {tool.notes && tool.notes.length > 0 && (
                  <div className="flex flex-col gap-2 mb-2">
                    {tool.notes.map((note, idx) => (
                      <div key={idx} className={`flex items-start gap-2 p-2 rounded text-xs ${
                        note.type === "info" ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" :
                        note.type === "warning" ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" :
                        "bg-gray-500/10 text-text-muted"
                      }`}>
                        <span className="material-symbols-outlined text-[14px] mt-0.5">
                          {note.type === "info" ? "info" : note.type === "warning" ? "warning" : "help"}
                        </span>
                        <span>{note.text}</span>
                      </div>
                    ))}
                  </div>
                )}

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
                {jcodeStatus?.config?.providers?.["switchboard"]?.base_url && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {jcodeStatus.config.providers["switchboard"].base_url}
                    </span>
                  </div>
                )}

                {/* API Key */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                <ModelCatalogInput
                  models={selectedModels}
                  draft={modelDraft}
                  onDraftChange={setModelDraft}
                  onAdd={() => addModel()}
                  onRemove={removeModel}
                  onOpenPicker={() => setModalOpen(true)}
                  canOpenPicker={Boolean(hasActiveProviders)}
                  defaultModel={selectedModel}
                  onDefaultChange={setSelectedModel}
                />

                {/* Usage hint */}
                <div className="flex flex-col gap-1 p-3 bg-blue-500/5 border border-blue-500/20 rounded-lg">
                  <p className="text-xs font-medium text-blue-600 dark:text-blue-400">Usage:</p>
                  <code className="text-xs font-mono text-text-muted">jcode --provider-profile switchboard</code>
                  <code className="text-xs font-mono text-text-muted">jcode --provider-profile switchboard --model {selectedModel || "cc/claude-opus-4-7"}</code>
                </div>
              </div>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" onClick={handleApplySettings} disabled={selectedModels.length === 0} loading={applying}>
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleResetSettings} disabled={!jcodeStatus?.hasSwitchboard} loading={restoring}>
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)}>
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>Manual Config
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
        onDeselect={(model) => removeModel(model.value)}
        selectedModel={null}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        addedModelValues={selectedModels}
        closeOnSelect={false}
        title="Add Models for jcode"
      />

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="jcode - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
