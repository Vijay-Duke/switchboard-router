/**
 * AWS region validation for URL interpolation.
 *
 * Mirrors `assertValidAwsRegion` in src/lib/oauth/constants/oauth.js — open-sse
 * is provider-agnostic and cannot import from src/, so the allowlist lives in
 * both layers. Any region reaching a `https://svc.${region}.amazonaws.com` URL
 * must pass through here first (GHSA-6mwv-4mrm-5p3m).
 */

export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

export function isValidAwsRegion(region) {
  return typeof region === "string" && AWS_REGION_PATTERN.test(region);
}

/** Return `region` if it is a real AWS region, else `fallback`. Never throws. */
export function safeAwsRegion(region, fallback = "us-east-1") {
  return isValidAwsRegion(region) ? region : fallback;
}
