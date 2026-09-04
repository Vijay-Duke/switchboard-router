"use client";
// @ts-check

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CardSkeleton } from "@/shared/components";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { isAnthropicCompatibleProvider, isOpenAICompatibleProvider, resolveProviderId } from "@/shared/constants/providers";
import {
  ClaudeToolCard, CodexToolCard, DroidToolCard, OpenClawToolCard,
  HermesToolCard, DefaultToolCard, OpenCodeToolCard, CoworkToolCard,
  ClineToolCard, KiloToolCard, DeepSeekTuiToolCard,
  JcodeToolCard, GrokToolCard, PiToolCard, AiderToolCard, GeminiCliToolCard,
} from "../components";
import { reportClientError } from "@/shared/utils/clientFeedback";


export default function ToolDetailClient({ toolId, machineId }) {
  const tool = CLI_TOOLS[toolId];
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [cloudSettings, setCloudSettings] = useState({});
  const [modelMappings, setModelMappings] = useState({});
  const [apiKeys, setApiKeys] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const [provRes, keysRes, settingsRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/keys"),
          fetch("/api/settings"),
        ]);
        if (!mounted) return;
        if (!provRes.ok) {
          const data = await provRes.json().catch(() => ({}));
          throw new Error(data.error || `Failed to load providers (${provRes.status})`);
        }
        setConnections((await provRes.json()).connections || []);
        if (keysRes.ok) {
          const data = await keysRes.json();
          setApiKeys(data.keys || []);
        }
        if (settingsRes.ok) {
          setCloudSettings(await settingsRes.json());
        }
      } catch (error) {
        reportClientError("Error loading tool data:", error);
        if (mounted) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [reloadKey]);

  const getActiveProviders = () => connections
    .filter((c) => c.isActive !== false)
    .map((connection) => ({
      ...connection,
      provider: resolveProviderId(connection.provider),
    }));

  const getAllAvailableModels = () => {
    const activeProviders = getActiveProviders();
    const models = [];
    const seenModels = new Set();
    activeProviders.forEach((conn) => {
      const providerId = resolveProviderId(conn.provider);
      const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const providerModels = getModelsByProviderId(providerId);
      providerModels.forEach((m) => {
        const modelValue = `${alias}/${m.id}`;
        if (!seenModels.has(modelValue)) {
          seenModels.add(modelValue);
          models.push({ value: modelValue, label: `${alias}/${m.id}`, provider: providerId, alias, connectionName: conn.name, modelId: m.id });
        }
      });
    });
    return models;
  };

  const handleModelMappingChange = useCallback((tId, alias, target) => {
    setModelMappings((prev) => {
      if (prev[tId]?.[alias] === target) return prev;
      return { ...prev, [tId]: { ...prev[tId], [alias]: target } };
    });
  }, []);

  const getBaseUrl = () => {
    if (typeof window !== "undefined") return window.location.origin;
    return "http://localhost:20128";
  };

  const renderToolCard = () => {
    const availableModels = getAllAvailableModels();
    // Static-catalog models OR any live openai/anthropic-compatible connection:
    // compatible providers serve arbitrary models that never appear in the catalog.
    const hasActiveProviders = availableModels.length > 0
      || getActiveProviders().some((conn) => (
        isOpenAICompatibleProvider(conn.provider) || isAnthropicCompatibleProvider(conn.provider)
      ));
    const commonProps = {
      tool,
      isExpanded: true,
      onToggle: () => {},
      baseUrl: getBaseUrl(),
      apiKeys,
      tunnelEnabled: Boolean(cloudSettings.tunnelPublicUrl),
      tunnelPublicUrl: cloudSettings.tunnelPublicUrl || "",
      tailscaleEnabled: Boolean(cloudSettings.tailscaleUrl),
      tailscaleUrl: cloudSettings.tailscaleUrl || "",
      cloudEnabled: Boolean(cloudSettings.cloudEnabled),
    };

    switch (toolId) {
      case "claude":
        return <ClaudeToolCard {...commonProps} activeProviders={getActiveProviders()} modelMappings={modelMappings[toolId] || {}} onModelMappingChange={(a, t) => handleModelMappingChange(toolId, a, t)} hasActiveProviders={hasActiveProviders} />;
      case "codex":
        return <CodexToolCard {...commonProps} activeProviders={getActiveProviders()} />;
      case "opencode":
        return <OpenCodeToolCard {...commonProps} activeProviders={getActiveProviders()} />;
      case "cowork":
        return <CoworkToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} cloudUrl="" />;
      case "droid":
        return <DroidToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} />;
      case "openclaw":
        return <OpenClawToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} />;
      case "hermes":
        return <HermesToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} />;
      case "cline":
        return <ClineToolCard {...commonProps} activeProviders={getActiveProviders()} />;
      case "kilo":
        return <KiloToolCard {...commonProps} activeProviders={getActiveProviders()} />;
      case "deepseek-tui":
        return <DeepSeekTuiToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} />;
      case "jcode":
        return <JcodeToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} />;
      case "grok":
        return <GrokToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} />;
      case "pi":
        return <PiToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} />;
      case "aider":
        return <AiderToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} />;
      case "gemini-cli":
        return <GeminiCliToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} />;
      default:
        return <DefaultToolCard toolId={toolId} {...commonProps} activeProviders={getActiveProviders()} />;
    }
  };

  if (!tool) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
        <Link href="/dashboard/cli-tools" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary w-fit">
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          Back to CLI Tools
        </Link>
        <p className="text-sm text-text-muted">Tool not found or disabled.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
      <Link href="/dashboard/cli-tools" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary w-fit">
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        Back to CLI Tools
      </Link>
      {machineId ? (
        <p className="text-xs text-text-muted font-mono">Machine: {machineId}</p>
      ) : null}
      {loadError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px]">error</span>
            Error loading tool data: {loadError}
          </span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="flex items-center gap-1 rounded border border-red-500/40 px-2 py-1 font-medium hover:bg-red-500/10"
          >
            <span className="material-symbols-outlined text-[14px]">refresh</span>
            Retry
          </button>
        </div>
      )}
      {renderToolCard()}
    </div>
  );
}
