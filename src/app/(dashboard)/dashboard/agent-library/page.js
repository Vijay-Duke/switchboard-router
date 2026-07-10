"use client";
// @ts-check

import { useCallback, useEffect, useState } from "react";
import { Card, Button, Badge } from "@/shared/components";
import { requestConfirmation } from "@/store/confirmationStore";

/**
 * Agent Library — single dashboard control plane for skills + MCP
 * projected into Claude / Codex / OpenCode / Gemini / Cursor.
 */
export default function AgentLibraryPage() {
  const [data, setData] = useState(/** @type {any} */ (null));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(/** @type {null|{type:string,text:string}} */ (null));
  const [doctor, setDoctor] = useState(/** @type {any} */ (null));
  const [syncResult, setSyncResult] = useState(/** @type {any} */ (null));
  const [tab, setTab] = useState(/** @type {"overview"|"skills"|"mcp"|"catalog"|"advanced"} */ ("overview"));

  // MCP form
  const [mcpForm, setMcpForm] = useState({
    id: "",
    name: "",
    transport: "stdio",
    command: "npx",
    args: "-y @modelcontextprotocol/server-filesystem .",
    url: "",
    notes: "",
  });

  // Catalog
  const [presets, setPresets] = useState([]);
  const [catalogUrl, setCatalogUrl] = useState("");
  const [catalogSkillId, setCatalogSkillId] = useState("");
  const [catalogPreview, setCatalogPreview] = useState("");
  const [catalogConfirm, setCatalogConfirm] = useState(false);

  // Manual skill paste
  const [manualId, setManualId] = useState("");
  const [manualMd, setManualMd] = useState("");

  // Export path
  const [exportPath, setExportPath] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/agent-library", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Load failed");
      setData(j);
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    fetch("/api/agent-library/catalog")
      .then((r) => r.json())
      .then((j) => setPresets(j.presets || []))
      .catch(() => {});
  }, [load]);

  const settings = data?.settings || {};
  const agents = data?.agents || {};

  async function patchSettings(patch) {
    setBusy("settings");
    setMessage(null);
    try {
      const r = await fetch("/api/agent-library", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Save failed");
      setMessage({ type: "success", text: "Settings saved" });
      await load();
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function runSync(action) {
    setBusy(action);
    setMessage(null);
    setSyncResult(null);
    try {
      const r = await fetch("/api/agent-library/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          confirm: action === "clean" ? true : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || j.message || "Sync failed");
      setSyncResult(j);
      setMessage({
        type: j.conflictCount ? "warn" : "success",
        text:
          action === "dry-run"
            ? `Dry-run: ${j.summary?.skillsSynced ?? 0} skill ops, ${j.summary?.mcpOk ?? 0} MCP ok, ${j.conflictCount || 0} conflicts`
            : action === "clean"
              ? "Removed Switchboard-managed projections only"
              : `Applied: ${j.summary?.skillsSynced ?? 0} skills synced, ${j.conflictCount || 0} conflicts protected`,
      });
      await load();
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function runDoctor() {
    setBusy("doctor");
    try {
      const r = await fetch("/api/agent-library/doctor", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Doctor failed");
      setDoctor(j);
      setMessage({
        type: j.ok ? "success" : "warn",
        text: j.ok
          ? "Doctor: no blocking errors"
          : `Doctor: ${j.issues?.filter((i) => i.severity === "error").length || 0} errors`,
      });
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function saveMcp(e) {
    e?.preventDefault?.();
    setBusy("mcp");
    try {
      const args = mcpForm.args
        ? mcpForm.args.split(/\s+/).filter(Boolean)
        : [];
      const r = await fetch("/api/agent-library/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: mcpForm.id,
          name: mcpForm.name || mcpForm.id,
          transport: mcpForm.transport,
          command: mcpForm.transport === "stdio" ? mcpForm.command : undefined,
          args: mcpForm.transport === "stdio" ? args : undefined,
          url: mcpForm.transport !== "stdio" ? mcpForm.url : undefined,
          notes: mcpForm.notes,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "MCP save failed");
      if (j.warnings?.length) {
        setMessage({ type: "warn", text: j.warnings.join(" · ") });
      } else {
        setMessage({ type: "success", text: `MCP ${j.server?.id} saved (Apply to project)` });
      }
      setMcpForm({
        id: "",
        name: "",
        transport: "stdio",
        command: "npx",
        args: "",
        url: "",
        notes: "",
      });
      await load();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setBusy("");
    }
  }

  async function deleteMcp(id) {
    if (!await requestConfirmation({ message: `Remove MCP ${id} from library? (targets updated on next Apply)`, confirmText: "Continue" })) return;
    setBusy("mcp-del");
    try {
      const r = await fetch(`/api/agent-library/mcp?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setMessage({ type: "success", text: "MCP removed from library" });
      await load();
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function deleteSkill(id) {
    if (!await requestConfirmation({ message: `Remove skill ${id} from library?`, confirmText: "Continue" })) return;
    setBusy("skill-del");
    try {
      const r = await fetch(`/api/agent-library/skills?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setMessage({ type: "success", text: "Skill removed from library" });
      await load();
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function installManualSkill() {
    setBusy("skill-add");
    try {
      const r = await fetch("/api/agent-library/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: manualId, markdown: manualMd, source: "manual" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setMessage({ type: "success", text: `Skill ${j.id} installed in library` });
      setManualId("");
      setManualMd("");
      await load();
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function fetchCatalogPreview(url) {
    setBusy("preview");
    try {
      const r = await fetch("/api/agent-library/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", url }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Preview failed");
      setCatalogPreview(j.preview || "");
      setMessage({ type: "success", text: `Preview loaded (${j.bytes} bytes)` });
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function catalogInstall() {
    setBusy("catalog");
    try {
      const r = await fetch("/api/agent-library/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "install",
          skillId: catalogSkillId,
          url: catalogUrl,
          confirmed: catalogConfirm,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || "Install failed");
      setMessage({ type: "success", text: j.warning || `Installed ${j.id}` });
      setCatalogConfirm(false);
      await load();
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function runExport() {
    setBusy("export");
    try {
      const r = await fetch("/api/agent-library/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destPath: exportPath || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || "Export failed");
      setMessage({ type: "success", text: `Exported AgentSync layout to ${j.path}` });
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "skills", label: "Skills" },
    { id: "mcp", label: "MCP" },
    { id: "catalog", label: "Catalog" },
    { id: "advanced", label: "Advanced" },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-12">
      <div className="flex flex-col gap-1">
        <h1 className="text-[17px] font-semibold text-text-main">Agent library</h1>
        <p className="text-xs text-text-muted leading-relaxed max-w-2xl">
          One Switchboard-owned library of <strong className="text-text-main">skills</strong> and{" "}
          <strong className="text-text-main">MCP servers</strong>, projected into Claude Code, Codex,
          OpenCode, Gemini CLI, and Cursor. Managed entries use the{" "}
          <code className="text-[11px] font-mono">sb-</code> namespace so we never overwrite your
          existing skills or MCP keys.
        </p>
      </div>

      {message && (
        <div
          className={`text-xs px-3 py-2 rounded-lg border ${
            message.type === "success"
              ? "bg-green-500/10 border-green-500/30 text-green-600 dark:text-green-400"
              : message.type === "warn"
                ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400"
                : "bg-red-500/10 border-red-500/30 text-red-500"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Master switch + actions */}
      <Card padding="md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-text-main cursor-pointer">
            <input
              type="checkbox"
              className="accent-[var(--color-primary)]"
              checked={settings.enabled !== false}
              disabled={!!busy}
              onChange={(e) => patchSettings({ enabled: e.target.checked })}
            />
            Sync enabled
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy || settings.enabled === false}
              loading={busy === "dry-run"}
              onClick={() => runSync("dry-run")}
            >
              Dry-run
            </Button>
            <Button
              size="sm"
              disabled={!!busy || settings.enabled === false}
              loading={busy === "apply"}
              onClick={() => runSync("apply")}
            >
              Apply sync
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              loading={busy === "doctor"}
              onClick={runDoctor}
            >
              Doctor
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-text-subtle mt-2 font-mono break-all">
          Library: {data?.libraryRoot || "…"}
          {settings.linkMode ? ` · mode=${settings.linkMode}` : ""}
          {settings.scope ? ` · scope=${settings.scope}` : ""}
        </p>
      </Card>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border pb-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(/** @type {any} */ (t.id))}
            className={`px-3 py-2 text-xs font-medium rounded-t-md transition-colors ${
              tab === t.id
                ? "bg-surface border border-border border-b-surface text-primary -mb-px"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && (
        <p className="text-sm text-text-muted flex items-center gap-2">
          <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
          Loading…
        </p>
      )}

      {!loading && tab === "overview" && (
        <div className="space-y-4">
          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-2">How it works</h2>
            <ol className="text-xs text-text-muted space-y-1.5 list-decimal pl-4 leading-relaxed">
              <li>
                Skills and MCP servers live only in Switchboard&apos;s library (
                <code className="font-mono">~/.switchboard/agent-library</code>
                ).
              </li>
              <li>
                <strong className="text-text-main">Apply sync</strong> projects them into each enabled
                agent under namespaced paths/keys (<code className="font-mono">sb-*</code>).
              </li>
              <li>
                If a path already exists and is <em>not</em> marked managed, we{" "}
                <strong className="text-text-main">skip</strong> it (never overwrite).
              </li>
              <li>Turn individual agents or skills/MCP off with the toggles below.</li>
            </ol>
          </Card>

          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-3">Targets</h2>
            <div className="space-y-2">
              {Object.values(agents).map((a) => {
                const t = settings.targets?.[a.id] || { skills: true, mcp: true };
                return (
                  <div
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-border-subtle last:border-0"
                  >
                    <span className="text-sm text-text-main">{a.label}</span>
                    <div className="flex gap-4 text-xs text-text-muted">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={t.skills !== false}
                          disabled={!a.supportsSkills || !!busy}
                          onChange={(e) =>
                            patchSettings({
                              targets: {
                                ...settings.targets,
                                [a.id]: { ...t, skills: e.target.checked },
                              },
                            })
                          }
                        />
                        Skills
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={t.mcp !== false}
                          disabled={!a.supportsMcp || !!busy}
                          onChange={(e) =>
                            patchSettings({
                              targets: {
                                ...settings.targets,
                                [a.id]: { ...t, mcp: e.target.checked },
                              },
                            })
                          }
                        />
                        MCP
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-3">Safety & link mode</h2>
            <div className="grid gap-3 sm:grid-cols-2 text-xs">
              <label className="flex flex-col gap-1">
                <span className="text-text-muted">Link mode</span>
                <select
                  className="bg-surface border border-border rounded-md px-2 py-1.5 text-text-main"
                  value={settings.linkMode || "copy"}
                  disabled={!!busy}
                  onChange={(e) => patchSettings({ linkMode: e.target.value })}
                >
                  <option value="copy">Copy (safe default on Windows)</option>
                  <option value="symlink">Symlink (instant updates; may need privileges on Windows)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-text-muted">Scope</span>
                <select
                  className="bg-surface border border-border rounded-md px-2 py-1.5 text-text-main"
                  value={settings.scope || "global"}
                  disabled={!!busy}
                  onChange={(e) =>
                    patchSettings({
                      scope: e.target.value,
                      projectPath:
                        e.target.value === "project"
                          ? settings.projectPath || ""
                          : null,
                    })
                  }
                >
                  <option value="global">Global (user home agents)</option>
                  <option value="project">Project (paths under project folder)</option>
                </select>
              </label>
              {settings.scope === "project" && (
                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-text-muted">Project path (absolute)</span>
                  <input
                    className="bg-surface border border-border rounded-md px-2 py-1.5 font-mono text-text-main"
                    value={settings.projectPath || ""}
                    placeholder="/Users/you/my-app"
                    disabled={!!busy}
                    onChange={(e) => patchSettings({ projectPath: e.target.value })}
                  />
                </label>
              )}
              <label className="flex items-start gap-2 sm:col-span-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={settings.neverOverwriteUser !== false}
                  disabled={!!busy}
                  onChange={async (e) => {
                    if (!e.target.checked) {
                      const ok = await requestConfirmation({ message: "Allow overwriting paths that are NOT Switchboard-managed? This can replace your personal skills/MCP. Continue?", confirmText: "Continue" });
                      if (!ok) return;
                      patchSettings({
                        neverOverwriteUser: false,
                        confirmAllowOverwrite: true,
                      });
                    } else {
                      patchSettings({ neverOverwriteUser: true });
                    }
                  }}
                />
                <span className="text-text-muted leading-relaxed">
                  <strong className="text-text-main">Never overwrite user-owned files</strong>{" "}
                  (recommended). Only touch <code className="font-mono">sb-*</code> managed
                  entries.
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.includeProductSkills !== false}
                  disabled={!!busy}
                  onChange={(e) =>
                    patchSettings({ includeProductSkills: e.target.checked })
                  }
                />
                <span className="text-text-muted">
                  Auto-include Switchboard product skills (entry + chat)
                </span>
              </label>
            </div>
          </Card>

          <div className="grid sm:grid-cols-3 gap-3">
            <Stat
              label="Skills in library"
              value={String(data?.skills?.length ?? 0)}
            />
            <Stat
              label="MCP servers"
              value={String(data?.mcpServers?.length ?? 0)}
            />
            <Stat
              label="Last sync"
              value={
                data?.state?.lastSync?.at
                  ? new Date(data.state.lastSync.at).toLocaleString()
                  : "—"
              }
            />
          </div>

          {syncResult && (
            <Card padding="md">
              <h2 className="text-sm font-semibold text-text-main mb-2">Last sync detail</h2>
              <pre className="text-[11px] font-mono text-text-muted overflow-x-auto max-h-48 bg-surface-2 p-2 rounded">
                {JSON.stringify(syncResult.summary || syncResult, null, 2)}
              </pre>
              {syncResult.skills?.filter((s) => s.action === "conflict").length > 0 && (
                <div className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                  Conflicts (protected):
                  <ul className="list-disc pl-4 mt-1">
                    {syncResult.skills
                      .filter((s) => s.action === "conflict")
                      .map((s, i) => (
                        <li key={i}>
                          {s.agent}/{s.skillId}: {s.message || s.reason}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </Card>
          )}

          {doctor && (
            <Card padding="md">
              <h2 className="text-sm font-semibold text-text-main mb-2">Doctor</h2>
              {doctor.issues?.length === 0 ? (
                <p className="text-xs text-green-600">No issues</p>
              ) : (
                <ul className="text-xs space-y-1">
                  {doctor.issues?.map((iss, i) => (
                    <li
                      key={i}
                      className={
                        iss.severity === "error" ? "text-red-500" : "text-amber-600 dark:text-amber-400"
                      }
                    >
                      [{iss.severity}] {iss.message}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      )}

      {!loading && tab === "skills" && (
        <div className="space-y-4">
          <Card padding="md">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-text-main">Library skills</h2>
              <Button
                size="sm"
                variant="secondary"
                disabled={!!busy}
                onClick={async () => {
                  setBusy("ensure");
                  try {
                    await fetch("/api/agent-library/skills", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "ensure_product" }),
                    });
                    await load();
                    setMessage({ type: "success", text: "Product skills ensured" });
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Refresh product skills
              </Button>
            </div>
            <div className="space-y-2">
              {(data?.skills || []).map((s) => (
                <div
                  key={s.id}
                  className="flex items-start justify-between gap-2 p-3 rounded-lg border border-border-subtle bg-surface-2/50"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-main">{s.title || s.id}</span>
                      <Badge size="sm" variant="default">
                        <code className="text-[10px]">sb-{s.id}</code>
                      </Badge>
                    </div>
                    <p className="text-[11px] text-text-muted mt-0.5 line-clamp-2">
                      {s.description || "—"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => deleteSkill(s.id)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              {!data?.skills?.length && (
                <p className="text-xs text-text-muted">No skills yet. Enable product skills or add manually.</p>
              )}
            </div>
          </Card>

          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-2">Add skill (paste SKILL.md)</h2>
            <div className="space-y-2">
              <input
                className="w-full bg-surface border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                placeholder="skill-id (e.g. my-review)"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
              />
              <textarea
                className="w-full h-40 bg-surface border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                placeholder={"---\nname: my-skill\ndescription: ...\n---\n\n# ..."}
                value={manualMd}
                onChange={(e) => setManualMd(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!manualId || !manualMd || !!busy}
                loading={busy === "skill-add"}
                onClick={installManualSkill}
              >
                Add to library
              </Button>
            </div>
          </Card>
        </div>
      )}

      {!loading && tab === "mcp" && (
        <div className="space-y-4">
          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-1">MCP servers in library</h2>
            <p className="text-[11px] text-text-subtle mb-3">
              Prefer <code className="font-mono">${"{GITHUB_TOKEN}"}</code> style env values — do not
              paste raw API keys if you can avoid it. Keys are projected as{" "}
              <code className="font-mono">sb-*</code> only.
            </p>
            <div className="space-y-2">
              {(data?.mcpServers || []).map((s) => (
                <div
                  key={s.id}
                  className="flex items-start justify-between gap-2 p-3 rounded-lg border border-border-subtle"
                >
                  <div>
                    <div className="text-sm text-text-main font-medium">{s.name}</div>
                    <code className="text-[10px] text-text-subtle">{s.id}</code>
                    <div className="text-[11px] text-text-muted mt-1">
                      {s.transport || "stdio"} ·{" "}
                      {s.command
                        ? `${s.command} ${(s.args || []).join(" ")}`
                        : s.url}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => deleteMcp(s.id)}>
                    Remove
                  </Button>
                </div>
              ))}
              {!data?.mcpServers?.length && (
                <p className="text-xs text-text-muted">No MCP servers in library yet.</p>
              )}
            </div>
          </Card>

          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-3">Add MCP server</h2>
            <form className="grid gap-2 sm:grid-cols-2" onSubmit={saveMcp}>
              <input
                required
                className="bg-surface border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                placeholder="id (e.g. filesystem)"
                value={mcpForm.id}
                onChange={(e) => setMcpForm({ ...mcpForm, id: e.target.value })}
              />
              <input
                className="bg-surface border border-border rounded-md px-2 py-1.5 text-xs"
                placeholder="Display name"
                value={mcpForm.name}
                onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
              />
              <select
                className="bg-surface border border-border rounded-md px-2 py-1.5 text-xs"
                value={mcpForm.transport}
                onChange={(e) => setMcpForm({ ...mcpForm, transport: e.target.value })}
              >
                <option value="stdio">stdio (command)</option>
                <option value="http">http (url)</option>
                <option value="sse">sse (url)</option>
              </select>
              {mcpForm.transport === "stdio" ? (
                <>
                  <input
                    className="bg-surface border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                    placeholder="command"
                    value={mcpForm.command}
                    onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })}
                  />
                  <input
                    className="sm:col-span-2 bg-surface border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                    placeholder="args (space-separated)"
                    value={mcpForm.args}
                    onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })}
                  />
                </>
              ) : (
                <input
                  className="sm:col-span-1 bg-surface border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                  placeholder="https://..."
                  value={mcpForm.url}
                  onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })}
                />
              )}
              <div className="sm:col-span-2">
                <Button size="sm" type="submit" loading={busy === "mcp"} disabled={!!busy}>
                  Save to library
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {!loading && tab === "catalog" && (
        <div className="space-y-4">
          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-1">Trusted presets</h2>
            <p className="text-[11px] text-text-subtle mb-3">
              Fetches SKILL.md only — never runs install scripts. You must confirm and then Apply
              sync.
            </p>
            <div className="space-y-2">
              {presets.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 p-2 rounded border border-border-subtle"
                >
                  <div>
                    <div className="text-sm text-text-main">{p.name}</div>
                    <div className="text-[11px] text-text-muted">{p.description}</div>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setCatalogUrl(p.rawUrl);
                        setCatalogSkillId(p.skillId);
                        fetchCatalogPreview(p.rawUrl);
                      }}
                    >
                      Preview
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setCatalogUrl(p.rawUrl);
                        setCatalogSkillId(p.skillId);
                        setCatalogConfirm(false);
                      }}
                    >
                      Select
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-2">Install from URL</h2>
            <div className="space-y-2">
              <input
                className="w-full bg-surface border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                placeholder="skill-id"
                value={catalogSkillId}
                onChange={(e) => setCatalogSkillId(e.target.value)}
              />
              <input
                className="w-full bg-surface border border-border rounded-md px-2 py-1.5 text-xs font-mono"
                placeholder="https://.../SKILL.md"
                value={catalogUrl}
                onChange={(e) => setCatalogUrl(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!catalogUrl || !!busy}
                  onClick={() => fetchCatalogPreview(catalogUrl)}
                >
                  Preview
                </Button>
              </div>
              {catalogPreview && (
                <pre className="text-[10px] font-mono max-h-48 overflow-auto bg-surface-2 p-2 rounded border border-border-subtle whitespace-pre-wrap">
                  {catalogPreview}
                </pre>
              )}
              <label className="flex items-start gap-2 text-xs text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={catalogConfirm}
                  onChange={(e) => setCatalogConfirm(e.target.checked)}
                />
                I reviewed this skill and understand it may instruct agents to run tools/shell commands.
              </label>
              <Button
                size="sm"
                disabled={!catalogUrl || !catalogSkillId || !catalogConfirm || !!busy}
                loading={busy === "catalog"}
                onClick={catalogInstall}
              >
                Install into library
              </Button>
            </div>
          </Card>
        </div>
      )}

      {!loading && tab === "advanced" && (
        <div className="space-y-4">
          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-2">Clean managed projections</h2>
            <p className="text-xs text-text-muted mb-3">
              Removes only <code className="font-mono">sb-*</code> skills and MCP keys written by
              Switchboard. Your other skills/MCP stay untouched.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              loading={busy === "clean"}
              onClick={async () => {
                if (await requestConfirmation({ message: "Remove all Switchboard-managed skill/MCP projections from targets?", confirmText: "Continue" })) {
                  runSync("clean");
                }
              }}
            >
              Clean managed only
            </Button>
          </Card>

          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-2">
              Export AgentSync layout
            </h2>
            <p className="text-xs text-text-muted mb-2">
              Writes a coexistence-friendly <code className="font-mono">.agents/</code> tree
              (skills + agentsync.toml). Does not run agentsync. Paths must be under your home or
              project directory.
            </p>
            <input
              className="w-full bg-surface border border-border rounded-md px-2 py-1.5 text-xs font-mono mb-2"
              placeholder="Optional dest (default ~/switchboard-agents-export/.agents)"
              value={exportPath}
              onChange={(e) => setExportPath(e.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy}
              loading={busy === "export"}
              onClick={runExport}
            >
              Export
            </Button>
          </Card>

          <Card padding="md">
            <h2 className="text-sm font-semibold text-text-main mb-2">Coexistence</h2>
            <ul className="text-xs text-text-muted space-y-1 list-disc pl-4">
              <li>
                Switchboard only owns <code className="font-mono">sb-*</code> skill directories and MCP
                keys.
              </li>
              <li>
                AgentSync / skillbook may manage other paths — avoid pointing both at the same
                un-namespaced skill.
              </li>
              <li>Product skills for HTTP agents remain under Dashboard → Skills (separate).</li>
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <Card padding="sm">
      <div className="text-[10px] uppercase tracking-wide text-text-subtle font-semibold">
        {label}
      </div>
      <div className="text-sm text-text-main mt-1 font-medium truncate" title={value}>
        {value}
      </div>
    </Card>
  );
}
