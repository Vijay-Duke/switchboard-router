import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const combosClient = "src/app/(dashboard)/dashboard/combos/CombosPageClient.js";
const mitmToolCard = "src/app/(dashboard)/dashboard/cli-tools/components/MitmToolCard.js";
const mitmServerCard = "src/app/(dashboard)/dashboard/cli-tools/components/MitmServerCard.js";
const newProviderPage = "src/app/(dashboard)/dashboard/providers/new/page.js";
const connectionRow = "src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js";
const modelRow = "src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js";
const exampleShared = "src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/exampleShared.js";
const mediaRoot = "src/app/(dashboard)/dashboard/media-providers";
const exampleCards = [
  "[kind]/[id]/components/EmbeddingExampleCard.js",
  "[kind]/[id]/components/GenericExampleCard.js",
  "[kind]/[id]/components/SttExampleCard.js",
  "[kind]/[id]/components/TtsExampleCard.js",
];

describe("provider & media a11y fixes (QA-010/013/014/030/032/033/034)", () => {
  it("QA-010: combo model row value is a keyboard-activatable button", () => {
    const src = read(combosClient);
    // The non-editing model value exposes button semantics and opens on Enter/Space
    const inlineEdit = src.match(/role="button"[\s\S]{0,600}?aria-label=\{`Edit model \$\{model\}`\}/);
    expect(inlineEdit, "inline editor exposes role=button with row-context label").toBeTruthy();
    expect(src).toContain("tabIndex={0}");
    expect(src).toMatch(/onKeyDown=\{\(e\) => \{[\s\S]{0,200}?e\.key === "Enter" \|\| e\.key === " "/);
  });

  it("QA-013: media example keys are user-entered password inputs and never hydrated", () => {
    const targets = [...exampleCards, "combo/[id]/page.js"];
    for (const target of targets) {
      const src = read(path.join(mediaRoot, target));
      expect(src, target).not.toContain('fetch("/api/keys"');
      expect(src, target).toContain("!apiKey.trim()");
      // Run requires an explicit key; the key field must be an enterable input,
      // never a read-only masked span or an auto-filled masked value.
      expect(src, target).toMatch(/type="password"/);
      expect(src, target).not.toMatch(/No key configured/);
    }
  });

  it("QA-014: MITM tool card expander is keyboard-activatable and stateful", () => {
    const src = read(mitmToolCard);
    expect(src).toContain('role="button"');
    expect(src).toContain("tabIndex={0}");
    expect(src).toContain("aria-expanded={isExpanded}");
    expect(src).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
  });

  it("QA-030: example card fields are programmatically labelled", () => {
    // Row renders a real <label htmlFor> when given one
    const row = read(exampleShared);
    expect(row).toContain('LabelTag = htmlFor ? "label" : "span"');
    expect(row).toMatch(/htmlFor=\{htmlFor\}/);
    for (const card of exampleCards) {
      const src = read(path.join(mediaRoot, card));
      const labelled = (src.match(/htmlFor="/g) || []).length;
      const ids = (src.match(/\bid="/g) || []).length;
      expect(labelled, `${card} associates visible Row labels`).toBeGreaterThan(0);
      expect(ids, `${card} gives controls ids`).toBeGreaterThan(0);
    }
  });

  it("QA-032: raw modals inside owned files expose dialog semantics + Escape", () => {
    const tts = read(path.join(mediaRoot, "[kind]/[id]/components/TtsExampleCard.js"));
    expect(tts).toContain('role="dialog"');
    expect(tts).toContain('aria-modal="true"');
    expect(tts).toMatch(/aria-labelledby="tts-language-modal-title"/);
    expect(tts).toMatch(/if \(e\.key === "Escape"\) setModalOpen\(false\)/);

    const tool = read(mitmToolCard);
    expect(tool).toContain('role="dialog"');
    expect(tool).toContain('aria-modal="true"');
    expect(tool).toMatch(/aria-labelledby="mitm-tool-sudo-title"/);

    // MITM server sudo confirmation rides the shared Modal (dialog semantics from Modal.js)
    const server = read(mitmServerCard);
    expect(server).toMatch(/<Modal[\s\S]{0,200}?title="Sudo Password Required"/);
  });

  it("QA-033: new-provider labels associate and errors alert", () => {
    const page = read(newProviderPage);
    expect(page).toContain('role="radiogroup"');
    expect(page).toContain('aria-labelledby="new-provider-auth-method-label"');
    expect(page).toContain("aria-checked={formData.authMethod === method.value}");
    expect(page).toMatch(/role="alert"/);

    // Root fix lives in the shared form controls every field renders through
    for (const shared of ["src/shared/components/Input.js", "src/shared/components/Select.js"]) {
      const src = read(shared);
      expect(src).toContain("useId()");
      expect(src).toMatch(/htmlFor=\{id\}/);
      expect(src).toContain('aria-invalid={error ? "true" : undefined}');
      expect(src).toMatch(/role="alert"/);
      expect(src).toContain("aria-describedby={describedBy}");
    }
  });

  it("QA-034: provider icon actions expose task-oriented names with row context", () => {
    const conn = read(connectionRow);
    expect(conn).toMatch(/aria-label=\{`Move \$\{displayName\} up`\}/);
    expect(conn).toMatch(/aria-label=\{`Move \$\{displayName\} down`\}/);

    const model = read(modelRow);
    expect(model).toMatch(/aria-label=\{isTesting \? `Testing \$\{displayModel\}` : `Test \$\{displayModel\}`\}/);
    expect(model).toMatch(/`Copy \$\{displayModel\}`/);
    expect(model).toMatch(/aria-label=\{`Remove custom model \$\{displayModel\}`\}/);
    expect(model).toMatch(/aria-label=\{`Disable \$\{displayModel\}`\}/);
  });
});
