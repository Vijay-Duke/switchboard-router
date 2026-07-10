"use client";

import { ConfirmModal } from "@/shared/components/Modal";
import { useConfirmationStore } from "@/store/confirmationStore";

export default function GlobalConfirmModal() {
  const request = useConfirmationStore((state) => state.request);
  const settle = useConfirmationStore((state) => state.settle);

  return (
    <ConfirmModal
      isOpen={Boolean(request)}
      onClose={() => settle(false)}
      onConfirm={() => settle(true)}
      title={request?.title || "Confirm"}
      message={request?.message || "Continue?"}
      confirmText={request?.confirmText || "Confirm"}
      cancelText={request?.cancelText || "Cancel"}
      variant={request?.variant || "danger"}
    />
  );
}
