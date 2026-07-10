"use client";
// @ts-check

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { CardSkeleton } from "@/shared/components";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { resolveProviderId } from "@/shared/constants/providers";
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
  const [modelMappings, setModelMappings] = useState({});
  const [apiKeys, setApiKeys] = useState([]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [provRes, keysRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/keys"),
        ]);
        if (!mounted) return;
        if (provRes.ok) {
          const data = await provRes.json();
          setConnections(data.connections || []);
        }
        if (keysRes.ok) {
          const data = await keysRes.json();
          setApiKeys(data.keys || []);
        }
      } catch (error) {
        reportClientError("Error loading tool data:", error);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

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
    const hasActiveProviders = availableModels.length > 0;
    const commonProps = {
      tool,
      isExpanded: true,
      onToggle: () => {},
      baseUrl: getBaseUrl(),
      apiKeys,
      tunnelEnabled: false,
      tunnelPublicUrl: "",
      tailscaleEnabled: false,
      tailscaleUrl: "",
      cloudEnabled: false,
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
      {renderToolCard()}
    </div>
  );
}
