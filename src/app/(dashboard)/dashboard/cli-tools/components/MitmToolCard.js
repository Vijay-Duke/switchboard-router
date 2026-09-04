"use client";
// @ts-check

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button, Badge, Input, ModelSelectModal } from "@/shared/components";
import { TOOL_HOSTS } from "@/shared/constants/mitmToolHosts";
import Image from "next/image";

/**
 * Per-tool MITM card — shows DNS status + model mappings.
 * - Auto-saves model mapping on blur or modal select
 * - Skips sudo modal if password is already cached
 * - Model mappings can only be edited when DNS is active
 */
export default function MitmToolCard({
  tool,
  isExpanded,
  onToggle,
  serverRunning,
  dnsActive,
  hasCachedPassword,
  needsSudoPassword,
  isWin,
  apiKeys,
  activeProviders,
  hasActiveProviders,
  modelAliases = {},
  cloudEnabled,
  onDnsChange,
}) {
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [sudoPassword, setSudoPassword] = useState("");
  const [pendingDnsAction, setPendingDnsAction] = useState(null);
  const [modalError, setModalError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [mappingError, setMappingError] = useState(null);
  const saveChainRef = useRef(Promise.resolve());
  const [modalOpen, setModalOpen] = useState(false);
  const [currentEditingAlias, setCurrentEditingAlias] = useState(null);

  const mitmHosts = TOOL_HOSTS[tool.id] ?? [];
  const canRunWithoutPassword = isWin || hasCachedPassword || needsSudoPassword === false;

  const loadSavedMappings = useCallback(async () => {
    try {
      const res = await fetch(`/api/cli-tools/antigravity-mitm/alias?tool=${tool.id}`);
      if (res.ok) {
        const data = await res.json();
        // Unconditional: an empty server state must clear stale chips (T72).
        setModelMappings(data.aliases || {});
      }
    } catch { /* ignore */ }
  }, [tool.id]);

  useEffect(() => {
    if (isExpanded) loadSavedMappings();
  }, [isExpanded, loadSavedMappings]);

  // Serialize mapping PUTs so rapid edits persist in order (last writer wins),
  // and surface failures instead of swallowing them (T71).
  const saveMappings = useCallback((mappings) => {
    const run = saveChainRef.current.then(async () => {
      const res = await fetch("/api/cli-tools/antigravity-mitm/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: tool.id, mappings }),
      });
      if (!res.ok) throw new Error(`Failed to save model mappings (status ${res.status})`);
    });
    saveChainRef.current = run.catch(() => {});
    return run;
  }, [tool.id]);

  const queueSaveMappings = (mappings) => {
    setMappingError(null);
    saveMappings(mappings).catch((error) => {
      setMappingError(error?.message || "Failed to save model mappings");
    });
  };

  // Empty values delete the key (never persist "") so the UI can be fully cleared (T72).
  const setMappingValue = (alias, value) => {
    const updated = { ...modelMappings };
    if (value) updated[alias] = value;
    else delete updated[alias];
    return updated;
  };

  const handleMappingBlur = (alias, value) => {
    queueSaveMappings(setMappingValue(alias, value));
  };

  const handleModelMappingChange = (alias, value) => {
    setModelMappings((prev) => {
      const updated = { ...prev };
      if (value) updated[alias] = value;
      else delete updated[alias];
      return updated;
    });
  };

  const handleModelSelect = (model) => {
    if (!currentEditingAlias) return;
    if (model.isPlaceholder) {
      // Say why the pick did nothing instead of silently closing (T73).
      setWarning(`"${model.value}" is a placeholder — connect the provider first, then pick a real model`);
      return;
    }
    const updated = { ...modelMappings, [currentEditingAlias]: model.value };
    setModelMappings(updated);
    queueSaveMappings(updated);
  };

  const handleDnsToggle = () => {
    if (!serverRunning) return;
    const action = dnsActive ? "disable" : "enable";
    if (canRunWithoutPassword) {
      doDnsAction(action, "");
    } else {
      setPendingDnsAction(action);
      setShowPasswordModal(true);
      setModalError(null);
    }
  };

  const doDnsAction = async (action, password) => {
    setLoading(true);
    setWarning(null);
    setActionError(null);
    try {
      const res = await fetch("/api/cli-tools/antigravity-mitm", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: tool.id, action, sudoPassword: password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed to toggle DNS (status ${res.status})`);

      if (action === "enable") {
        setWarning(`Restart ${tool.name} to apply changes`);
      }

      setShowPasswordModal(false);
      setSudoPassword("");
      onDnsChange?.(data);
    } catch (error) {
      // DNS state lives in the parent — a silent no-op reads as a broken toggle (T70).
      setActionError(error?.message || "Failed to toggle DNS");
    } finally {
      setLoading(false);
      setPendingDnsAction(null);
    }
  };

  const handleConfirmPassword = () => {
    if (!sudoPassword.trim()) {
      setModalError("Sudo password is required");
      return;
    }
    doDnsAction(pendingDnsAction, sudoPassword);
  };

  return (
    <>
      <Card padding="xs" className="overflow-hidden">
        <div
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${tool.name} settings`}
          className="flex items-start justify-between gap-3 hover:cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-lg sm:items-center"
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="size-8 flex items-center justify-center shrink-0">
              <Image
                src={tool.image}
                alt=""
                width={32}
                height={32}
                className="size-8 object-contain rounded-lg"
                sizes="32px"
                onError={(e) => { e.target.style.display = "none"; }}
              />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium text-sm">{tool.name}</h3>
                {!serverRunning ? (
                  <Badge variant="default" size="sm">Server off</Badge>
                ) : dnsActive ? (
                  <Badge variant="success" size="sm">Active</Badge>
                ) : (
                  <Badge variant="warning" size="sm">DNS off</Badge>
                )}
              </div>
              <p className="text-xs text-text-muted sm:truncate">Intercept {tool.name} requests via MITM proxy</p>
            </div>
          </div>
          <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`} aria-hidden="true">
            expand_more
          </span>
        </div>

        {isExpanded && (
          <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
            {/* Hosts */}
            {mitmHosts.length > 0 && (
              <div className="mt-2 rounded-md border border-border bg-surface/50 px-2 py-1.5">
                <p className="text-[10px] font-medium tracking-wide text-text-main/80 mb-1">
                  Edit hosts file manually to add the following entries:
                </p>
                <ul className="list-none space-y-0.5 font-mono text-[10px] text-text-muted break-all">
                  {mitmHosts.map((h) => (
                    <li key={h}>127.0.0.1 {h}</li>
                  ))}
                </ul>
              </div>
            )}
            {/* Info */}
            <div className="flex flex-col gap-0.5 text-[11px] text-text-muted px-1">
              <p>Toggle DNS to redirect {tool.name} traffic through Switchboard via MITM.</p>
              {!dnsActive && (
                <p className="text-amber-600 text-[10px] mt-1">
                  ⚠️ Enable DNS to edit model mappings
                </p>
              )}
            </div>

            {/* Model Mappings */}
            {tool.defaultModels?.length > 0 && (
              <div className="flex flex-col gap-2">
                {tool.defaultModels.map((model) => (
                  <div key={model.alias} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[9rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right">{model.name}</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <div className="relative w-full min-w-0">
                      <input
                        type="text"
                        value={modelMappings[model.alias] || ""}
                        onChange={(e) => handleModelMappingChange(model.alias, e.target.value)}
                        onBlur={(e) => handleMappingBlur(model.alias, e.target.value)}
                        placeholder="provider/model-id"
                        disabled={!dnsActive}
                        className={`w-full min-w-0 pl-2 pr-7 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5 ${!dnsActive ? "opacity-50 cursor-not-allowed" : ""}`}
                      />
                      {modelMappings[model.alias] && (
                        <button
                          onClick={() => {
                            const updated = setMappingValue(model.alias, "");
                            setModelMappings(updated);
                            queueSaveMappings(updated);
                          }}
                          className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-red-500 rounded transition-colors"
                          title="Clear"
                        >
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => openModelSelector(model.alias)}
                      disabled={!hasActiveProviders || !dnsActive}
                      className={`rounded border px-2 py-2 text-xs transition-colors sm:py-1.5 ${hasActiveProviders && dnsActive ? "bg-surface border-border hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}
                    >
                      Select
                    </button>
                  </div>
                ))}
              </div>
            )}

            {tool.defaultModels?.length === 0 && (
              <p className="text-xs text-text-muted px-1">Model mappings will be available soon.</p>
            )}

            {/* Start / Stop DNS button */}
            <div className="flex flex-col gap-2 sm:items-start">
              {dnsActive ? (
                <button
                  onClick={handleDnsToggle}
                  disabled={!serverRunning || loading}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:py-1.5"
                >
                  <span className="material-symbols-outlined text-[16px]">stop_circle</span>
                  Stop DNS
                </button>
              ) : (
                <button
                  onClick={handleDnsToggle}
                  disabled={!serverRunning || loading}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:py-1.5"
                >
                  <span className="material-symbols-outlined text-[16px]">play_circle</span>
                  Start DNS
                </button>
              )}

              {/* Warning below button */}
              {warning && (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded text-xs text-amber-500">
                  <span className="material-symbols-outlined text-[14px]">warning</span>
                  <span>{warning}</span>
                </div>
              )}
              {(actionError || mappingError) && (
                <div role="alert" className="flex items-center gap-2 px-2 py-1.5 rounded text-xs bg-red-500/10 text-red-600 dark:text-red-400">
                  <span className="material-symbols-outlined text-[14px]">error</span>
                  <span>{actionError || mappingError}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* Password Modal */}
      {showPasswordModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !loading) { setShowPasswordModal(false); setSudoPassword(""); setModalError(null); }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mitm-tool-sudo-title"
            className="mx-4 flex w-full max-w-sm flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-xl sm:p-6"
          >
            <h3 id="mitm-tool-sudo-title" className="font-semibold text-text-main">Sudo Password Required</h3>
            <div className="flex items-start gap-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <span className="material-symbols-outlined text-yellow-500 text-[20px]" aria-hidden="true">warning</span>
              <p className="text-xs text-text-muted">Required to modify /etc/hosts and flush DNS cache</p>
            </div>
            <Input
              label="Sudo password"
              type="password"
              autoFocus
              placeholder="Enter sudo password"
              value={sudoPassword}
              onChange={(e) => setSudoPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !loading) handleConfirmPassword(); }}
            />
            {modalError && (
              <div role="alert" className="flex items-center gap-2 px-2 py-1.5 rounded text-xs bg-red-500/10 text-red-600">
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
                <span>{modalError}</span>
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setShowPasswordModal(false); setSudoPassword(""); setModalError(null); }} disabled={loading}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleConfirmPassword} loading={loading}>
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Model Select Modal */}
      <ModelSelectModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSelect={handleModelSelect}
        selectedModel={currentEditingAlias ? modelMappings[currentEditingAlias] : null}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title={`Select model for ${currentEditingAlias}`}
      />
    </>
  );
}
