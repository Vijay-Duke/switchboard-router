"use client";
// @ts-check

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, Button, Input, Modal, Toggle, ConfirmModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import EndpointRow from "./components/EndpointRow";
import ProtocolEndpointsCard from "./components/ProtocolEndpointsCard";
import SecurityWarning from "./components/SecurityWarning";
import KeyPolicyModal from "./components/KeyPolicyModal";
import { queryKeys } from "@/shared/query/keys";
import { fetchJson } from "@/shared/query/fetchJson";
import { useNotificationStore } from "@/store/notificationStore";

/**
 * @typedef {object} EndpointInitialData
 * @property {string} [machineId]
 * @property {any[]} keys
 * @property {Record<string, any>} settings
 */

/**
 * Endpoint & API keys client UI. Initial read comes from the Server Component.
 * @param {{ initialData: EndpointInitialData }} props
 */
function formatTokens(n) {
  const value = Number(n || 0);
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * Token-quota badge for a key row: usage summary plus optional progress.
 * @param {any} key
 */
function tokenUsageBadge(key) {
  if (!key.tokenLimit || key.tokenLimit <= 0) {
    return Number(key.usedTokens || 0) > 0
      ? { label: `${formatTokens(key.usedTokens)} tokens`, tone: "muted", percent: null }
      : null;
  }
  const used = Number(key.usedTokens || 0);
  const percent = Math.min(100, Math.round((used / key.tokenLimit) * 100));
  const exhausted = used >= key.tokenLimit;
  return {
    label: `${formatTokens(used)} / ${formatTokens(key.tokenLimit)} tokens${exhausted ? " — limit reached" : ` (${percent}%)`}`,
    tone: exhausted ? "danger" : percent > 80 ? "warn" : "muted",
    percent,
    exhausted,
  };
}

export default function EndpointPageClient({ initialData }) {
  const queryClient = useQueryClient();
  const machineId = initialData?.machineId || "";
  const notify = useNotificationStore((s) => s.error);

  const keysQuery = useQuery({
    queryKey: queryKeys.endpoint.keys(),
    queryFn: async () => {
      const fetchKeys = async () => {
        const data = await fetchJson(/** @type {any} */ ("/api/keys"));
        return data.keys || [];
      };
      let existing = await fetchKeys();
      // Auto-provision a default key for first-time users so the endpoint works out of the box.
      if (existing.length === 0) {
        try {
          await fetchJson("/api/keys", {
            method: "POST",
            body: JSON.stringify({ name: "Default Key", findOrCreate: true }),
          });
        } catch {
          // O22: findOrCreate is serialized server-side, so two tabs share one
          // key; on any failure fall through to the re-fetch instead of erroring.
        }
        try {
          existing = await fetchKeys();
        } catch { /* fall through to empty render */ }
      }
      return existing;
    },
    initialData: initialData?.keys || [],
  });

  const settingsQuery = useQuery({
    queryKey: queryKeys.endpoint.settings(),
    queryFn: () => fetchJson(/** @type {any} */ ("/api/settings")),
    initialData: initialData?.settings || {},
  });

  const keys = keysQuery.data || [];
  const requireApiKey = settingsQuery.data?.requireApiKey === true;

  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyTokenLimit, setNewKeyTokenLimit] = useState("");
  const [createdKey, setCreatedKey] = useState(/** @type {string|null} */ (null));
  const [confirmState, setConfirmState] = useState(/** @type {any} */ (null));
  const [editingKey, setEditingKey] = useState(/** @type {any} */ (null));

  // Client-only origin so SSR/hydrate don't stick on bare "/v1"
  const [baseUrl, setBaseUrl] = useState("/v1");
  const [origin, setOrigin] = useState("http://127.0.0.1:20128");
  const [hasHydrated, setHasHydrated] = useState(false);
  useEffect(() => {
    setHasHydrated(true);
    if (typeof window !== "undefined") {
      setBaseUrl(`${window.location.origin}/v1`);
      setOrigin(window.location.origin);
    }
  }, []);

  const { copied, copy } = useCopyToClipboard();

  const requireApiKeyMutation = useMutation({
    mutationFn: (/** @type {boolean} */ value) =>
      fetchJson("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ requireApiKey: value }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.endpoint.settings() });
    },
    onError: () => notify("Failed to update API key requirement"),
  });

  const createKeyMutation = useMutation({
    mutationFn: (/** @type {{ name: string, tokenLimit: number | null }} */ { name, tokenLimit }) =>
      fetchJson("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name, ...(tokenLimit != null ? { tokenLimit } : {}) }),
      }),
    onSuccess: (data) => {
      setCreatedKey(data.key || null);
      setNewKeyName("");
      setNewKeyTokenLimit("");
      setShowAddModal(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.endpoint.keys() });
    },
    onError: () => notify("Failed to create API key"),
  });

  const deleteKeyMutation = useMutation({
    mutationFn: (/** @type {string} */ id) =>
      fetchJson(`/api/keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.endpoint.keys() });
    },
    onError: () => notify("Failed to delete API key"),
  });

  const toggleKeyMutation = useMutation({
    mutationFn: (/** @type {{ id: string, isActive: boolean }} */ { id, isActive }) =>
      fetchJson(`/api/keys/${id}`, {
        method: "PUT",
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.endpoint.keys() });
    },
    onError: () => notify("Failed to toggle API key"),
  });

  const updateKeyMutation = useMutation({
    mutationFn: (/** @type {{ id: string, patch: Record<string, any> }} */ { id, patch }) =>
      fetchJson(`/api/keys/${id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      setEditingKey(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.endpoint.keys() });
    },
    onError: () => notify("Failed to update API key policy"),
  });


  const handleRequireApiKeyChange = () => {
    if (!requireApiKey) {
      requireApiKeyMutation.mutate(true);
      return;
    }
    setConfirmState({
      title: "Disable API key protection?",
      message: "Any client that can reach this Switchboard endpoint will be able to use your provider accounts.",
      onConfirm: () => {
        setConfirmState(null);
        requireApiKeyMutation.mutate(false);
      },
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <Card>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">api</span>
          API Endpoint
        </h2>
        <p className="text-sm text-text-muted mb-4">
          Local OpenAI-compatible base URL for coding agents and SDKs. Switchboard is local-only — no tunnels or remote exposure.
        </p>
        <EndpointRow
          label="Local"
          url={baseUrl}
          copyId="local_url"
          copied={copied}
          onCopy={copy}
        />
        {machineId ? (
          <p className="mt-3 text-xs text-text-muted font-mono">Machine: {machineId}</p>
        ) : null}
      </Card>

      <ProtocolEndpointsCard
        origin={origin}
        copied={copied}
        onCopy={copy}
      />

      <Card id="require-api-key">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">vpn_key</span>
            API Keys
          </h2>
          <Button icon="add" onClick={() => setShowAddModal(true)}>
            Create Key
          </Button>
        </div>

        <div className="flex items-center justify-between pb-4 mb-4 border-b border-border">
          <div>
            <p className="font-medium">Require API key</p>
            <p className="text-sm text-text-muted">
              Requests without a valid key will be rejected
            </p>
          </div>
          <Toggle
            checked={requireApiKey}
            onChange={handleRequireApiKeyChange}
            aria-label="Require API key"
          />
        </div>

        {!requireApiKey && (
          <div className="mb-4 -mt-2">
            <SecurityWarning message="API key is not required — any local client can call /v1." />
          </div>
        )}

        {keys.length === 0 ? (
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">vpn_key</span>
            </div>
            <p className="text-text-main font-medium mb-1">No API keys yet</p>
            <p className="text-sm text-text-muted mb-4">Create your first API key to get started</p>
            <Button icon="add" onClick={() => setShowAddModal(true)}>
              Create Key
            </Button>
          </div>
        ) : (
          <div className="flex flex-col">
            {keys.map((key) => {
              const keyLabel = key.name?.trim() || key.id;
              return (
              <div
                key={key.id}
                className={`group flex items-center justify-between py-3 border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0 ${key.isActive === false ? "opacity-60" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{key.name}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-1">
                    <code className="text-xs text-text-muted font-mono">{key.keyPrefix}</code>
                    {key.rotationRequired ? (
                      <span
                        className="rounded-full bg-orange-500/10 px-2 py-0.5 text-[11px] text-orange-600"
                        title="This legacy key remains usable through its compatibility verifier until you create a replacement."
                      >
                        Rotation required
                      </span>
                    ) : null}
                    {(key.allowedModels?.length || key.allowedCombos?.length) ? (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">Restricted targets</span>
                    ) : (
                      <span className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] text-text-muted dark:bg-white/5">All targets</span>
                    )}
                    {key.rateLimitPerMinute ? (
                      <span className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] text-text-muted dark:bg-white/5">{key.rateLimitPerMinute}/min</span>
                    ) : null}
                    {key.concurrencyLimit ? (
                      <span className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] text-text-muted dark:bg-white/5">{key.concurrencyLimit} concurrent</span>
                    ) : null}
                    {key.spendLimitUsd != null ? (
                      <span className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] text-text-muted dark:bg-white/5">
                        ${Number(key.spentUsd || 0).toFixed(2)} / ${Number(key.spendLimitUsd).toFixed(2)}
                      </span>
                    ) : null}
                    {(() => { const badge = tokenUsageBadge(key); return badge ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] ${
                          badge.tone === "danger"
                            ? "bg-red-500/10 text-red-600"
                            : badge.tone === "warn"
                              ? "bg-orange-500/10 text-orange-600"
                              : "bg-black/5 text-text-muted dark:bg-white/5"
                        }`}
                      >
                        {badge.label}
                      </span>
                    ) : null; })()}
                  </div>
                  {key.tokenLimit > 0 && (() => {
                    const badge = tokenUsageBadge(key);
                    return badge?.percent != null ? (
                      <div
                        className="mt-2 h-1.5 w-full max-w-64 overflow-hidden rounded-full bg-black/5 dark:bg-white/10"
                        role="progressbar"
                        aria-label="Token quota usage"
                        aria-valuenow={badge.percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div
                          className={`h-full rounded-full transition-all ${
                            badge.exhausted ? "bg-red-500" : badge.percent > 80 ? "bg-orange-500" : "bg-primary"
                          }`}
                          style={{ width: `${badge.percent}%` }}
                        />
                      </div>
                    ) : null;
                  })()}
                  <p className="text-xs text-text-muted mt-1">
                    Created {hasHydrated ? new Date(key.createdAt).toLocaleDateString() : "—"}
                  </p>
                  {key.isActive === false && (
                    <p className="text-xs text-orange-500 mt-1">Paused</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Toggle
                    size="sm"
                    checked={key.isActive ?? true}
                    onChange={(checked) => {
                      if (key.isActive && !checked) {
                        setConfirmState({
                          title: "Pause API Key",
                          message: `Pause API key "${keyLabel}"?\n\nThis key will stop working immediately but can be resumed later.`,
                          onConfirm: async () => {
                            setConfirmState(null);
                            toggleKeyMutation.mutate({ id: key.id, isActive: checked });
                          },
                        });
                      } else {
                        toggleKeyMutation.mutate({ id: key.id, isActive: checked });
                      }
                    }}
                    title={key.isActive ? "Pause key" : "Resume key"}
                    aria-label={key.isActive ? `Pause API key ${keyLabel}` : `Resume API key ${keyLabel}`}
                  />
                  <button
                    type="button"
                    onClick={() => setEditingKey(key)}
                    className="p-2 hover:bg-primary/10 rounded text-text-muted hover:text-primary opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                    title="Edit key policy"
                    aria-label={`Edit API key ${keyLabel} policy`}
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setConfirmState({
                        title: "Delete API Key",
                        message: `Delete API key "${keyLabel}"?`,
                        onConfirm: async () => {
                          setConfirmState(null);
                          deleteKeyMutation.mutate(key.id);
                        },
                      })
                    }
                    className="p-2 hover:bg-red-500/10 rounded text-red-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                    aria-label={`Delete API key ${keyLabel}`}
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </Card>

      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        onClose={() => {
          setShowAddModal(false);
          setNewKeyName("");
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Production Key"
          />
          <Input
            label="Token limit (optional)"
            type="number"
            min="0"
            step="1"
            value={newKeyTokenLimit}
            onChange={(e) => setNewKeyTokenLimit(e.target.value)}
            placeholder="Unlimited"
          />
          <div className="flex gap-2">
            <Button
              onClick={() => createKeyMutation.mutate({
                name: newKeyName.trim(),
                tokenLimit: newKeyTokenLimit === "" ? null : Math.max(0, parseInt(newKeyTokenLimit, 10) || 0),
              })}
              fullWidth
              disabled={!newKeyName.trim() || createKeyMutation.isPending}
              loading={createKeyMutation.isPending}
            >
              Create
            </Button>
            <Button
              onClick={() => {
                setShowAddModal(false);
                setNewKeyName("");
                setNewKeyTokenLimit("");
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={!!createdKey}
        title="API Key Created"
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              This is the only time you will see this key. Store it securely.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 font-mono text-sm"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      <KeyPolicyModal
        apiKey={editingKey}
        isOpen={!!editingKey}
        isSaving={updateKeyMutation.isPending}
        onClose={() => setEditingKey(null)}
        onSave={(patch) => updateKeyMutation.mutate({ id: editingKey.id, patch })}
      />

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}

EndpointPageClient.propTypes = {
  initialData: PropTypes.shape({
    machineId: PropTypes.string,
    keys: PropTypes.array,
    settings: PropTypes.object,
  }).isRequired,
};
