import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

const requestDetails = read(
  "src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js",
);
const usageTable = read(
  "src/app/(dashboard)/dashboard/usage/components/UsageTable.js",
);
const usageStats = read("src/shared/components/UsageStats.js");
const requestLogger = read("src/shared/components/RequestLogger.js");
const pagination = read("src/shared/components/Pagination.js");
const segmentedControl = read("src/shared/components/SegmentedControl.js");

describe("usage request details error vs empty states (QA-018)", () => {
  it("tracks fetch errors separately from an empty result set", () => {
    expect(requestDetails).toContain("const [error, setError] = useState(null)");
    expect(requestDetails).toContain("if (!res.ok)");
    expect(requestDetails).toContain("setError(err?.message");
  });

  it("renders a distinguishable error state with a retry action", () => {
    expect(requestDetails).toContain(") : error ? (");
    expect(requestDetails).toContain('role="alert"');
    expect(requestDetails).toContain("Failed to load request details");
    // Retry must re-run the same fetch path.
    expect(requestDetails).toContain('onClick={() => fetchDetails()}');
    // The genuine empty state stays separate from the error state.
    expect(requestDetails).toContain("No request details found");
    expect(requestDetails.indexOf(") : error ? (")).toBeLessThan(
      requestDetails.indexOf("No request details found"),
    );
  });
});

describe("usage date range validation (QA-019)", () => {
  it("guards the fetch against inverted ranges", () => {
    expect(requestDetails).toContain("function isDateRangeInverted(");
    expect(requestDetails).toContain("if (isDateRangeInverted(filters)) return;");
  });

  it("explains the constraint and marks the offending inputs", () => {
    expect(requestDetails).toContain(
      "Start Date must be on or before End Date.",
    );
    expect(requestDetails).toContain("aria-invalid={dateRangeInvalid || undefined}");
    expect(requestDetails.match(/aria-invalid=\{dateRangeInvalid/g).length).toBe(2);
    expect(requestDetails).toContain(
      'aria-describedby={dateRangeInvalid ? "usage-date-range-error" : undefined}',
    );
  });
});

describe("request logs auto refresh switch (QA-020)", () => {
  it("exposes switch semantics on a real button", () => {
    expect(requestLogger).toContain('role="switch"');
    expect(requestLogger).toContain("aria-checked={autoRefresh}");
    // A native button provides focus, Enter and Space activation.
    expect(requestLogger.match(/<button/g).length).toBeGreaterThan(0);
    expect(requestLogger).not.toContain('<div\n              onClick');
  });
});

describe("usage stats period failure handling (QA-021)", () => {
  it("surfaces fetch failures instead of keeping stale data silent", () => {
    expect(usageStats).toContain("const [statsError, setStatsError] = useState(null)");
    expect(usageStats).toContain("if (!r.ok) throw new Error");
    expect(usageStats).toContain("setStatsError(err?.message");
  });

  it("offers retry from both the empty-failure and stale-data states", () => {
    expect(usageStats).toContain("showing previously loaded data");
    expect(usageStats.match(/onClick=\{\(\) => loadStats\(/g).length).toBe(2);
  });
});

describe("usage table keyboard access (QA-022)", () => {
  it("makes sortable headers buttons with sort state", () => {
    expect(usageTable).toContain("aria-sort={getAriaSort(col.field)}");
    expect(usageTable.match(/aria-sort=\{getAriaSort\(col\.field\)\}/g).length).toBe(2);
    expect(usageTable).toContain("onClick={() => onToggleSort(tableType, col.field)}");
  });

  it("makes grouped rows keyboard-expandable with expanded state", () => {
    expect(usageTable).toContain(
      "aria-expanded={expanded.has(group.groupKey)}",
    );
    // Button click must not double-toggle through the row handler.
    expect(usageTable).toContain("e.stopPropagation();");
  });
});

describe("usage selection state exposure (QA-035)", () => {
  it("segments expose pressed state", () => {
    expect(segmentedControl).toContain(
      "aria-pressed={value === option.value}",
    );
  });

  it("period and view-mode buttons expose pressed state", () => {
    expect(usageStats).toContain("aria-pressed={period === p.value}");
    expect(usageStats).toContain('aria-pressed={viewMode === "costs"}');
    expect(usageStats).toContain('aria-pressed={viewMode === "tokens"}');
  });

  it("pagination exposes current page and purposeful labels", () => {
    expect(pagination).toContain(
      'aria-current={currentPage === page ? "page" : undefined}',
    );
    expect(pagination).toContain('aria-label="Previous page"');
    expect(pagination).toContain('aria-label="Next page"');
    expect(pagination).toContain('aria-label="Pagination"');
  });

  it("request collapsibles expose expanded/controls wiring", () => {
    expect(requestDetails).toContain("const panelId = useId();");
    expect(requestDetails).toContain("aria-expanded={isOpen}");
    expect(requestDetails).toContain("aria-controls={panelId}");
    expect(requestDetails).toContain('id={panelId}');
  });
});
