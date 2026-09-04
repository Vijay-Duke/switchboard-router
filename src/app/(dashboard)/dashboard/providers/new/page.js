"use client";
// @ts-check

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, Button, Input, Select, Toggle } from "@/shared/components";
import { AI_PROVIDERS, AUTH_METHODS } from "@/shared/constants/config";

const providerOptions = Object.values(AI_PROVIDERS).map((p) => ({
  value: p.id,
  label: p.name,
}));

const authMethodOptions = Object.values(AUTH_METHODS).map((m) => ({
  value: m.id,
  label: m.name,
}));

/**
 * Pure client-side validation for the new-provider form, exported for tests.
 * The cookie method binds the same `apiKey` field as apikey, so both methods
 * require a non-blank credential.
 */
export function validateProviderForm(formData) {
  const newErrors = {};
  if (!formData.provider) newErrors.provider = "Please select a provider";
  if (
    (formData.authMethod === "apikey" || formData.authMethod === "cookie") &&
    !formData.apiKey.trim()
  ) {
    newErrors.apiKey = "API Key is required";
  }
  return newErrors;
}

export default function NewProviderPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    provider: "",
    authMethod: "apikey",
    apiKey: "",
    displayName: "",
    isActive: true,
  });
  const [errors, setErrors] = useState({});

  const handleChange = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: null }));
    }
  };

  const validate = () => {
    const newErrors = validateProviderForm(formData);
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...formData, apiKey: formData.apiKey.trim() }),
      });

      if (response.ok) {
        router.push("/dashboard/providers");
      } else {
        const data = await response.json();
        setErrors({ submit: data.error || "Failed to create provider" });
      }
    } catch (error) {
      setErrors({ submit: "An error occurred. Please try again." });
    } finally {
      setLoading(false);
    }
  };

  const selectedProvider = AI_PROVIDERS[formData.provider];

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <Link
          href="/dashboard/providers"
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors mb-4"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          Back to Providers
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Add New Provider</h1>
        <p className="text-text-muted mt-2">
          Configure a new AI provider to use with your applications.
        </p>
      </div>

      {/* Form */}
      <Card>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Provider Selection */}
          <Select
            label="Provider"
            options={providerOptions}
            value={formData.provider}
            onChange={(e) => handleChange("provider", e.target.value)}
            placeholder="Select a provider"
            error={errors.provider}
            required
          />

          {/* Provider Info */}
          {selectedProvider && (
            <Card.Section className="flex items-center gap-3">
              <div
                className="size-10 rounded-lg flex items-center justify-center bg-bg border border-border"
              >
                <span
                  className="material-symbols-outlined text-xl"
                  style={{ color: selectedProvider.color }}
                >
                  {selectedProvider.icon}
                </span>
              </div>
              <div>
                <p className="font-medium">{selectedProvider.name}</p>
                <p className="text-sm text-text-muted">
                  Selected provider
                </p>
              </div>
            </Card.Section>
          )}

          {/* Auth Method */}
          <div className="flex flex-col gap-3">
            <span id="new-provider-auth-method-label" className="text-sm font-medium">
              Authentication Method <span className="text-red-500" aria-hidden="true">*</span>
            </span>
            <div className="flex gap-3" role="radiogroup" aria-labelledby="new-provider-auth-method-label">
              {authMethodOptions.map((method) => (
                <button
                  key={method.value}
                  type="button"
                  role="radio"
                  aria-checked={formData.authMethod === method.value}
                  onClick={() => handleChange("authMethod", method.value)}
                  className={`flex-1 flex items-center justify-center gap-2 p-4 rounded-lg border transition-all ${
                    formData.authMethod === method.value
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">
                    {method.value === "apikey" ? "key" : method.value === "cookie" ? "cookie" : "lock"}
                  </span>
                  <span className="font-medium">{method.label}</span>
                </button>
              ))}
            </div>
          </div>
          {formData.authMethod === "apikey" && (
            <Input
              label="API Key"
              type="password"
              autoComplete="off"
              placeholder="Enter your API key"
              value={formData.apiKey}
              onChange={(e) => handleChange("apiKey", e.target.value)}
              error={errors.apiKey}
              hint={
                selectedProvider?.notice?.apiKeyUrl ? (
                  <span>
                    Your key is encrypted and stored locally.{" "}
                    <a
                      href={selectedProvider.notice.apiKeyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-0.5"
                    >
                      Get API Key <span className="material-symbols-outlined text-xs">open_in_new</span>
                    </a>
                  </span>
                ) : (
                  "Your API key will be encrypted and stored securely."
                )
              }
              required
            />
          )}

          {formData.authMethod === "cookie" && (
            <Input
              label="Session Cookie / Token"
              type="password"
              autoComplete="off"
              placeholder="Paste your session cookie or token"
              value={formData.apiKey}
              onChange={(e) => handleChange("apiKey", e.target.value)}
              error={errors.apiKey}
              hint="Your cookie credential will be encrypted and stored securely."
              required
            />
          )}

          {formData.authMethod === "oauth" && (
            <div className="p-4 rounded-lg bg-surface-2 border border-border text-sm text-text-muted flex items-start gap-3">
              <span className="material-symbols-outlined text-primary text-lg mt-0.5">lock_open</span>
              <div className="flex-1">
                <p className="font-medium text-text-main">OAuth Authentication</p>
                <p className="text-xs text-text-muted mt-0.5">
                  OAuth authorization for {selectedProvider?.name || "this provider"} will launch via official browser sign-in on the Provider Settings page.
                </p>
              </div>
            </div>
          )}

          {/* Display Name */}
          <Input
            label="Display Name"
            placeholder="e.g., Production API, Dev Environment"
            value={formData.displayName}
            onChange={(e) => handleChange("displayName", e.target.value)}
            hint="Optional. A friendly name to identify this configuration."
          />

          {/* Active Toggle */}
          <Toggle
            checked={formData.isActive}
            onChange={(checked) => handleChange("isActive", checked)}
            label="Active"
            description="Enable this provider for use in your applications"
          />

          {/* Error Message */}
          {errors.submit && (
            <div role="alert" className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
              {errors.submit}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t border-border">
            <Link href="/dashboard/providers" className="flex-1">
              <Button type="button" variant="ghost" fullWidth>
                Cancel
              </Button>
            </Link>
            <Button type="submit" loading={loading} fullWidth className="flex-1">
              Create Provider
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
