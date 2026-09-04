"use client";

import Modal from "./Modal";
import Button from "./Button";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { reportClientError } from "@/shared/utils/clientFeedback";

export default function ManualConfigModal({ isOpen, onClose, title = "Manual Configuration", configs = [] }) {
  // The hook's `copied` id drives the "Copied!" UI (and resets itself), so a
  // failed copy can never show a false "Copied!".
  const { copied, copy } = useCopyToClipboard();

  const copyConfig = async (text, index) => {
    const ok = await copy(text, `manualconfig-${index}`);
    if (!ok) reportClientError("Failed to copy to clipboard");
  };

  const isCopied = (index) => copied === `manualconfig-${index}`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="xl">
      <div className="flex flex-col gap-4">
        {configs.map((config, index) => (
          <div key={index} className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-main">{config.filename}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyConfig(config.content, index)}
              >
                <span className="material-symbols-outlined text-[14px] mr-1">
                  {isCopied(index) ? "check" : "content_copy"}
                </span>
                {isCopied(index) ? "Copied!" : "Copy"}
              </Button>
            </div>
            <pre className="px-3 py-2 bg-black/5 dark:bg-white/5 rounded font-mono text-xs overflow-x-auto whitespace-pre-wrap break-all max-h-60 overflow-y-auto border border-border">
              {config.content}
            </pre>
          </div>
        ))}
      </div>
    </Modal>
  );
}
