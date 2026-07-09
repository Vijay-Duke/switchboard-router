"use client";
// @ts-check

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Badge, Button, Input, Modal, Select } from "@/shared/components";

const VARIANT_CONFIG = {
  openai: {
    title: "Add OpenAI Compatible",
    type: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    namePlaceholder: "My LiteLLM / OpenRouter / vLLM",
    baseUrlHint: "Base URL ending in /v1 for your OpenAI-compatible API.",
    modelIdPlaceholder: "e.g. gpt-4, claude-3-opus",
    errorLabel: "OpenAI Compatible",
    hasApiType: true,
  },
  anthropic: {
    title: "Add Anthropic Compatible",
    type: "anthropic-compatible",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    namePlaceholder: "My Claude proxy",
    baseUrlHint: "Base URL ending in /v1. /messages is appended automatically.",
    modelIdPlaceholder: "e.g. claude-3-opus",
    errorLabel: "Anthropic Compatible",
    hasApiType: false,
  },
};

const API_TYPE_OPTIONS = [
  { value: "chat", label: "Chat Completions" },
  { value: "responses", label: "Responses API" },
];

function AddCompatibleModal({ variant, isOpen, onClose, onCreated }) {
  const config = VARIANT_CONFIG[variant];
  const initialFormData = () => ({
    name: "",
    ...(config.hasApiType ? { apiType: "chat" } : {}),
    baseUrl: config.defaultBaseUrl,
  });

  const [formData, setFormData] = useState(initialFormData);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [checkKey, setCheckKey] = useState("");
  const [checkModelId, setCheckModelId] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setFormData(initialFormData());
    setError("");
    setCheckKey("");
    setCheckModelId("");
    setValidationResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, variant]);

  useEffect(() => {
    if (config.hasApiType && isOpen) {
      setFormData((prev) => ({ ...prev, baseUrl: config.defaultBaseUrl }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.apiType]);

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.baseUrl.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/provider-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name.trim(),
          ...(config.hasApiType ? { apiType: formData.apiType } : {}),
          baseUrl: formData.baseUrl.trim(),
          type: config.type,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        onCreated(data.node);
        setFormData(initialFormData());
        setCheckKey("");
        setValidationResult(null);
      } else {
        setError(data.error || "Failed to create provider");
      }
    } catch (err) {
      console.log(`Error creating ${config.errorLabel} node:`, err);
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: formData.baseUrl,
          apiKey: checkKey,
          type: config.type,
          modelId: checkModelId.trim() || undefined,
        }),
      });
      const data = await res.json();
      setValidationResult(data);
    } catch {
      setValidationResult({ valid: false, error: "Network error" });
    } finally {
      setValidating(false);
    }
  };

  const renderValidationResult = () => {
    if (!validationResult) return null;
    const { valid, error: vError, method } = validationResult;
    if (valid) {
      return (
        <>
          <Badge variant="success">Valid</Badge>
          {method === "chat" && (
            <span className="text-sm text-text-muted">(via inference test)</span>
          )}
        </>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="error">Invalid</Badge>
        {vError && <span className="text-sm text-red-500">{vError}</span>}
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} title={config.title} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={config.namePlaceholder}
          hint="Friendly label (e.g. Work LiteLLM)."
        />
        {config.hasApiType && (
          <Select
            label="API Type"
            options={API_TYPE_OPTIONS}
            value={formData.apiType}
            onChange={(e) => setFormData({ ...formData, apiType: e.target.value })}
          />
        )}
        <Input
          label="Base URL"
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={config.defaultBaseUrl}
          hint={config.baseUrlHint}
        />
        <Input
          label="API Key (for Check)"
          type="password"
          value={checkKey}
          onChange={(e) => setCheckKey(e.target.value)}
        />
        <Input
          label="Model ID (optional)"
          value={checkModelId}
          onChange={(e) => setCheckModelId(e.target.value)}
          placeholder={config.modelIdPlaceholder}
          hint="If the provider has no /models endpoint, enter a model ID to test chat/completions."
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            onClick={handleValidate}
            disabled={!checkKey || validating || !formData.baseUrl.trim()}
            variant="secondary"
            className="w-full sm:w-auto"
          >
            {validating ? "Checking..." : "Check"}
          </Button>
          {renderValidationResult()}
        </div>
        {error ? <p className="text-sm text-red-500">{error}</p> : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            onClick={handleSubmit}
            fullWidth
            disabled={!formData.name.trim() || !formData.baseUrl.trim() || submitting}
          >
            {submitting ? "Creating..." : "Create"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AddCompatibleModal.propTypes = {
  variant: PropTypes.oneOf(["openai", "anthropic"]).isRequired,
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreated: PropTypes.func.isRequired,
};

export default AddCompatibleModal;
