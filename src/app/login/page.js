"use client";
// @ts-check

import { useState } from "react";
import { Button, Card, Input } from "@/shared/components";
import { translate } from "@/i18n/runtime";

/**
 * Remote sign-in: exchange a gateway API key for a dashboard session cookie.
 * Local (loopback) peers never see this page — the middleware redirects them
 * straight to /dashboard.
 */
export default function LoginPage() {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        window.location.href = "/dashboard";
        return;
      }
      setError(data.error || translate("Login failed"));
    } catch {
      setError(translate("Network error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-1 px-4">
      <Card className="w-full max-w-sm">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Switchboard</h1>
            <p className="mt-1 text-sm text-text-muted">
              You&apos;re accessing the dashboard from another device. Sign in with a
              gateway API key to continue.
            </p>
          </div>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Gateway API key"
            autoComplete="current-password"
            autoFocus
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <Button type="submit" disabled={busy || !apiKey.trim()}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          <p className="text-xs text-text-muted">
            Keys are listed on the dashboard&apos;s Endpoint page. The session lasts 7 days.
          </p>
        </form>
      </Card>
    </div>
  );
}
