"use client";
// @ts-check

import { useEffect, useMemo, useState } from "react";

import { deletePreset, readPresets, subscribePresets, upsertPreset } from "./cliEndpointPresets";

export default function EndpointPresetControl({
  baseUrl,
  onBaseUrlChange,
}) {
  const [presets, setPresets] = useState([]);
  const [selectedName, setSelectedName] = useState("");

  useEffect(() => {
    const sync = () => setPresets(readPresets());
    sync();
    return subscribePresets(sync);
  }, []);

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.name === selectedName) || null,
    [presets, selectedName]
  );

  const handleSelect = (name) => {
    setSelectedName(name);
    const preset = presets.find((item) => item.name === name);
    if (!preset) return;
    onBaseUrlChange(preset.baseUrl);
  };

  const handleSave = () => {
    const trimmedBaseUrl = (baseUrl || "").trim();
    if (!trimmedBaseUrl) return;

    let defaultName = trimmedBaseUrl;
    try {
      defaultName = new URL(trimmedBaseUrl).host;
    } catch {
      defaultName = trimmedBaseUrl;
    }
    const name = window.prompt("Preset name", selectedPreset?.name || defaultName);
    if (!name?.trim()) return;

    setPresets(upsertPreset(name.trim(), trimmedBaseUrl));
    setSelectedName(name.trim());
  };

  const handleDelete = () => {
    if (!selectedPreset) return;
    setPresets(deletePreset(selectedPreset.name));
    setSelectedName("");
  };

  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 text-sm font-semibold text-text-main text-right">Preset</span>
      <span className="material-symbols-outlined text-text-muted text-[14px]">arrow_forward</span>
      <select
        value={selectedName}
        onChange={(event) => handleSelect(event.target.value)}
        className="flex-1 px-2 py-1.5 bg-surface rounded text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary/50"
      >
        <option value="">Manual / current endpoint</option>
        {presets.map((preset) => (
          <option key={preset.name} value={preset.name}>
            {preset.name} - {preset.baseUrl}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={handleSave}
        disabled={!baseUrl}
        className="px-2 py-1.5 rounded border text-xs bg-surface border-border text-text-main hover:border-primary disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        title="Save the current Base URL as a browser-local preset"
      >
        Save
      </button>
      {selectedPreset && (
        <button
          type="button"
          onClick={handleDelete}
          className="p-1 text-text-muted hover:text-red-500 rounded transition-colors"
          title="Delete selected preset"
        >
          <span className="material-symbols-outlined text-[14px]">delete</span>
        </button>
      )}
    </div>
  );
}
