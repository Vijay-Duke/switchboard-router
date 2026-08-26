// @ts-check
import PropTypes from "prop-types";
import { CapacityBadges } from "@/shared/components";

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, caps, thinkingSuffix, latencyMs, probeState }) {
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const isOk = testStatus === "ok" || probeState === "ok";
  const isDead = testStatus === "error" || probeState === "dead";
  const isPending = probeState === "retry" || isTesting || probeState === "testing";

  const borderColor = isOk
    ? "border-green-500/30 hover:border-green-500/50"
    : isDead
    ? "border-red-500/30 hover:border-red-500/50"
    : isPending
    ? "border-amber-500/30 hover:border-amber-500/50"
    : "border-border/60 hover:border-primary/40";

  return (
    <div className={`group relative min-w-0 max-w-full rounded-xl border bg-surface/50 p-3 transition-all hover:bg-surface/80 hover:shadow-soft ${borderColor}`}>
      <div className="flex min-w-0 items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          {/* Status icon / model avatar */}
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 border border-border/40 text-text-muted">
            {isTesting || probeState === "testing" ? (
              <span className="material-symbols-outlined shrink-0 animate-spin text-[15px] text-primary" title="Testing model...">progress_activity</span>
            ) : isOk ? (
              <span className="material-symbols-outlined shrink-0 text-[16px] text-green-500" title="Model reachable">check_circle</span>
            ) : isDead ? (
              <span className="material-symbols-outlined shrink-0 text-[16px] text-red-500" title="Model unavailable">cancel</span>
            ) : probeState === "retry" ? (
              <span className="material-symbols-outlined shrink-0 text-[16px] text-amber-500" title="Retry later">schedule</span>
            ) : (
              <span className="material-symbols-outlined shrink-0 text-[16px]" aria-hidden="true">smart_toy</span>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <code className="max-w-[70vw] truncate rounded-md bg-surface-2 border border-border/40 px-2 py-0.5 font-mono text-xs font-medium text-text-main sm:max-w-[340px]">
                {displayModel}
              </code>
              {isCustom && (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  Custom
                </span>
              )}
            </div>

            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
              {model.name && (
                <span className="truncate text-xs text-text-muted">
                  {model.name}
                </span>
              )}
              {Number.isFinite(latencyMs) && (
                <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-text-muted tabular-nums">
                  <span className="material-symbols-outlined text-[12px] text-primary">bolt</span>
                  {Math.round(latencyMs)}ms
                </span>
              )}
              <CapacityBadges caps={caps} colorOverride="text-text-muted/80" size={13} />
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 shrink-0">
          {onTest && (
            <button
              onClick={onTest}
              disabled={isTesting}
              aria-label={isTesting ? `Testing ${displayModel}` : `Test ${displayModel}`}
              title={isTesting ? "Testing..." : "Test model"}
              className={`rounded-lg p-1 text-text-muted transition-all hover:bg-surface-2 hover:text-primary ${isTesting ? "opacity-100" : "opacity-70 group-hover:opacity-100"}`}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                {isTesting ? "progress_activity" : "science"}
              </span>
            </button>
          )}
          <button
            onClick={() => onCopy(displayModel, `model-${model.id}`)}
            aria-label={copied === `model-${model.id}` ? `Copied ${displayModel}` : `Copy ${displayModel}`}
            title={copied === `model-${model.id}` ? "Copied!" : "Copy model name"}
            className="rounded-lg p-1 text-text-muted transition-all hover:bg-surface-2 hover:text-primary opacity-70 group-hover:opacity-100"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              {copied === `model-${model.id}` ? "check" : "content_copy"}
            </span>
          </button>
          {isCustom ? (
            <button
              onClick={onDeleteAlias}
              className="rounded-lg p-1 text-text-muted transition-all hover:bg-red-500/10 hover:text-red-400 opacity-60 hover:opacity-100"
              aria-label={`Remove custom model ${displayModel}`}
              title="Remove custom model"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
            </button>
          ) : onDisable ? (
            <button
              onClick={onDisable}
              className="rounded-lg p-1 text-text-muted transition-all hover:bg-red-500/10 hover:text-red-400 opacity-60 hover:opacity-100"
              aria-label={`Disable ${displayModel}`}
              title="Disable this model"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
  latencyMs: PropTypes.number,
  probeState: PropTypes.string,
};
