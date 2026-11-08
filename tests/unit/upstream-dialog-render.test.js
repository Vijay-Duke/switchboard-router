// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { h } from "./dashboard-dom-harness.js";
import AddApiKeyModal from "@/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js";
import AddCustomModelModal from "@/app/(dashboard)/dashboard/providers/[id]/AddCustomModelModal.js";
import AutoPingScheduleModal from "@/app/(dashboard)/dashboard/providers/[id]/AutoPingScheduleModal.js";
import BulkImportGrokCliModal from "@/app/(dashboard)/dashboard/providers/[id]/BulkImportGrokCliModal.js";
import SmartPolicyModal from "@/shared/components/SmartPolicyModal.js";
import ZedAuthModal from "@/shared/components/ZedAuthModal.js";

// Exercise actual dialog children: a closed Modal does not prevent its parent
// from evaluating JSX. This catches the same class of crash as KeyPolicyModal.
const dialogs = [
  ...["bedrock", "bedrock-xai", "qoder", "qoder-cn", "nous", "minimax-code", "minimax-code-global"].map((provider) => [
    `${provider} credentials`, AddApiKeyModal, { provider, providerName: provider },
  ]),
  ["custom model", AddCustomModelModal, { providerAlias: "oc" }],
  ["auto-ping", AutoPingScheduleModal, { connection: null, schedule: null }],
  ["Grok bulk import", BulkImportGrokCliModal, {}],
  ["Smart Router", SmartPolicyModal, { comboName: null }],
  ["Zed login", ZedAuthModal, { providerInfo: null }],
];

describe.each(dialogs)("%s render", (_name, Component, props) => {
  it.each([false, true])("renders with isOpen=%s before any user input", (isOpen) => {
    const html = renderToString(h(Component, {
      ...props, isOpen, onClose: vi.fn(), onSave: vi.fn(), onSuccess: vi.fn(),
    }));
    if (isOpen) expect(html).toContain('role="dialog"');
    else expect(html).toBe("");
  });
});
