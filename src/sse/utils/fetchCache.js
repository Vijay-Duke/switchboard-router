import { createHash } from "node:crypto";
import { putFetchCache } from "@/lib/db/repos/fetchCacheRepo.js";

function normalizeUrlHost(value) {
  const url = String(value || "").trim();
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return url;
  const authorityStart = schemeEnd + 3;
  const authorityEnd = url.slice(authorityStart).search(/[/?#]/);
  const end = authorityEnd < 0 ? url.length : authorityStart + authorityEnd;
  const authority = url.slice(authorityStart, end);
  const at = authority.lastIndexOf("@");
  return `${url.slice(0, authorityStart)}${authority.slice(0, at + 1)}${authority.slice(at + 1).toLowerCase()}${url.slice(end)}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function cacheKey(prefix, value) {
  return createHash("sha256").update(`${prefix}:${JSON.stringify(stableValue(value))}`).digest("hex");
}

export function getFetchCacheTtlMs(settings) {
  const hours = Number(settings?.tokenSaver?.fetchCacheTtlHours ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return hours * 3600 * 1000;
}

export function buildFetchCacheKey(body, provider) {
  return cacheKey("fetch", {
    provider,
    url: normalizeUrlHost(body.url),
    format: body.format ?? null,
    maxCharacters: body.max_characters ?? null,
  });
}

export function buildSearchCacheKey(body, provider) {
  return cacheKey("search", {
    provider,
    query: String(body.query || "").trim(),
    maxResults: body.max_results ?? null,
    searchType: body.search_type ?? null,
    country: body.country ?? null,
    language: body.language ?? null,
    timeRange: body.time_range ?? null,
    offset: body.offset ?? null,
    domainFilter: body.domain_filter ?? null,
    contentOptions: body.content_options ?? null,
    providerOptions: body.provider_options ?? null,
  });
}

export function fetchCacheHitResponse(hit) {
  return new Response(hit.content, {
    headers: {
      "Content-Type": hit.contentType || "application/json",
      "X-Switchboard-Cache": "hit",
    },
  });
}

export async function cacheLiveResponse(response, cache, log) {
  try {
    const contentType = response?.headers?.get("content-type") || "application/json";
    const normalizedType = contentType.toLowerCase();
    if (!response?.ok || normalizedType.includes("text/event-stream") || normalizedType.includes("ndjson")) return response;

    const content = await response.clone().text();
    await putFetchCache({ ...cache, content, contentType });
    log.info(cache.kind.toUpperCase(), `cache stored ${cache.url}`);
  } catch {}
  return response;
}
