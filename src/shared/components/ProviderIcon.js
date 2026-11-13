"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Image from "next/image";

function resolveIconSource(src) {
  if (/^\/providers\/(?:openai-compatible-|custom-embedding-)[^/]+\.png$/.test(src || "")) return "/providers/openai.png";
  if (/^\/providers\/anthropic-compatible-[^/]+\.png$/.test(src || "")) return "/providers/anthropic.png";
  return src;
}

export default function ProviderIcon({
  src,
  alt,
  size = 32,
  className = "",
  fallbackText = "?",
  fallbackColor,
}) {
  const [failedSrc, setFailedSrc] = useState(null);
  const imageSrc = resolveIconSource(src);

  if (!imageSrc || failedSrc === imageSrc) {
    return (
      <span
        className={`inline-flex items-center justify-center font-bold rounded-lg ${className}`.trim()}
        style={{
          width: size,
          height: size,
          color: fallbackColor,
          fontSize: Math.max(10, Math.floor(size * 0.38)),
        }}
      >
        {fallbackText}
      </span>
    );
  }

  return (
    <Image
      src={imageSrc}
      alt={alt}
      width={size}
      height={size}
      unoptimized
      className={className}
      onError={() => setFailedSrc(imageSrc)}
    />
  );
}

ProviderIcon.propTypes = {
  src: PropTypes.string,
  alt: PropTypes.string,
  size: PropTypes.number,
  className: PropTypes.string,
  fallbackText: PropTypes.string,
  fallbackColor: PropTypes.string,
};
