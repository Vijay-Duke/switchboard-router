"use client";
// @ts-check

import { useParams, notFound, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button, Input, Toggle, ModelSelectModal } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS, MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { reportClientError } from "@/shared/utils/clientFeedback";
import { fetchJson } from "@/shared/query/fetchJson";
import { requestConfirmation } from "@/store/confirmationStore";
import Image from "next/image";

// Parse "providerId/model" or just "providerId" → { providerId, model }
function parseModelEntry(entry) {
  if (typeof entry !== "string") return { providerId: "", model: "" };
  const idx = entry.indexOf("/");
  if (idx < 0) return { providerId: entry, model: "" };
  return { providerId: entry.slice(0, idx), model: entry.slice(idx + 1) };
}

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

const KIND_LABELS = {
  webSearch: "Web Search",
  webFetch: "Web Fetch",
  image: "Text to Image",
  tts: "Text To Speech",
};

const EXAMPLE_PATHS = {
  webSearch: "/v1/search",
  webFetch: "/v1/web/fetch",
  image: "/v1/images/generations",
  tts: "/v1/audio/speech",
};

const EXAMPLE_BODIES = {
  webSearch: (n) => ({ model: n, query: "What is the latest news about AI?", search_type: "web", max_results: 5 }),
  webFetch: (n) => ({ model: n, url: "https://example.com", format: "markdown" }),
  image: (n) => ({ model: n, prompt: "A cute cat playing piano", n: 1, size: "1024x1024" }),
  tts: (n) => ({ model: n, input: "Hello, this is a test.", voice: "alloy" }),
};

// Map combo.kind → listing route to go back to
function getListingHref(kind) {
  if (kind === "webSearch" || kind === "webFetch") return "/dashboard/media-providers/web";
  return `/dashboard/media-providers/${kind}`;
}

