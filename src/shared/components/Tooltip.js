"use client";

import { useId, cloneElement, isValidElement } from "react";

export default function Tooltip({ text, children, position = "top", color }) {
  const tipId = useId();
  const posClass = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  }[position];

  const bgStyle = color ? { backgroundColor: color } : {};
  const bgClass = color ? "" : "bg-gray-900";

  // Merge with any aria-describedby the child already carries (e.g. Input error ids).
  const describedChildren = isValidElement(children)
    ? cloneElement(children, {
        "aria-describedby": [children.props["aria-describedby"], tipId].filter(Boolean).join(" "),
      })
    : children;

  return (
    <div className="relative inline-flex group/tt">
      {describedChildren}
      <div
        id={tipId}
        role="tooltip"
        className={`pointer-events-none absolute ${posClass} z-50 w-max max-w-56 rounded px-2 py-1 text-[11px] leading-snug ${bgClass} text-white opacity-0 group-hover/tt:opacity-100 group-has-focus-visible/tt:opacity-100 transition-opacity duration-150 whitespace-normal`}
        style={bgStyle}
      >
        {text}
      </div>
    </div>
  );
}
