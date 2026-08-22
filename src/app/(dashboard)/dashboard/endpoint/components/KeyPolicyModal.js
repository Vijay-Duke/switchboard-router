"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal, Toggle } from "@/shared/components";

function lines(value) {
  return String(value || "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function optionalNumber(value) {
  return value === "" ? null : Number(value);
}

function localDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function KeyPolicyModal({ apiKey, isOpen, isSaving, onClose, onSave }) {
  const [name, setName] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [allowedModels, setAllowedModels] = useState("");
  const [allowedCombos, setAllowedCombos] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [rateLimitPerMinute, setRateLimitPerMinute] = useState("");
  const [concurrencyLimit, setConcurrencyLimit] = useState("");
  const [spendLimitUsd, setSpendLimitUsd] = useState("");

  useEffect(() => {
    if (!isOpen || !apiKey) return;
    setName(apiKey.name || "");
    setIsActive(apiKey.isActive !== false);
    setAllowedModels((apiKey.allowedModels || []).join("\n"));
    setAllowedCombos((apiKey.allowedCombos || []).join("\n"));
    setExpiresAt(localDateTime(apiKey.expiresAt));
    setRateLimitPerMinute(apiKey.rateLimitPerMinute ?? "");
    setConcurrencyLimit(apiKey.concurrencyLimit ?? "");
    setSpendLimitUsd(apiKey.spendLimitUsd ?? "");
  }, [apiKey, isOpen]);

  const save = () => onSave({
    name,
    isActive,
    allowedModels: lines(allowedModels),
    allowedCombos: lines(allowedCombos),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    rateLimitPerMinute: optionalNumber(rateLimitPerMinute),
    concurrencyLimit: optionalNumber(concurrencyLimit),
    spendLimitUsd: optionalNumber(spendLimitUsd),
  });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit API Key Policy" size="lg">
      <div className="flex flex-col gap-4">
        <Input label="Key name" value={name} onChange={(event) => setName(event.target.value)} />
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">Active</p>
            <p className="text-xs text-text-muted">Paused keys cannot authenticate.</p>
          </div>
          <Toggle checked={isActive} onChange={setIsActive} />
        </div>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Allowed model IDs
          <textarea
            className="min-h-24 rounded-lg border border-border bg-surface-2 p-3 font-mono text-sm"
            value={allowedModels}
            onChange={(event) => setAllowedModels(event.target.value)}
            placeholder="openai/gpt-5\nanthropic/claude-sonnet"
          />
          <span className="text-xs font-normal text-text-muted">One exact model ID per line. Empty allows all targets.</span>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Allowed combo names
          <textarea
            className="min-h-20 rounded-lg border border-border bg-surface-2 p-3 font-mono text-sm"
            value={allowedCombos}
            onChange={(event) => setAllowedCombos(event.target.value)}
            placeholder="fast\nquality"
          />
          <span className="text-xs font-normal text-text-muted">One exact combo name per line.</span>
        </label>
        <Input label="Expires at" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input label="Requests / minute" type="number" min="1" step="1" value={rateLimitPerMinute} onChange={(event) => setRateLimitPerMinute(event.target.value)} />
          <Input label="Concurrent requests" type="number" min="1" step="1" value={concurrencyLimit} onChange={(event) => setConcurrencyLimit(event.target.value)} />
          <Input label="Spend ceiling (USD)" type="number" min="0" step="0.01" value={spendLimitUsd} onChange={(event) => setSpendLimitUsd(event.target.value)} />
        </div>
        <p className="text-sm text-text-muted">
          Current spend: <span className="font-mono text-text-main">${Number(apiKey?.spentUsd || 0).toFixed(4)}</span>
        </p>
        <div className="flex gap-2">
          <Button fullWidth loading={isSaving} disabled={isSaving || !name.trim()} onClick={save}>Save policy</Button>
          <Button fullWidth variant="ghost" disabled={isSaving} onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

KeyPolicyModal.propTypes = {
  apiKey: PropTypes.object,
  isOpen: PropTypes.bool.isRequired,
  isSaving: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSave: PropTypes.func.isRequired,
};
