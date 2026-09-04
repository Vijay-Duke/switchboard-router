// @ts-check
// Keyboard-reachable expand/collapse header for tool cards (T35). Spread onto
// the header <div>; Enter/Space toggle like a native button. Nested controls
// keep their own keyboard behaviour because only the header itself is handled.
export function cardHeaderToggleProps(onToggle, isExpanded, name) {
  return {
    role: "button",
    tabIndex: 0,
    "aria-expanded": Boolean(isExpanded),
    "aria-label": `${isExpanded ? "Collapse" : "Expand"} ${name} settings`,
    onClick: onToggle,
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onToggle();
      }
    },
  };
}