export default function ComboDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [combo, setCombo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [providers, setProviders] = useState([]);
  const [roundRobin, setRoundRobin] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [logs, setLogs] = useState([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connections, setConnections] = useState([]);
  const [modelAliases, setModelAliases] = useState({});

  const fetchAll = async () => {
    try {
      const [comboRes, settingsRes, logsRes, connsRes, aliasesRes] = await Promise.all([
        fetch(`/api/combos/${id}`, { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/usage/logs", { cache: "no-store" }),
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/models/alias", { cache: "no-store" }),
      ]);
      if (aliasesRes.ok) setModelAliases((await aliasesRes.json()).aliases || {});
      if (connsRes.ok) setConnections((await connsRes.json()).connections || []);
      if (!comboRes.ok) { setCombo(null); setLoading(false); return; }
      const c = await comboRes.json();
      setCombo(c);
      setName(c.name);
      setProviders(c.models || []);
      const s = settingsRes.ok ? await settingsRes.json() : {};
      setRoundRobin(s.comboStrategies?.[c.name]?.fallbackStrategy === "round-robin");
      const allLogs = logsRes.ok ? await logsRes.json() : [];
      // Attribute logs by the pipe-delimited model column only (field 2);
      // substring matching misattributes lines that merely mention the name
      const comboModelKeys = new Set(
        [c.name, ...(c.models || []).map((entry) => {
          const { model } = parseModelEntry(entry);
          return model || entry;
        })].map((v) => (typeof v === "string" ? v.toLowerCase() : v))
      );
      const logModel = (line) => {
        const parts = line.split(" | ");
        return parts.length >= 2 ? parts[1].trim().toLowerCase() : "";
      };
      setLogs(allLogs.filter((l) => typeof l === "string" && comboModelKeys.has(logModel(l))).slice(0, 50));
    } catch { /* noop */ }
    setLoading(false);
  };

  // id changed (navigation reuses this component): drop the previous combo
  // immediately instead of flashing it while the new one loads
  useEffect(() => { setLoading(true); setCombo(null); }, [id]);
  useEffect(() => { fetchAll(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const validateName = (v) => {
    if (!v.trim()) { setNameError("Name is required"); return false; }
    if (!VALID_NAME_REGEX.test(v)) { setNameError("Only letters, numbers, -, _ and ."); return false; }
    setNameError("");
    return true;
  };

  const saveCombo = async (patch) => {
    try {
      const res = await fetch(`/api/combos/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        reportClientError(err.error || "Failed to save combo");
        return false;
      }
      return true;
    } catch (e) {
      reportClientError("Failed to save combo:", e?.message || e);
      return false;
    }
  };

  const handleSaveName = async () => {
    if (!validateName(name)) return;
    if (name === combo.name) return;
    const prevName = combo.name;
    const ok = await saveCombo({ name });
    if (!ok) return;
    // Round-robin strategies are keyed by combo name — move the entry so a
    // rename doesn't orphan it (stale key would apply to nothing).
    try {
      const settingsRes = await fetch("/api/settings", { cache: "no-store" });
      if (settingsRes.ok) {
        const s = await settingsRes.json();
        const strategies = s.comboStrategies || {};
        if (strategies[prevName]) {
          const updated = { ...strategies };
          updated[name] = updated[prevName];
          delete updated[prevName];
          const res = await fetch("/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ comboStrategies: updated }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
      }
    } catch (e) {
      reportClientError("Failed to migrate round-robin setting:", e?.message || e);
    }
    await fetchAll();
  };

  const commitModels = async (next) => {
    const prev = providers;
    setProviders(next);
    // Revert the optimistic edit when the server rejects it
    if (!await saveCombo({ models: next })) setProviders(prev);
  };

  const handleAddModel = async (model) => {
    const value = model?.value || model;
    if (!value || providers.includes(value)) return;
    await commitModels([...providers, value]);
  };

  const handleDeselectModel = async (model) => {
    const value = model?.value || model;
    if (!value || !providers.includes(value)) return;
    await commitModels(providers.filter((p) => p !== value));
  };

  const handleRemoveProvider = async (idx) => {
    await commitModels(providers.filter((_, i) => i !== idx));
  };

  const handleMove = async (idx, dir) => {
    const next = [...providers];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    await commitModels(next);
  };

  const handleToggleRoundRobin = async (enabled) => {
    setRoundRobin(enabled);
    try {
      const settingsRes = await fetch("/api/settings", { cache: "no-store" });
      if (!settingsRes.ok) throw new Error(`HTTP ${settingsRes.status}`);
      const s = await settingsRes.json();
      const updated = { ...(s.comboStrategies || {}) };
      if (enabled) updated[combo.name] = { fallbackStrategy: "round-robin" };
      else delete updated[combo.name];
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategies: updated }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      // Failed toggles must not look saved — undo the optimistic flip
      setRoundRobin(!enabled);
      reportClientError("Failed to save round-robin setting:", e?.message || e);
    }
  };

  const handleDelete = async () => {
    if (!await requestConfirmation({ message: `Delete combo "${combo.name?.trim() || id}"?`, confirmText: "Continue" })) return;
    try {
      await fetchJson(`/api/combos/${encodeURIComponent(id)}`, { method: "DELETE" });
      router.push(getListingHref(combo.kind));
    } catch (error) {
      reportClientError("Error deleting combo:", error);
    }
  };

  const handleTest = async () => {
    if (!apiKey.trim()) {
      setTestError("Paste a client key secret before running this example.");
      return;
    }
    setTesting(true);
    setTestResult(null);
    setTestError("");
    if (testResult?.audioUrl) { try { URL.revokeObjectURL(testResult.audioUrl); } catch {} }
    if (testResult?.imageUrl?.startsWith("blob:")) { try { URL.revokeObjectURL(testResult.imageUrl); } catch {} }
    const start = Date.now();
    try {
      const path = EXAMPLE_PATHS[combo.kind];
      const body = EXAMPLE_BODIES[combo.kind](combo.name);
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch(`/api${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        const errMsg = d?.error?.message || d?.error;
        setTestError(typeof errMsg === "string" && errMsg ? errMsg : `HTTP ${res.status}`);
        setTestResult({ json: JSON.stringify(d, null, 2), latencyMs });
        return;
      }
      const ctype = res.headers.get("content-type") || "";
      // Binary image
      if (ctype.startsWith("image/")) {
        const blob = await res.blob();
        setTestResult({ imageUrl: URL.createObjectURL(blob), latencyMs });
        return;
      }
      // Binary audio
      if (ctype.startsWith("audio/") || ctype === "application/octet-stream") {
        const blob = await res.blob();
        setTestResult({ audioUrl: URL.createObjectURL(blob), latencyMs });
        return;
      }
      // JSON — could be image (data[0].b64_json/url) or generic
      const data = await res.json();
      const first = data?.data?.[0];
      const imageUrl = first?.b64_json
        ? `data:image/png;base64,${first.b64_json}`
        : (first?.url || "");
      setTestResult({ json: JSON.stringify(maskB64(data), null, 2), imageUrl, latencyMs });
    } catch (e) {
      setTestError(e.message || "Network error");
    } finally {
      // Early returns above must still release the Run button
      setTesting(false);
    }
  };

  // Mask large b64_json strings to keep JSON view readable
  function maskB64(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(maskB64);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = (k === "b64_json" && typeof v === "string" && v.length > 100)
        ? `<${v.length} chars base64>`
        : maskB64(v);
    }
    return out;
  }

  if (loading) return <div className="text-text-muted text-sm">Loading...</div>;
  if (!combo) return notFound();

  const kindLabel = KIND_LABELS[combo.kind] || MEDIA_PROVIDER_KINDS.find((k) => k.id === combo.kind)?.label || "Combo";
  const examplePath = EXAMPLE_PATHS[combo.kind];
  const exampleBody = combo.kind && EXAMPLE_BODIES[combo.kind] ? EXAMPLE_BODIES[combo.kind](combo.name) : null;
  const curlExample = examplePath
    ? `curl -X POST http://localhost:20128${examplePath} \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${apiKey || "YOUR_KEY"}" \\\n  -d '${JSON.stringify(exampleBody)}'`
    : "";
  const backHref = getListingHref(combo.kind);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={backHref} className="text-text-muted hover:text-primary">
            <span className="material-symbols-outlined">arrow_back</span>
          </Link>
          <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-primary">layers</span>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-text-muted">{kindLabel} Combo</p>
            <code className="text-lg font-semibold font-mono">{combo.name}</code>
          </div>
        </div>
        <Button variant="outline" icon="delete" onClick={handleDelete} className="text-red-500 border-red-200 hover:bg-red-50">
          Delete
        </Button>
      </div>

      {/* Settings Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-3">Settings</h2>
        <div className="flex flex-col gap-4">
          <div>
            <Input label="Combo Name" value={name} onChange={(e) => { setName(e.target.value); validateName(e.target.value); }} onBlur={handleSaveName} error={nameError} />
            <p className="text-[10px] text-text-muted mt-0.5">Only letters, numbers, -, _ and .</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Round Robin</p>
              <p className="text-xs text-text-muted">Rotate providers across requests instead of strict fallback order.</p>
            </div>
            <Toggle checked={roundRobin} onChange={handleToggleRoundRobin} />
          </div>
        </div>
      </Card>

      {/* Providers Card */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold">Providers</h2>
            <p className="text-xs text-text-muted">Tried in order (top-down) or rotated when round-robin is on.</p>
          </div>
          <Button size="sm" icon="add" onClick={() => setShowPicker(true)}>Add Provider</Button>
        </div>
        {providers.length === 0 ? (
          <div className="text-center py-6 border border-dashed border-border rounded-lg text-text-muted text-sm">
            No providers yet.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {providers.map((entry, idx) => {
              const { providerId, model } = parseModelEntry(entry);
              const p = AI_PROVIDERS[providerId];
              return (
                <div key={`${entry}-${idx}`} className="flex items-center gap-3 p-2 rounded-lg bg-black/[0.02] dark:bg-white/[0.02]">
                  <span className="text-xs text-text-muted w-5 text-center">{idx + 1}</span>
                  <ProviderIcon
                    src={`/providers/${providerId}.png`}
                    alt={p?.name || providerId}
                    size={24}
                    className="object-contain rounded shrink-0"
                    fallbackText={p?.textIcon || providerId.slice(0, 2).toUpperCase()}
                    fallbackColor={p?.color}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{p?.name || providerId}</div>
                    {model && <code className="text-[10px] text-text-muted font-mono truncate block">{model}</code>}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button onClick={() => handleMove(idx, -1)} disabled={idx === 0} className={`p-1 rounded ${idx === 0 ? "text-text-muted/20" : "text-text-muted hover:text-primary hover:bg-black/5"}`} aria-label={`Move ${p?.name || providerId} up`} title="Move up">
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_upward</span>
                    </button>
                    <button onClick={() => handleMove(idx, 1)} disabled={idx === providers.length - 1} className={`p-1 rounded ${idx === providers.length - 1 ? "text-text-muted/20" : "text-text-muted hover:text-primary hover:bg-black/5"}`} aria-label={`Move ${p?.name || providerId} down`} title="Move down">
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_downward</span>
                    </button>
                    <button onClick={() => handleRemoveProvider(idx)} className="p-1 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10" aria-label={`Remove ${p?.name || providerId}`} title="Remove">
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Test Example Card */}
      {combo.kind && examplePath && (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
            <h2 className="text-lg font-semibold">Test Example</h2>
            <Button size="sm" icon="play_arrow" onClick={handleTest} disabled={testing || providers.length === 0 || !apiKey.trim()}>
              {testing ? "Running..." : "Run"}
            </Button>
          </div>
          {/* API Key — user-entered client key secret; never hydrated from key lists */}
          <div className="mb-3">
            <Input
              id="combo-example-key"
              label="Client Key Secret"
              type="password"
              autoComplete="off"
              placeholder="Paste a Switchboard client key secret (sk-...)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              hint="Run uses this key as the Authorization bearer for the local gateway endpoint."
            />
          </div>
          <pre className="text-xs font-mono bg-black/[0.03] dark:bg-white/[0.03] p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all">
            {curlExample}
          </pre>
          {testError && (
            <p role="alert" className="mt-3 text-xs text-red-500 break-words">{testError}</p>
          )}
          {testResult && (
            <div className="mt-3 flex flex-col gap-3">
              {testResult.latencyMs != null && (
                <span className="text-[11px] text-text-muted">⚡ {testResult.latencyMs}ms</span>
              )}
              {testResult.imageUrl && (
                <div>
                  <div className="flex items-center justify-end mb-1.5">
                    <a href={testResult.imageUrl} download="image.png" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors">
                      <span className="material-symbols-outlined text-[14px]">download</span>
                      Download
                    </a>
                  </div>
                  <Image src={testResult.imageUrl} alt="Generated" width={1024} height={1024} unoptimized className="max-w-full rounded-lg border border-border" />
                </div>
              )}
              {testResult.audioUrl && (
                <div>
                  <div className="flex items-center justify-end mb-1.5">
                    <a href={testResult.audioUrl} download="speech.mp3" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-primary transition-colors">
                      <span className="material-symbols-outlined text-[14px]">download</span>
                      Download
                    </a>
                  </div>
                  <audio controls src={testResult.audioUrl} className="w-full" />
                </div>
              )}
              {testResult.json && (
                <pre className="text-xs font-mono bg-black/[0.03] dark:bg-white/[0.03] p-3 rounded-lg overflow-auto max-h-[300px] whitespace-pre-wrap break-all">
                  {testResult.json}
                </pre>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Usage Logs Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-3">Usage Logs</h2>
        {logs.length === 0 ? (
          <p className="text-xs text-text-muted italic">No usage yet.</p>
        ) : (
          <pre className="text-[11px] font-mono bg-black/[0.03] dark:bg-white/[0.03] p-3 rounded-lg overflow-auto max-h-[400px] whitespace-pre-wrap">
            {logs.join("\n")}
          </pre>
        )}
      </Card>

      <ModelSelectModal
        isOpen={showPicker}
        onClose={() => setShowPicker(false)}
        onSelect={handleAddModel}
        onDeselect={handleDeselectModel}
        activeProviders={connections}
        modelAliases={modelAliases}
        title={`Add ${kindLabel} Model`}
        kindFilter={combo.kind}
        addedModelValues={providers}
        closeOnSelect={false}
      />
    </div>
  );
}
