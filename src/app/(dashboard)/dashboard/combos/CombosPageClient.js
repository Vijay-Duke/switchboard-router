"use client";
// @ts-check
import { useState, useEffect, useCallback } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Card, Button, Modal, Input, CardSkeleton, ModelSelectModal, ConfirmModal, CapacityBadges, Select } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { useNotificationStore } from "@/store/notificationStore";
import { reportClientError } from "@/shared/utils/clientFeedback";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

/**
 * @param {{ initialData?: { combos?: any[], connections?: any[], settings?: any, modelCaps?: Record<string, any> } }} props
 */
export default function CombosPageClient({ initialData }) {
  const notify = useNotificationStore((s) => s.error);
  const [combos, setCombos] = useState(() => (initialData?.combos || []).filter((c) => !c.kind || c.kind === "llm"));
  const [loading, setLoading] = useState(!initialData);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCombo, setEditingCombo] = useState(null);
  const [activeProviders, setActiveProviders] = useState(initialData?.connections || []);
  const [comboStrategies, setComboStrategies] = useState(initialData?.settings?.comboStrategies || {});
  const [modelCaps, setModelCaps] = useState(initialData?.modelCaps || {});
  const [confirmState, setConfirmState] = useState(null);
  const { copied, copy } = useCopyToClipboard();

  const fetchData = useCallback(async () => {
    try {
      const [combosRes, providersRes, settingsRes, modelsRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings"),
        fetch("/api/models"),
      ]);
      if (![combosRes, providersRes, settingsRes, modelsRes].every((res) => res.ok)) {
        throw new Error("One or more combo resources failed to load");
      }
      const combosData = await combosRes.json();
      const providersData = await providersRes.json();
      const settingsData = await settingsRes.json();

      // Only LLM combos here - webSearch/webFetch combos belong to media-providers/web
      if (combosRes.ok) setCombos((combosData.combos || []).filter((c) => !c.kind || c.kind === "llm"));
      if (providersRes.ok) {
        setActiveProviders(providersData.connections || []);
      }
      if (modelsRes.ok) {
        const md = await modelsRes.json();
        const map = {};
        for (const m of md.models || []) if (m.caps) map[m.fullModel] = m.caps;
        setModelCaps(map);
      }
      setComboStrategies(settingsData.comboStrategies || {});
    } catch (error) {
      notify("Failed to fetch combo data");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (initialData?.combos) {
      setLoading(false);
      return;
    }
    fetchData();
  }, [initialData, fetchData]);

  const handleCreate = async (data) => {
    try {
      const { strategy, capacityAutoSwitch, routerModel, objective, ...comboFields } = data;
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(comboFields),
      });
      if (res.ok) {
        const created = await res.json().catch(() => ({}));
        const name = comboFields.name?.trim() || created?.name;
        // Persist strategy so Create Combo is not “models only”
        if (name && (strategy || capacityAutoSwitch !== undefined || routerModel || objective)) {
          await handleSetComboStrategy(name, strategyPatchFromForm(strategy, capacityAutoSwitch, routerModel, objective));
        }
        await fetchData();
        setShowCreateModal(false);
      } else {
        const err = await res.json();
        notify(err.error || "Failed to create combo");
      }
    } catch (error) {
      notify("Failed to create combo");
    }
  };

  const handleUpdate = async (id, data) => {
    try {
      const { strategy, capacityAutoSwitch, routerModel, objective, ...comboFields } = data;
      const prevName = editingCombo?.name;
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(comboFields),
      });
      if (res.ok) {
        const name = comboFields.name?.trim() || prevName;
        // If renamed, rekey local strategy map first so PATCH doesn't re-orphan the old name
        // (API also rekeys server-side; we must not send a stale map with both keys).
        if (prevName && name && prevName !== name) {
          setComboStrategies((prev) => {
            const next = { ...prev };
            if (prevName in next) {
              if (!(name in next)) next[name] = next[prevName];
              delete next[prevName];
            }
            return next;
          });
        }
        // Apply form strategy to the current name (merge after rekey)
        if (name && (strategy || capacityAutoSwitch !== undefined)) {
          // Use functional merge with post-rename base so we don't clobber router/judge
          const base =
            prevName && prevName !== name
              ? (() => {
                  const m = { ...comboStrategies };
                  if (prevName in m) {
                    if (!(name in m)) m[name] = m[prevName];
                    delete m[prevName];
                  }
                  return m;
                })()
              : comboStrategies;
          await handleSetComboStrategy(
            name,
            strategyPatchFromForm(strategy, capacityAutoSwitch, routerModel, objective),
            base
          );
        }
        await fetchData();
        setEditingCombo(null);
      } else {
        const err = await res.json();
        notify(err.error || "Failed to update combo");
      }
    } catch (error) {
      notify("Failed to update combo");
    }
  };

  const handleDelete = async (id) => {
    const doomed = combos.find((c) => c.id === id);
    setConfirmState({
      title: "Delete Combo",
      message: doomed?.name ? `Delete combo “${doomed.name}”?` : "Delete this combo?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
          if (res.ok) {
            setCombos((prev) => prev.filter((c) => c.id !== id));
            // Optimistic local prune (API also drops strategy server-side)
            if (doomed?.name) {
              setComboStrategies((prev) => {
                if (!(doomed.name in prev)) return prev;
                const next = { ...prev };
                delete next[doomed.name];
                return next;
              });
            }
          } else {
            const err = await res.json().catch(() => ({}));
            notify(err.error || `Failed to delete combo (HTTP ${res.status})`);
          }
        } catch (error) {
          notify("Failed to delete combo");
        }
      },
    });
  };

  // Merge a per-combo strategy patch into settings.comboStrategies.
  // Keep auto/fusion (and any non-default extras). Only prune pure default fallback.
  // Optional `baseMap` overrides React state when caller already rekeyed (rename).
  const handleSetComboStrategy = async (comboName, patch, baseMap = null) => {
    try {
      const updated = { ...(baseMap || comboStrategies) };
      const next = { ...(updated[comboName] || {}), ...patch };
      // Strip empty / cleared fields so mode switches don't leave ghost keys
      for (const k of Object.keys(next)) {
        if (next[k] === "" || next[k] === null || next[k] === undefined) delete next[k];
      }
      const strat = next.fallbackStrategy || "fallback";
      // Pure default = fallback + capacity switch on (default). Anything else is kept.
      const isDefaultFallback =
        strat === "fallback" &&
        !next.judgeModel &&
        !next.routerModel &&
        !next.objective &&
        next.learningEnabled === undefined &&
        next.freezeLearning === undefined &&
        next.explorationRate === undefined &&
        next.capacityAutoSwitch !== false;

      if (isDefaultFallback) {
        delete updated[comboName];
      } else {
        // Normalize explicit strategy field so Auto patches don't lose mode
        if (!next.fallbackStrategy && patch.fallbackStrategy === undefined && updated[comboName]?.fallbackStrategy) {
          next.fallbackStrategy = updated[comboName].fallbackStrategy;
        }
        updated[comboName] = next;
      }

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategies: updated }),
      });
      if (!res.ok) throw new Error(`Failed to update combo strategy (${res.status})`);

      setComboStrategies(updated);
    } catch (error) {
      notify("Failed to update combo strategy");
      throw error;
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 max-w-3xl">
          <h1 className="text-[17px] font-semibold text-text-main">Combos</h1>
          <p className="text-sm text-text-muted mt-1">
            Group models under one name, then pick a strategy per combo:
          </p>
          <ul className="text-sm text-text-muted mt-2 flex flex-col gap-1.5">
            <li>
              <span className="font-medium text-text-main">Fallback</span>
              {" "}— tries models in order (next on failure)
            </li>
            <li>
              <span className="font-medium text-text-main">Round Robin</span>
              {" "}— rotates models across requests to spread load
            </li>
            <li>
              <span className="font-medium text-text-main">Fusion</span>
              {" "}— queries all models in parallel, then a judge synthesizes one answer.
              Best quality, but costs the most: every request bills all panel models + the judge (N+1 calls)
            </li>
            <li>
              <span className="font-medium text-text-main">Auto</span>
              {" "}— a router model picks one worker from the pool each request (2 calls: router + worker);
              optional learning from outcomes
            </li>
            <li>
              <span className="font-medium text-text-main">Capacity auto-switch</span>
              {" "}— when enabled on a combo, sends image/PDF requests to a model that supports them first
              (works with Fallback, Round Robin, and Fusion)
            </li>
          </ul>
        </div>
        <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto whitespace-nowrap shrink-0">
          Create Combo
        </Button>
      </div>

      {/* Combos List */}
      {combos.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">layers</span>
            </div>
            <p className="text-text-main font-medium mb-1">No combos yet</p>
            <p className="text-sm text-text-muted mb-4 max-w-md mx-auto">
              Create a named model group, choose Fallback / Round Robin / Fusion / Auto, and point clients at the combo name.
            </p>
            <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto">
              Create Combo
            </Button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {combos.map((combo) => (
            <ComboCard
              key={combo.id}
              combo={combo}
              modelCaps={modelCaps}
              activeProviders={activeProviders}
              copied={copied}
              onCopy={copy}
              onEdit={() => setEditingCombo(combo)}
              onDelete={() => handleDelete(combo.id)}
              strategy={comboStrategies[combo.name] || {}}
              onSetStrategy={(patch) => handleSetComboStrategy(combo.name, patch)}
            />
          ))}
        </div>
      )}

      {/* Create Modal - Use key to force remount and reset state */}
      <ComboFormModal
        key="create"
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSave={handleCreate}
        activeProviders={activeProviders}
        initialStrategy={{ fallbackStrategy: "fallback", capacityAutoSwitch: true }}
      />

      {/* Edit Modal - Use key to force remount and reset state */}
      <ComboFormModal
        key={editingCombo?.id || "new"}
        isOpen={!!editingCombo}
        combo={editingCombo}
        onClose={() => setEditingCombo(null)}
        onSave={(data) => handleUpdate(editingCombo.id, data)}
        activeProviders={activeProviders}
        initialStrategy={
          editingCombo
            ? comboStrategies[editingCombo.name] || { fallbackStrategy: "fallback" }
            : {}
        }
      />

      {/* Confirm Delete Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}

/** Build strategy patch from Create/Edit form; clear mode-specific fields on switch. */
function strategyPatchFromForm(strategy, capacityAutoSwitch, routerModel, objective) {
  const strat = strategy || "fallback";
  const patch = {
    fallbackStrategy: strat,
    ...(capacityAutoSwitch !== undefined ? { capacityAutoSwitch } : {}),
  };
  if (strat === "auto") {
    if (routerModel) patch.routerModel = routerModel;
    if (objective) patch.objective = objective;
    patch.judgeModel = ""; // fusion-only
  } else if (strat === "fusion") {
    // Clear auto-only keys (use "" so JSON keeps the clear; handleSet strips empties)
    patch.routerModel = "";
    patch.objective = "";
    patch.learningEnabled = "";
    patch.freezeLearning = "";
    patch.explorationRate = "";
  } else {
    // fallback / round-robin
    patch.routerModel = "";
    patch.judgeModel = "";
    patch.objective = "";
    patch.learningEnabled = "";
    patch.freezeLearning = "";
    patch.explorationRate = "";
  }
  return patch;
}

const STRATEGY_OPTIONS = [
  { value: "fallback", label: "Fallback — try in order" },
  { value: "round-robin", label: "Round Robin — rotate load" },
  { value: "fusion", label: "Fusion — panel + judge (N+1)" },
  { value: "auto", label: "Auto — router picks 1 worker" },
];

const STRATEGY_HELP = {
  fallback: "Tries models top-to-bottom; on failure uses the next.",
  "round-robin": "Rotates models across requests to spread load.",
  fusion: "Calls every model, then a judge merges answers (bills N+1).",
  auto: "Router model chooses one worker each request (bills 2 calls).",
};

const OBJECTIVE_OPTIONS = [
  { value: "quality", label: "Quality" },
  { value: "balanced", label: "Balanced" },
  { value: "economy", label: "Economy" },
  { value: "latency", label: "Latency" },
];

function ComboCard({ combo, modelCaps = {}, activeProviders = [], copied, onCopy, onEdit, onDelete, strategy = {}, onSetStrategy }) {
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const [showRouterSelect, setShowRouterSelect] = useState(false);
  const [learnBusy, setLearnBusy] = useState(false);
  const [learnMsg, setLearnMsg] = useState("");
  const current = strategy.fallbackStrategy || "fallback";
  const judge = strategy.judgeModel || "";
  const isFusion = current === "fusion";
  const isAuto = current === "auto";
  const routerModel = strategy.routerModel || "";
  const objective = strategy.objective || "balanced";
  const capacityAutoSwitch = strategy.capacityAutoSwitch !== false;

  return (
    <Card padding="sm" className="group">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary text-[18px]">layers</span>
          </div>
          <div className="min-w-0 flex-1">
            <code className="block truncate font-mono text-sm font-medium">{combo.name}</code>
            <p className="text-[10px] text-text-subtle mt-0.5">{STRATEGY_HELP[current] || ""}</p>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {combo.models.length === 0 ? (
                <span className="text-xs text-text-muted italic">No models</span>
              ) : (
                combo.models.slice(0, 3).map((model, index) => (
                  <code key={index} className="inline-flex items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs text-text-muted dark:bg-white/5">
                    <span>{model}</span>
                    <CapacityBadges caps={modelCaps[model]} />
                  </code>
                ))
              )}
              {combo.models.length > 3 && (
                <span className="text-[10px] text-text-muted">+{combo.models.length - 3} more</span>
              )}
            </div>
            {/* Fusion: judge picker (Auto = first model) */}
            {isFusion && (
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-text-muted">Judge</span>
                <button
                  onClick={() => setShowJudgeSelect(true)}
                  className="inline-flex max-w-full items-center gap-1 rounded border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/5 transition-colors"
                  title="Pick the model that fuses panel answers"
                >
                  <span className="material-symbols-outlined text-[13px]">gavel</span>
                  <span className="truncate">{judge || `Auto — ${combo.models[0] || "first model"}`}</span>
                </button>
                {judge && (
                  <button
                    onClick={() => onSetStrategy({ judgeModel: "" })}
                    className="p-0.5 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="Reset judge to Auto"
                  >
                    <span className="material-symbols-outlined text-[13px]">close</span>
                  </button>
                )}
              </div>
            )}

            {/* Auto: router + objective + relearn */}
            {isAuto && (
              <div className="mt-2 flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium text-text-muted">Router</span>
                  <button
                    type="button"
                    onClick={() => setShowRouterSelect(true)}
                    className="inline-flex max-w-full items-center gap-1 rounded border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/5 transition-colors"
                    title="Model that picks the worker each request"
                  >
                    <span className="material-symbols-outlined text-[13px]">alt_route</span>
                    <span className="truncate">
                      {routerModel || "claude/claude-opus-4-8 (default)"}
                    </span>
                  </button>
                  {routerModel && (
                    <button
                      type="button"
                      onClick={() => onSetStrategy({ routerModel: "" })}
                      className="p-0.5 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      title="Reset router to default"
                    >
                      <span className="material-symbols-outlined text-[13px]">close</span>
                    </button>
                  )}
                </div>
                {routerModel && combo.models?.includes(routerModel) && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[12px]">warning</span>
                    Router is also in the worker list — it is auto-excluded from the pool.
                  </p>
                )}
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium text-text-muted">Objective</span>
                  <select
                    value={objective}
                    onChange={(e) => onSetStrategy({ objective: e.target.value })}
                    className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-main"
                  >
                    {OBJECTIVE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <label className="inline-flex items-center gap-1 text-[11px] text-text-muted cursor-pointer">
                    <input
                      type="checkbox"
                      className="rounded border-border"
                      checked={strategy.learningEnabled !== false}
                      onChange={(e) => onSetStrategy({ learningEnabled: e.target.checked })}
                    />
                    Learn
                  </label>
                  <label className="inline-flex items-center gap-1 text-[11px] text-text-muted cursor-pointer" title="Keep routing on current learning version; block relearn">
                    <input
                      type="checkbox"
                      className="rounded border-border"
                      checked={!!strategy.freezeLearning}
                      onChange={(e) => onSetStrategy({ freezeLearning: e.target.checked })}
                    />
                    Freeze
                  </label>
                  <button
                    type="button"
                    disabled={learnBusy || !!strategy.freezeLearning}
                    onClick={async () => {
                      setLearnBusy(true);
                      setLearnMsg("");
                      try {
                        const r = await fetch("/api/routing/learn", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ comboName: combo.name }),
                        });
                        const data = await r.json();
                        setLearnMsg(data.message || (data.ok ? "Done" : data.error || "Failed"));
                      } catch (e) {
                        setLearnMsg(e.message || "Failed");
                      } finally {
                        setLearnBusy(false);
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
                    title="Run learning optimizer on recent routing events"
                  >
                    <span className="material-symbols-outlined text-[13px]">psychology</span>
                    {learnBusy ? "Learning…" : "Relearn now"}
                  </button>
                  <a
                    href={`/dashboard/combos/routing?combo=${encodeURIComponent(combo.name)}`}
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:text-primary hover:border-primary/40"
                  >
                    Insights
                  </a>
                </div>
                {/* Learning controls (DASHBOARD.md) */}
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-text-muted">
                  <label className="inline-flex items-center gap-1">
                    Window
                    <select
                      value={strategy.learningWindowDays ?? 14}
                      onChange={(e) =>
                        onSetStrategy({ learningWindowDays: Number(e.target.value) || 14 })
                      }
                      className="rounded border border-border bg-surface-2 px-1 py-0.5 text-[11px] text-text-main"
                    >
                      <option value={7}>7d</option>
                      <option value={14}>14d</option>
                      <option value={30}>30d</option>
                    </select>
                  </label>
                  <label className="inline-flex items-center gap-1" title="Epsilon-greedy exploration (capped at 20%)">
                    Explore
                    <select
                      value={Math.round((strategy.explorationRate ?? 0.05) * 100)}
                      onChange={(e) =>
                        onSetStrategy({ explorationRate: Number(e.target.value) / 100 })
                      }
                      className="rounded border border-border bg-surface-2 px-1 py-0.5 text-[11px] text-text-main"
                    >
                      {[0, 5, 10, 15, 20].map((p) => (
                        <option key={p} value={p}>{p}%</option>
                      ))}
                    </select>
                  </label>
                  <label className="inline-flex items-center gap-1" title="0 = manual relearn only">
                    Auto-relearn
                    <select
                      value={strategy.autoLearnIntervalHours ?? 0}
                      onChange={(e) =>
                        onSetStrategy({ autoLearnIntervalHours: Number(e.target.value) || 0 })
                      }
                      className="rounded border border-border bg-surface-2 px-1 py-0.5 text-[11px] text-text-main"
                    >
                      <option value={0}>off</option>
                      <option value={6}>6h</option>
                      <option value={12}>12h</option>
                      <option value={24}>24h</option>
                      <option value={72}>72h</option>
                    </select>
                  </label>
                  <label className="inline-flex items-center gap-1" title="Capacity pre-filter before router (vision/PDF)">
                    <input
                      type="checkbox"
                      className="rounded border-border"
                      checked={strategy.capacityAutoSwitch !== false}
                      onChange={(e) => onSetStrategy({ capacityAutoSwitch: e.target.checked })}
                    />
                    Heuristic first
                  </label>
                  <label
                    className="inline-flex items-center gap-1"
                    title="Emit X-Auto-Router-* response headers (worker, cluster, score, skipped)"
                  >
                    <input
                      type="checkbox"
                      className="rounded border-border"
                      checked={strategy.emitAutoRouterHeaders !== false}
                      onChange={(e) =>
                        onSetStrategy({ emitAutoRouterHeaders: e.target.checked })
                      }
                    />
                    Route headers
                  </label>
                </div>
                {learnMsg ? (
                  <p className="text-[11px] font-mono text-text-subtle">{learnMsg}</p>
                ) : (
                  <p className="text-[10px] text-text-subtle">
                    Worker pool = models list (router model excluded if listed). Every request re-routes.
                    Router must be a connected account (default claude/claude-opus-4-8).
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
          {/* Strategy selector — always visible */}
          <div className="w-full sm:w-[220px] flex flex-col gap-1.5">
            <Select
              options={STRATEGY_OPTIONS}
              value={current}
              onChange={(e) => onSetStrategy({ fallbackStrategy: e.target.value })}
              selectClassName="py-1.5 text-xs"
            />
            {!isAuto && (
              <label className="inline-flex items-center gap-1.5 text-[10px] text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-border"
                  checked={capacityAutoSwitch}
                  onChange={(e) => onSetStrategy({ capacityAutoSwitch: e.target.checked })}
                />
                Capacity auto-switch (vision/PDF first)
              </label>
            )}
          </div>

          <div className="grid grid-cols-3 gap-1 sm:flex">
            <button
              onClick={(e) => { e.stopPropagation(); onCopy(combo.name, `combo-${combo.id}`); }}
              className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
              title="Copy combo name"
            >
              <span className="material-symbols-outlined text-[18px]">
                {copied === `combo-${combo.id}` ? "check" : "content_copy"}
              </span>
              <span className="text-[10px] leading-tight">Copy</span>
            </button>
            <button
              onClick={onEdit}
              className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
              title="Edit"
            >
              <span className="material-symbols-outlined text-[18px]">edit</span>
              <span className="text-[10px] leading-tight">Edit</span>
            </button>
            <button
              onClick={onDelete}
              className="flex flex-col items-center rounded px-2 py-1 text-red-500 transition-colors hover:bg-red-500/10"
              title="Delete"
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
              <span className="text-[10px] leading-tight">Delete</span>
            </button>
          </div>
        </div>
      </div>

      {/* Judge model picker (single-select; combo members make natural judges too) */}
      <ModelSelectModal
        isOpen={showJudgeSelect}
        onClose={() => setShowJudgeSelect(false)}
        onSelect={(m) => { onSetStrategy({ judgeModel: m?.value || "" }); setShowJudgeSelect(false); }}
        activeProviders={activeProviders}
        title="Select Judge Model"
        addedModelValues={judge ? [judge] : []}
        closeOnSelect={true}
      />
      <ModelSelectModal
        isOpen={showRouterSelect}
        onClose={() => setShowRouterSelect(false)}
        onSelect={(m) => {
          onSetStrategy({ routerModel: m?.value || "" });
          setShowRouterSelect(false);
        }}
        activeProviders={activeProviders}
        title="Select Router Model"
        addedModelValues={routerModel ? [routerModel] : []}
        closeOnSelect={true}
      />
    </Card>
  );
}

function ModelItem({ id, index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    // no transition — prevents the CSS settle animation fighting React's re-render on drop
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 bg-black/[0.02] hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04] transition-colors ${isDragging ? "shadow-md ring-1 ring-primary/30" : ""}`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-primary active:cursor-grabbing shrink-0"
        title="Drag to reorder"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="4" r="2"/><circle cx="15" cy="4" r="2"/>
          <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
          <circle cx="9" cy="20" r="2"/><circle cx="15" cy="20" r="2"/>
        </svg>
      </button>

      {/* Index badge */}
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>

      {/* Inline editable model value */}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20"
        />
      ) : (
        <div
          className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          onClick={() => setEditing(true)}
          title="Click to edit"
        >
          {model}
        </div>
      )}

      {/* Priority arrows */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move up"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title="Move down"
        >
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>

      {/* Remove */}
      <button
        onClick={onRemove}
        className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all"
        title="Remove"
      >
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, kindFilter = null, initialStrategy = {} }) {
  // Initialize state with combo values; reset when modal re-opens (create key is stable)
  const [name, setName] = useState(combo?.name || "");
  const [models, setModels] = useState(combo?.models || []);
  const [strategy, setStrategy] = useState(initialStrategy.fallbackStrategy || "fallback");
  const [capacityAutoSwitch, setCapacityAutoSwitch] = useState(
    initialStrategy.capacityAutoSwitch !== false
  );
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Use stable index-based IDs so duplicates and similar names are handled correctly
  const modelItems = models.map((model, i) => ({ uid: `item-${i}`, model }));

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = modelItems.findIndex((m) => m.uid === active.id);
      const newIndex = modelItems.findIndex((m) => m.uid === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        setModels((prev) => arrayMove(prev, oldIndex, newIndex));
      }
    }
  };

  const fetchModalData = async () => {
    try {
      const aliasesRes = await fetch("/api/models/alias");
      if (!aliasesRes.ok) return;
      const aliasesData = await aliasesRes.json();
      setModelAliases(aliasesData.aliases || {});
    } catch (error) {
      reportClientError("Error fetching modal data:", error);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    // Reset form every open — create modal uses key="create" so remount alone is not enough
    setName(combo?.name || "");
    setModels(combo?.models || []);
    setStrategy(initialStrategy.fallbackStrategy || "fallback");
    setCapacityAutoSwitch(initialStrategy.capacityAutoSwitch !== false);
    setShowModelSelect(false);
    setSaving(false);
    setNameError("");
    fetchModalData();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed when open toggles / edit target changes
  }, [isOpen, combo?.id, combo?.name]);

  const validateName = (value) => {
    if (!value.trim()) {
      setNameError("Name is required");
      return false;
    }
    if (!VALID_NAME_REGEX.test(value)) {
      setNameError("Only letters, numbers, -, _ and . allowed");
      return false;
    }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    const value = e.target.value;
    setName(value);
    if (value) validateName(value);
    else setNameError("");
  };

  const handleAddModel = (model) => {
    if (!models.includes(model.value)) {
      setModels([...models, model.value]);
    }
  };

  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => m !== model.value));
  };

  const handleRemoveModel = (index) => {
    setModels(models.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const newModels = [...models];
    [newModels[index - 1], newModels[index]] = [newModels[index], newModels[index - 1]];
    setModels(newModels);
  };

  const handleMoveDown = (index) => {
    if (index === models.length - 1) return;
    const newModels = [...models];
    [newModels[index], newModels[index + 1]] = [newModels[index + 1], newModels[index]];
    setModels(newModels);
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    if (models.length === 0) {
      reportClientError("Add at least one model to the combo");
      return;
    }
    if (strategy === "auto" && models.length < 2) {
      reportClientError("Auto strategy needs at least 2 models in the worker pool (plus a connected router account)");
      return;
    }
    setSaving(true);
    await onSave({
      name: name.trim(),
      models,
      strategy,
      capacityAutoSwitch: strategy === "auto" ? true : capacityAutoSwitch,
    });
    setSaving(false);
  };

  const isEdit = !!combo;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={isEdit ? "Edit Combo" : "Create Combo"}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-muted leading-relaxed">
            Clients call this combo by name as the <code className="text-primary">model</code> field.
            Strategy controls how models in the list are used.
          </p>

          {/* Name */}
          <div>
            <Input
              label="Combo Name"
              value={name}
              onChange={handleNameChange}
              placeholder="my-combo"
              error={nameError}
            />
            <p className="text-[10px] text-text-muted mt-0.5">
              Only letters, numbers, -, _ and . allowed · use as model id in /v1
            </p>
          </div>

          {/* Strategy */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">Strategy</label>
            <Select
              options={STRATEGY_OPTIONS}
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              selectClassName="py-2 text-sm"
            />
            <p className="text-[11px] text-text-muted mt-1.5">
              {STRATEGY_HELP[strategy]}
            </p>
            {strategy !== "auto" && (
              <label className="mt-2 inline-flex items-center gap-2 text-xs text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded border-border"
                  checked={capacityAutoSwitch}
                  onChange={(e) => setCapacityAutoSwitch(e.target.checked)}
                />
                Capacity auto-switch — prefer vision/PDF-capable models when the request needs them
              </label>
            )}
            {strategy === "auto" && (
              <p className="text-[11px] text-text-subtle mt-1.5 font-mono">
                After create: set Router model on the combo card (must be a connected account).
                Workers = this model list (router excluded if listed).
              </p>
            )}
            {strategy === "fusion" && (
              <p className="text-[11px] text-text-subtle mt-1.5 font-mono">
                After create: optionally set Judge on the combo card (default = first model).
              </p>
            )}
          </div>

          {/* Models */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              Models {strategy === "fallback" ? "(order = priority)" : "(pool)"}
            </label>

            {models.length === 0 ? (
              <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                <p className="text-xs text-text-muted">No models added yet</p>
              </div>
            ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
              <SortableContext items={modelItems.map((m) => m.uid)} strategy={verticalListSortingStrategy}>
                <div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
                  {modelItems.map(({ uid, model }, index) => (
                    <ModelItem
                      key={uid}
                      id={uid}
                      index={index}
                      model={model}
                      isFirst={index === 0}
                      isLast={index === modelItems.length - 1}
                      onEdit={(newVal) => {
                        const updated = [...models];
                        updated[index] = newVal;
                        setModels(updated);
                      }}
                      onMoveUp={() => handleMoveUp(index)}
                      onMoveDown={() => handleMoveDown(index)}
                      onRemove={() => handleRemoveModel(index)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            )}

            {/* Add Model button */}
            <button
              onClick={() => setShowModelSelect(true)}
              className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              Add Model
            </button>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              fullWidth
              size="sm"
              disabled={!name.trim() || !!nameError || saving}
            >
              {saving ? "Saving..." : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Model Select Modal */}
      <ModelSelectModal
        isOpen={showModelSelect}
        onClose={() => setShowModelSelect(false)}
        onSelect={handleAddModel}
        onDeselect={handleDeselectModel}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title="Add Model to Combo"
        kindFilter={kindFilter}
        addedModelValues={models}
        closeOnSelect={false}
      />
    </>
  );
}
