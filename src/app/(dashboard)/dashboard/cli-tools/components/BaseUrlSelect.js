"use client";
// @ts-check

import { useEffect, useMemo, useRef, useState } from "react";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { deletePreset, readPresets, subscribePresets, upsertPreset } from "./cliEndpointPresets";

const CUSTOM_VALUE = "__custom__";
const SAVE_VALUE = "__save__";

const ensureV1 = (url) => {
  const trimmed = (url || "").replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
};

const buildOptions = ({ requiresExternalUrl, savedPresets, withV1 }) => {
  const opts = [];
  const wrap = (url) => (withV1 ? ensureV1(url) : (url || "").replace(/\/+$/, ""));
  // Local-only product: always offer loopback. requiresExternalUrl no longer forces a remote URL.
  const localUrl = wrap(`http://127.0.0.1:${UPDATER_CONFIG.appPort}`);
  opts.push({ value: "local", label: localUrl, url: localUrl });
  if (typeof window !== "undefined" && window.location?.origin) {
    const originUrl = wrap(window.location.origin);
    if (originUrl !== localUrl) {
      opts.push({ value: "origin", label: originUrl, url: originUrl });
    }
  }
  savedPresets.forEach((p) => {
    opts.push({ value: `saved:${p.name}`, label: p.baseUrl, url: p.baseUrl, saved: true });
  });
  opts.push({ value: CUSTOM_VALUE, label: "Custom URL...", url: "" });
  return opts;
};

export default function BaseUrlSelect({
  value,
  onChange,
  initialUrl = "",
  requiresExternalUrl = false, // kept for call-site compatibility; ignored
  tunnelEnabled = false,
  tunnelPublicUrl = "",
  tailscaleEnabled = false,
  tailscaleUrl = "",
  cloudEnabled = false,
  cloudUrl = "",
  withV1 = true,
}) {
  const [savedPresets, setSavedPresets] = useState([]);
  const [mode, setMode] = useState("");
  const [customInput, setCustomInput] = useState("");
  const initializedRef = useRef(false);

  useEffect(() => {
    const sync = () => setSavedPresets(readPresets());
    sync();
    return subscribePresets(sync);
  }, []);

  const options = useMemo(
    () => buildOptions({ requiresExternalUrl, savedPresets, withV1 }),
    [requiresExternalUrl, savedPresets, withV1]
  );

  // Initialize from the server-configured endpoint when one is provided;
  // otherwise default to the first option (127.0.0.1). Never re-run after mount.
  useEffect(() => {
    if (initializedRef.current) return;
    if (options.length === 0) return;
    initializedRef.current = true;
    const normalize = (url) => (withV1 ? ensureV1(url) : (url || "").replace(/\/+$/, ""));
    const initial = (initialUrl || "").trim();
    const match = initial && options.find((o) => o.value !== CUSTOM_VALUE && o.url === normalize(initial));
    if (match) {
      setMode(match.value);
      onChange(match.url);
      return;
    }
    if (initial) {
      // Server URL that is not one of the presets: keep it in custom mode
      // instead of silently repointing the tool at localhost.
      setMode(CUSTOM_VALUE);
      setCustomInput(initial);
      onChange(normalize(initial));
      return;
    }
    const first = options.find((o) => o.value !== CUSTOM_VALUE);
    if (first) {
      setMode(first.value);
      onChange(first.url);
    } else {
      setMode(CUSTOM_VALUE);
    }
  }, [options, onChange, initialUrl, withV1]);

  const handleSelect = (e) => {
    const next = e.target.value;
    if (next === SAVE_VALUE) {
      const trimmed = (value || "").trim();
      if (!trimmed) return;
      let defaultName = trimmed;
      try { defaultName = new URL(trimmed).host; } catch {}
      const name = window.prompt("Save endpoint as:", defaultName);
      if (!name?.trim()) return;
      setSavedPresets(upsertPreset(name.trim(), trimmed));
      setMode(`saved:${name.trim()}`);
      return;
    }
    setMode(next);
    if (next === CUSTOM_VALUE) {
      setCustomInput("");
      onChange("");
      return;
    }
    const opt = options.find((o) => o.value === next);
    if (opt) onChange(opt.url);
  };

  const handleCustomInput = (e) => {
    const v = e.target.value;
    setCustomInput(v);
    onChange(v);
  };

  const handleDeleteSaved = () => {
    if (!mode.startsWith("saved:")) return;
    const name = mode.slice(6);
    const updated = deletePreset(name);
    setSavedPresets(updated);
    // Fall back to the first built-in option instead of clearing the field.
    const fallback = buildOptions({ requiresExternalUrl, savedPresets: updated, withV1 })
      .find((o) => o.value !== CUSTOM_VALUE);
    if (fallback) {
      setMode(fallback.value);
      onChange(fallback.url);
    } else {
      setMode(CUSTOM_VALUE);
      setCustomInput("");
      onChange("");
    }
  };

  const isSaved = mode.startsWith("saved:");
  const isCustom = mode === CUSTOM_VALUE;
  const canSave = isCustom && (customInput || "").trim().length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <select
          value={mode}
          onChange={handleSelect}
          aria-label="Select Endpoint"
          className="flex-1 min-w-0 px-2 py-2 bg-surface rounded text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          {canSave && <option value={SAVE_VALUE}>+ Save current as...</option>}
        </select>
        {isSaved && (
          <button type="button" onClick={handleDeleteSaved} className="p-1 text-text-muted hover:text-red-500 rounded transition-colors shrink-0" title="Delete saved endpoint">
            <span className="material-symbols-outlined text-[14px]">delete</span>
          </button>
        )}
      </div>
      {isCustom && (
        <input
          type="text"
          value={customInput}
          onChange={handleCustomInput}
          placeholder={withV1 ? "https://example.com/v1" : "https://example.com"}
          className="w-full min-w-0 px-2 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
        />
      )}
    </div>
  );
}
