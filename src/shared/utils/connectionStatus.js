export function getStatusVariant(isActive, effectiveStatus) {
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  // "partial" = some models cooling down, the connection still serves its
  // siblings (issue #46). Amber, so it does not read as a dead account the way
  // the red "unavailable" badge did. Badge already ships a warning variant.
  if (effectiveStatus === "partial") return "warning";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable" || effectiveStatus === "needs-reauth") return "error";
  return "default";
}
