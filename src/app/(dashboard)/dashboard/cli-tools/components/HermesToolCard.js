"use client";
// @ts-check

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import { cardHeaderToggleProps } from "./cardHeaderToggle";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";
import ModelCatalogInput from "./ModelCatalogInput";
import { reportClientError } from "@/shared/utils/clientFeedback";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { stringify as stringifyYaml } from "yaml";

const ENDPOINT = "/api/cli-tools/hermes-settings";

export default function HermesToolCard({
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
  const [profiles, setProfiles] = useState([]);
  const [activeProfile, setActiveProfile] = useState("default");
  const [roleModels, setRoleModels] = useState({});
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [sttModel, setSttModel] = useState("");
  const [modalTarget, setModalTarget] = useState("catalog");
  const statusSequence = useRef(0);
  const [hermesStatus, setHermesStatus] = useState(initialStatus || null);
  const [checking, setChecking] = useState(false);
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
    if (!hermesStatus?.installed) return null;
    const cfg = hermesStatus.settings?.model;
    if (!cfg?.base_url) return "not_configured";
    if (matchKnownEndpoint(cfg.base_url, { tunnelPublicUrl, tailscaleUrl })) return "configured";
    return "other";
  };

  const configStatus = getConfigStatus();

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch("/api/cli-tools/hermes-profiles");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to list profiles");
      setProfiles(data.profiles || []);
    } catch (error) {
      reportClientError("Error fetching Hermes profiles:", error);
    }
  }, []);

  const fetchModelAliases = useCallback(async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      reportClientError("Error fetching model aliases:", error);
    }
  }, []);

  useEffect(() => {
    if (hermesStatus?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
      const cfg = hermesStatus.settings?.model;
      const models = Array.isArray(hermesStatus.settings?.models) ? hermesStatus.settings.models : [];
      setSelectedModels(models.length ? models : (cfg?.default ? [cfg.default] : []));
      setSelectedModel(cfg?.default || "");
      setRoleModels(Object.fromEntries((CLI_TOOLS.hermes.roles || []).map(({ id }) => {
        const cfg = id === "delegation" ? hermesStatus.settings?.delegation : hermesStatus.settings?.auxiliary?.[id];
        return [id, cfg?.provider === "custom:switchboard" ? cfg.model || "" : ""];
      })));
      setAudioEnabled(!!hermesStatus.hasSwitchboardStt);
      setSttModel(hermesStatus.hasSwitchboardStt ? hermesStatus.settings?.stt?.model || "" : "");
    }
  }, [hermesStatus]);

  const checkStatus = useCallback(async (profile = activeProfile) => {
    const sequence = ++statusSequence.current;
    setChecking(true);
    try {
      const res = await fetch(`${ENDPOINT}?profile=${encodeURIComponent(profile)}`);
      const data = await res.json();
      if (sequence === statusSequence.current) setHermesStatus(data);
    } catch (error) {
      if (sequence === statusSequence.current) setHermesStatus({ installed: false, error: error.message });
    } finally {
      if (sequence === statusSequence.current) setChecking(false);
    }
  }, [activeProfile]);

  useEffect(() => {
    if (!isExpanded) return;
    hasInitializedModel.current = false;
    setCustomBaseUrl("");
    setMessage(null);
    checkStatus(activeProfile);
    fetchModelAliases();
    fetchProfiles();
  }, [isExpanded, activeProfile, checkStatus, fetchModelAliases, fetchProfiles]);

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

  const addModel = (value = modelDraft) => {
    const model = value.trim();
    if (!model) return;
    setSelectedModels((current) => current.includes(model) ? current : [...current, model]);
    if (!selectedModel) setSelectedModel(model);
    setModelDraft("");
  };

  const removeModel = (model) => {
    const next = selectedModels.filter((entry) => entry !== model);
    if (selectedModel === model) setSelectedModel(next[0] || "");
    setSelectedModels(next);
  };

  const handleApply = async (applyToAll = false) => {
    if (applyToAll && !matchKnownEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl })) {
      setMessage({ type: "error", text: "Choose a Switchboard endpoint before applying to all profiles." });
      return;
    }
    setApplying(true);
    setMessage(null);
    try {
      const keyToUse = selectedApiKey?.trim()
        || (!cloudEnabled ? "sk_switchboard" : null);

      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: activeProfile,
          applyToAll,
          delegation: roleModels.delegation || null,
          auxiliary: Object.fromEntries(Object.entries(roleModels).filter(([role]) => role !== "delegation").map(([role, value]) => [role, value || null])),
          audio: { enabled: audioEnabled, model: sttModel },
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyToUse,
          model: selectedModel || selectedModels[0],
          models: selectedModels,
          defaultModel: selectedModel || selectedModels[0],
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const skipped = (data.results || []).filter((result) => result.status !== "updated");
        setMessage({ type: skipped.length ? "error" : "success", text: data.bulk
          ? `${data.message}${skipped.length ? ": " + skipped.map((result) => `${result.profile}: ${result.reason}`).join("; ") : ""}`
          : `Settings applied to ${activeProfile}.` });
        hasInitializedModel.current = false;
        checkStatus();
        fetchProfiles();
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
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch(ENDPOINT, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: activeProfile }) });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully!" });
        setSelectedModel("");
        setSelectedModels([]);
        hasInitializedModel.current = false;
        checkStatus();
        fetchProfiles();
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
    if (modalTarget === "catalog") addModel(model.value);
    else {
      if (modalTarget === "stt") setSttModel(model.value);
      else setRoleModels((current) => ({ ...current, [modalTarget]: model.value }));
      setModalOpen(false);
    }
  };

  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_switchboard" : "<API_KEY_FROM_DASHBOARD>");

    const models = selectedModels.length ? selectedModels : ["provider/model-id"];
    const activeModel = selectedModel || models[0];
    const config = {
      custom_providers: [{ name: "switchboard", base_url: getEffectiveBaseUrl(), key_env: "SWITCHBOARD_API_KEY", api_mode: "chat_completions", models: Object.fromEntries(models.map((model) => [model, {}])) }],
      model: { default: activeModel, provider: "custom:switchboard" },
    };
    if (roleModels.delegation) config.delegation = { model: roleModels.delegation, provider: "custom:switchboard" };
    const auxiliary = Object.fromEntries(Object.entries(roleModels).filter(([role, model]) => role !== "delegation" && model).map(([role, model]) => [role, { model, provider: "custom:switchboard" }]));
    if (Object.keys(auxiliary).length) config.auxiliary = auxiliary;
    if (audioEnabled && sttModel) config.stt = { enabled: true, provider: "openai", openai: { model: sttModel, base_url: getEffectiveBaseUrl(), api_key: "${SWITCHBOARD_API_KEY}" } };
    const home = activeProfile === "default" ? "~/.hermes" : `~/.hermes/profiles/${activeProfile}`;
    return [
      { filename: `${home}/config.yaml`, content: stringifyYaml(config) },
      { filename: `${home}/.env`, content: `SWITCHBOARD_API_KEY=${JSON.stringify(keyToUse)}\n` },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div {...cardHeaderToggleProps(onToggle, isExpanded, tool.name)} className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-lg">
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src="/providers/hermes.png" alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} />
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
          {profiles.length > 1 && (
            <label className="flex flex-col gap-1 text-xs text-text-muted">
              Hermes profile
              <select aria-label="Hermes profile" value={activeProfile} onChange={(event) => setActiveProfile(event.target.value)} disabled={applying || restoring} className="rounded border border-border bg-surface p-2 text-text-main">
                {profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.displayName || profile.name}{profile.hasSwitchboard ? " · Connected" : ""}</option>)}
              </select>
              <code>{profiles.find((profile) => profile.name === activeProfile)?.command || "hermes"}</code>
            </label>
          )}
          {checking && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Hermes Agent...</span>
            </div>
          )}

          {!checking && hermesStatus && !hermesStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-yellow-500">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-yellow-600 dark:text-yellow-400">Hermes Agent not detected locally</p>
                    <p className="text-sm text-text-muted">Install: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</p>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 pl-0 sm:pl-9">
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="w-full sm:w-auto !bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!checking && hermesStatus?.installed && (
            <>
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getEffectiveBaseUrl()}
                    onChange={setCustomBaseUrl}
                    initialUrl={hermesStatus?.settings?.model?.base_url || ""}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                  />
                </div>

                {hermesStatus?.settings?.model?.base_url && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {hermesStatus.settings.model.base_url}
                    </span>
                  </div>
                )}

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
                  onOpenPicker={() => { setModalTarget("catalog"); setModalOpen(true); }}
                  canOpenPicker={Boolean(hasActiveProviders)}
                  defaultModel={selectedModel}
                  onDefaultChange={setSelectedModel}
                />
              </div>

              <details className="rounded border border-border p-3">
                <summary className="cursor-pointer text-xs font-medium">Model roles</summary>
                <div className="mt-3 flex flex-col gap-2">
                  {(CLI_TOOLS.hermes.roles || []).map((role) => (
                    <label key={role.id} className="flex flex-col gap-1 text-xs text-text-muted">
                      {role.label}
                      <div className="flex gap-2">
                        <input aria-label={role.label} value={roleModels[role.id] || ""} onChange={(event) => setRoleModels((current) => ({ ...current, [role.id]: event.target.value }))} placeholder="Inherit default model" className="min-w-0 flex-1 rounded border border-border bg-surface p-2" />
                        <Button size="sm" variant="ghost" onClick={() => { setModalTarget(role.id); setModalOpen(true); }} disabled={!hasActiveProviders}>Select</Button>
                      </div>
                    </label>
                  ))}
                </div>
              </details>
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input type="checkbox" checked={audioEnabled} onChange={(event) => setAudioEnabled(event.target.checked)} />
                Transcribe voice and audio through Switchboard
              </label>
              {audioEnabled && <div className="flex gap-2">
                <input aria-label="Transcription model" value={sttModel} onChange={(event) => setSttModel(event.target.value)} placeholder="provider/transcription-model" className="min-w-0 flex-1 rounded border border-border bg-surface p-2 text-xs" />
                <Button size="sm" variant="ghost" onClick={() => { setModalTarget("stt"); setModalOpen(true); }}>Select</Button>
              </div>}

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <Button variant="primary" size="sm" onClick={() => handleApply(false)} disabled={selectedModels.length === 0 || (audioEnabled && !sttModel.trim())} loading={applying} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                {profiles.length > 1 && <Button variant="secondary" size="sm" onClick={() => handleApply(true)} disabled={selectedModels.length === 0} loading={applying}>Apply endpoint to all profiles</Button>}
                <Button variant="outline" size="sm" onClick={handleReset} disabled={!hermesStatus?.hasSwitchboard} loading={restoring} className="w-full sm:w-auto">
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)} className="w-full sm:w-auto">
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
        onDeselect={modalTarget === "catalog" ? (model) => removeModel(model.value) : undefined}
        selectedModel={modalTarget === "stt" ? sttModel : modalTarget === "catalog" ? null : roleModels[modalTarget] || null}
        kindFilter={modalTarget === "stt" ? "stt" : undefined}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        addedModelValues={modalTarget === "catalog" ? selectedModels : []}
        closeOnSelect={modalTarget !== "catalog"}
        title={modalTarget === "stt" ? "Select Hermes transcription model" : modalTarget === "catalog" ? "Add Models for Hermes Agent" : "Select role model"}
      />

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Hermes Agent - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
