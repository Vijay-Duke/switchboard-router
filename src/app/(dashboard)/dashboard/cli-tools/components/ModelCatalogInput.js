"use client";
// @ts-check

/**
 * @param {object} props
 * @param {string[]} props.models
 * @param {string} props.draft
 * @param {(value: string) => void} props.onDraftChange
 * @param {() => void} props.onAdd
 * @param {(model: string) => void} props.onRemove
 * @param {() => void} props.onOpenPicker
 * @param {boolean} props.canOpenPicker
 * @param {string} [props.defaultModel]
 * @param {(model: string) => void} [props.onDefaultChange]
 * @param {string} [props.label]
 */
export default function ModelCatalogInput({
  models,
  draft,
  onDraftChange,
  onAdd,
  onRemove,
  onOpenPicker,
  canOpenPicker,
  defaultModel,
  onDefaultChange,
  label = "Models",
}) {
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-start sm:gap-2">
      <span className="text-xs font-semibold text-text-main sm:pt-1.5 sm:text-right sm:text-sm">
        {label} {models.length > 0 ? <span className="text-primary">({models.length})</span> : null}
      </span>
      <span className="material-symbols-outlined hidden pt-1.5 text-text-muted text-[14px] sm:inline">
        arrow_forward
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-h-8 flex-wrap gap-1.5 rounded border border-border bg-surface px-2 py-1.5">
          {models.length === 0 ? (
            <span className="text-xs text-text-muted">No models selected</span>
          ) : (
            models.map((model) => {
              const isDefault = Boolean(onDefaultChange) && model === defaultModel;
              return (
                <span
                  key={model}
                  className={`inline-flex max-w-full items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                    isDefault ? "border-primary bg-primary/10 text-primary" : "border-transparent bg-black/5 text-text-muted dark:bg-white/5"
                  }`}
                >
                  {onDefaultChange ? (
                    <button
                      type="button"
                      onClick={() => onDefaultChange(model)}
                      className="inline-flex items-center"
                      title={isDefault ? "Default model" : "Set as default"}
                      aria-label={isDefault ? `${model} is the default model` : `Set ${model} as default model`}
                    >
                      <span className="material-symbols-outlined text-[12px]">{isDefault ? "star" : "star_outline"}</span>
                    </button>
                  ) : null}
                  <span className="truncate font-mono">{model}</span>
                  <button
                    type="button"
                    onClick={() => onRemove(model)}
                    className="ml-0.5 inline-flex hover:text-red-500"
                    title={`Remove ${model}`}
                    aria-label={`Remove ${model}`}
                  >
                    <span className="material-symbols-outlined text-[12px]">close</span>
                  </button>
                </span>
              );
            })
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row">
          <input
            type="text"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onAdd();
              }
            }}
            placeholder="provider/model-id"
            className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
          />
          <button
            type="button"
            onClick={onOpenPicker}
            disabled={!canOpenPicker}
            className={`rounded border px-2 py-1.5 text-xs ${
              canOpenPicker ? "cursor-pointer border-border bg-surface hover:border-primary" : "cursor-not-allowed border-border opacity-50"
            }`}
          >
            Select
          </button>
          <button
            type="button"
            onClick={onAdd}
            disabled={!draft.trim()}
            className="rounded border border-border bg-surface px-2 py-1.5 text-xs hover:border-primary disabled:opacity-50"
          >
            Add
          </button>
        </div>
        {onDefaultChange && models.length > 0 ? (
          <span className="text-[11px] text-text-muted">Select the star to choose the default model.</span>
        ) : null}
      </div>
    </div>
  );
}
