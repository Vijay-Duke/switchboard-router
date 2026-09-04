// Stored testStatus values that mean "needs attention". Shared by the badge
// variant map and the providers-page error counts so the two never disagree.
export function isErrorStatus(effectiveStatus) {
  return (
    effectiveStatus === "error" ||
    effectiveStatus === "expired" ||
    effectiveStatus === "unavailable" ||
    effectiveStatus === "reauth_required" ||
    effectiveStatus === "invalid"
  );
}

export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (isErrorStatus(effectiveStatus)) return "error";
  return "default";
}
