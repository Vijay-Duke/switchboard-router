"use client";
// @ts-check

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, Button, Input, Modal, Toggle, ConfirmModal } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import EndpointRow from "./components/EndpointRow";
import SecurityWarning from "./components/SecurityWarning";
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
export default function EndpointPageClient({ initialData }) {
  const queryClient = useQueryClient();
  const machineId = initialData?.machineId || "";
  const notify = useNotificationStore((s) => s.error);

  const keysQuery = useQuery({
    queryKey: queryKeys.endpoint.keys(),
    queryFn: async () => {
      const data = await fetchJson(/** @type {any} */ ("/api/keys"));
      return data.keys || [];
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
  const [createdKey, setCreatedKey] = useState(/** @type {string|null} */ (null));
  const [confirmState, setConfirmState] = useState(/** @type {any} */ (null));
  const [visibleKeys, setVisibleKeys] = useState(() => new Set());

  // Client-only origin so SSR/hydrate don't stick on bare "/v1"
  const [baseUrl, setBaseUrl] = useState("/v1");
  useEffect(() => {
    setBaseUrl(`${window.location.origin}/v1`);
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
    mutationFn: (/** @type {string} */ name) =>
      fetchJson("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: (data) => {
      setCreatedKey(data.key || null);
      setNewKeyName("");
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

  /**
   * @param {string} [fullKey]
   */
  const maskKey = (fullKey) => {
    if (!fullKey || fullKey.length <= 10) return fullKey || "";
    return fullKey.slice(0, 6) + "•".repeat(fullKey.length - 10) + fullKey.slice(-4);
  };

  /**
   * @param {string} keyId
   */
  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

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
            {keys.map((key) => (
              <div
                key={key.id}
                className={`group flex items-center justify-between py-3 border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0 ${key.isActive === false ? "opacity-60" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{key.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="text-xs text-text-muted font-mono">
                      {visibleKeys.has(key.id) ? key.key : maskKey(key.key)}
                    </code>
                    <button
                      type="button"
                      onClick={() => toggleKeyVisibility(key.id)}
                      className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                      title={visibleKeys.has(key.id) ? "Hide key" : "Show key"}
                    >
                      <span className="material-symbols-outlined text-[14px]">
                        {visibleKeys.has(key.id) ? "visibility_off" : "visibility"}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => copy(key.key, key.id)}
                      className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                    >
                      <span className="material-symbols-outlined text-[14px]">
                        {copied === key.id ? "check" : "content_copy"}
                      </span>
                    </button>
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    Created {new Date(key.createdAt).toLocaleDateString()}
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
                        const keyLabel = key.name?.trim() || key.id;
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
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setConfirmState({
                        title: "Delete API Key",
                        message: `Delete API key "${key.name?.trim() || key.id}"?`,
                        onConfirm: async () => {
                          setConfirmState(null);
                          deleteKeyMutation.mutate(key.id);
                        },
                      })
                    }
                    className="p-2 hover:bg-red-500/10 rounded text-red-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
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
          <div className="flex gap-2">
            <Button
              onClick={() => createKeyMutation.mutate(newKeyName.trim())}
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
