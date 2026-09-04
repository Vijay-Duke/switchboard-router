"use client";
// @ts-check

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Badge, Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import MediaKindTabs from "../MediaKindTabs";
import { reportClientError } from "@/shared/utils/clientFeedback";

function getEffectiveStatus(conn) {
  const isCooldown = Object.entries(conn).some(
    ([k, v]) => k.startsWith("modelLock_") && v && new Date(v).getTime() > Date.now()
  );
  return conn.testStatus === "unavailable" && !isCooldown ? "active" : conn.testStatus;
}

function ProviderCard({ provider, kind, connections }) {
  const providerInfo = AI_PROVIDERS[provider.id];
  const isNoAuth = !!providerInfo?.noAuth;
  const providerConns = connections.filter((c) => c.provider === provider.id);
  const connected = providerConns.filter((c) => { const s = getEffectiveStatus(c); return s === "active" || s === "success"; }).length;
  const error = providerConns.filter((c) => { const s = getEffectiveStatus(c); return s === "error" || s === "expired" || s === "unavailable"; }).length;
  const total = providerConns.length;
  const allDisabled = total > 0 && providerConns.every((c) => c.isActive === false);

  const renderStatus = () => {
    if (isNoAuth) return <Badge variant="success" size="sm">Ready</Badge>;
    if (allDisabled) return <Badge variant="default" size="sm">Disabled</Badge>;
    if (total === 0) return <span className="text-xs text-text-muted">No connections</span>;
    return (
      <>
        {connected > 0 && <Badge variant="success" size="sm" dot>{connected} Connected</Badge>}
        {error > 0 && <Badge variant="error" size="sm" dot>{error} Error</Badge>}
        {connected === 0 && error === 0 && <Badge variant="default" size="sm">{total} Added</Badge>}
      </>
    );
  };

  return (
    <Link href={`/dashboard/media-providers/${kind}/${provider.id}`} className="group">
      <Card padding="xs" className={`h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors cursor-pointer ${allDisabled ? "opacity-50" : ""}`}>
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="size-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: `${provider.color?.length > 7 ? provider.color : (provider.color ?? "#888") + "15"}` }}
          >
            <ProviderIcon
              src={`/providers/${provider.id}.png`}
              alt={provider.name}
              size={30}
              className="object-contain rounded-lg max-w-[30px] max-h-[30px]"
              fallbackText={provider.textIcon || provider.id.slice(0, 2).toUpperCase()}
              fallbackColor={provider.color}
            />
          </div>
          <div>
            <h3 className="font-semibold text-sm">{provider.name}</h3>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">{renderStatus()}</div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function ComboList({ combos }) {
  if (combos.length === 0) {
    return <p className="text-xs text-text-muted italic">No combos yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {combos.map((combo) => (
        <Link key={combo.id} href={`/dashboard/media-providers/combo/${combo.id}`}>
          <Card padding="xs" className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors cursor-pointer">
            <div className="flex min-w-0 items-center gap-3">
              <span className="material-symbols-outlined text-primary text-[18px]">layers</span>
              <code className="text-sm font-mono font-medium flex-1 truncate">{combo.name}</code>
              {/* Provider icons preview */}
              <div className="flex flex-wrap items-center gap-1 sm:shrink-0">
                {combo.models.slice(0, 6).map((entry, i) => {
                  const pid = typeof entry === "string" ? entry.split("/")[0] : "";
                  const p = AI_PROVIDERS[pid];
                  return (
                    <div key={`${entry}-${i}`} title={p?.name || entry} className="size-5 rounded flex items-center justify-center" style={{ backgroundColor: `${(p?.color ?? "#888")}15` }}>
                      <ProviderIcon
                        src={`/providers/${pid}.png`}
                        alt={p?.name || pid}
                        size={18}
                        className="object-contain rounded max-w-[18px] max-h-[18px]"
                        fallbackText={p?.textIcon || pid.slice(0, 2).toUpperCase()}
                        fallbackColor={p?.color}
                      />
                    </div>
                  );
                })}
                {combo.models.length > 6 && (
                  <span className="text-[10px] text-text-muted ml-1">+{combo.models.length - 6}</span>
                )}
              </div>
              <span className="text-[11px] text-text-muted shrink-0">{combo.models.length}</span>
              <span className="material-symbols-outlined text-text-muted text-[16px]">chevron_right</span>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}

function Section({ title, icon, kind, providers, connections, combos, onCreateCombo, origin, copied, onCopy }) {
  const endpointMeta = kind === "webSearch"
    ? {
        method: "POST",
        path: "/v1/search",
        desc: "Web search query endpoint across connected search providers & combos",
        payloadExample: '{ "query": "..." }',
      }
    : {
        method: "POST",
        path: "/v1/web/fetch",
        desc: "Direct web page markdown and content fetcher endpoint",
        payloadExample: '{ "url": "https://..." }',
      };

  const endpointUrl = `${origin.replace(/\/+$/, "")}${endpointMeta.path}`;

  return (
    <div>
      {/* Header — title left, Create Combo right */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="material-symbols-outlined text-primary">{icon}</span>
          <h2 className="text-base font-semibold">{title}</h2>
          <span className="text-xs text-text-muted">({providers.length} providers · {combos.length} combos)</span>
        </div>
        <Button size="sm" icon="add" onClick={onCreateCombo}>Create Combo</Button>
      </div>

      <Card padding="xs" className="mb-4 border border-border/80 bg-surface-2/60">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-teal-500/10 text-teal-600 dark:text-teal-400 border border-teal-500/20 shrink-0">
                {endpointMeta.method}
              </span>
              <span className="text-xs font-semibold text-text-main truncate">
                {title} Endpoint
              </span>
            </div>
            <span className="text-[11px] font-mono text-text-muted hidden sm:inline truncate">
              {endpointMeta.payloadExample}
            </span>
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <Input
              value={endpointUrl}
              readOnly
              className="flex-1 min-w-0"
              inputClassName="font-mono text-xs bg-surface"
            />
            <button
              type="button"
              onClick={() => onCopy(endpointUrl, `endpoint_${kind}`)}
              className="p-2 hover:bg-surface rounded text-text-muted hover:text-primary transition-colors shrink-0 border border-border/60"
              title="Copy Endpoint URL"
              aria-label={`Copy ${title} Endpoint URL`}
            >
              <span className="material-symbols-outlined text-[18px] leading-none">
                {copied === `endpoint_${kind}` ? "check" : "content_copy"}
              </span>
            </button>
          </div>
          <p className="text-[11px] text-text-muted">{endpointMeta.desc}</p>
        </div>
      </Card>

      {/* Combos — top */}
      {combos.length > 0 && (
        <div className="mb-4">
          <ComboList combos={combos} />
        </div>
      )}

      {/* Providers grid — bottom */}
      {providers.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-border rounded-xl text-text-muted text-sm">
          No providers.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} kind={kind} connections={connections} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function WebProvidersPage() {
  const router = useRouter();
  const [connections, setConnections] = useState([]);
  const [combos, setCombos] = useState([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [origin, setOrigin] = useState("http://127.0.0.1:20128");
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
  }, []);

  const fetchAll = async () => {
    try {
      const [connsRes, combosRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/combos", { cache: "no-store" }),
      ]);
      if (!connsRes.ok || !combosRes.ok) throw new Error("load failed");
      setConnections((await connsRes.json()).connections || []);
      setCombos((await combosRes.json()).combos || []);
      setLoadFailed(false);
    } catch { setLoadFailed(true); }
  };

  useEffect(() => { fetchAll(); }, []);

  const searchProviders = getProvidersByKind("webSearch");
  const fetchProviders = getProvidersByKind("webFetch");
  const searchCombos = combos.filter((c) => c.kind === "webSearch");
  const fetchCombos = combos.filter((c) => c.kind === "webFetch");

  const handleCreateCombo = async (kind) => {
    // Generate unique default name
    const base = kind === "webSearch" ? "search-combo" : "fetch-combo";
    let name = base;
    let i = 1;
    const existing = new Set(combos.map((c) => c.name));
    while (existing.has(name)) { name = `${base}-${i++}`; }
    const res = await fetch("/api/combos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, models: [], kind }),
    });
    if (res.ok) {
      const created = await res.json();
      router.push(`/dashboard/media-providers/combo/${created.id}`);
    } else {
      const err = await res.json().catch(() => ({}));
      reportClientError(err.error || "Failed to create combo");
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {loadFailed ? (
        <div role="alert" className="flex flex-col gap-3 border border-red-300 bg-red-500/10 rounded-xl p-4">
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
            Couldn&apos;t load providers or combos. Check the server and try again.
          </p>
          <div>
            <Button size="sm" variant="outline" onClick={fetchAll}>Retry</Button>
          </div>
        </div>
      ) : (
      <>
      <div className="flex flex-col gap-1">
        <h1 className="text-[17px] font-semibold text-text-main">Web Fetch & Search</h1>
        <p className="text-xs font-mono text-text-subtle">Media providers · not agent Skills</p>
      </div>
      <MediaKindTabs activeKind="web" />

      <Section
        title="Web Search" icon="search" kind="webSearch"
        providers={searchProviders} connections={connections} combos={searchCombos}
        onCreateCombo={() => handleCreateCombo("webSearch")}
        origin={origin} copied={copied} onCopy={copy}
      />

      {/* Divider between sections */}
      <div className="border-t border-border" />

      <Section
        title="Web Fetch" icon="travel_explore" kind="webFetch"
        providers={fetchProviders} connections={connections} combos={fetchCombos}
        onCreateCombo={() => handleCreateCombo("webFetch")}
        origin={origin} copied={copied} onCopy={copy}
      />
      </>
      )}
    </div>
  );
}
