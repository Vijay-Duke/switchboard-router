import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import {
  getRefreshLeadMs,
  isUnrecoverableRefreshError,
  refreshTokenByProvider,
} from "./tokenRefresh.js";
import { PROVIDER_OAUTH } from "../providers/index.js";

// Single source: codex.oauth.maxRefreshAgeMs (8 days) — proactive refresh window
export const CODEX_MAX_REFRESH_AGE_MS = PROVIDER_OAUTH["codex"]?.maxRefreshAgeMs;

const refreshLocks = new Map();
const successfulRefreshes = new Map();
const refreshContext = new AsyncLocalStorage();
const providerSpecificRefreshUpdates = new WeakMap();
const receiptSources = new WeakMap();

// Central refresh results include historical metadata for execution. Persisting
// callers need the actual upstream delta, not the merged initiating snapshot.
export function getProviderSpecificRefreshUpdates(result) {
  return providerSpecificRefreshUpdates.get(result) || result?.providerSpecificData || {};
}

function tokenFields(value) {
  return {
    accessToken: value?.accessToken, refreshToken: value?.refreshToken,
    idToken: value?.idToken,
    copilotToken: value?.copilotToken ?? value?.providerSpecificData?.copilotToken,
  };
}

// Hooks often spread a result into a new payload. Recognize its successful
// token receipt without exposing provenance fields in public credential data.
export function getCredentialRefreshReceipt(connectionId, result) {
  const direct = receiptSources.get(result);
  if (direct && (direct.source.connectionId || direct.source.id) === connectionId) return direct;
  const tokens = tokenFields(result);
  const supplied = Object.keys(tokens).filter(key => tokens[key]);
  if (supplied.length === 0) return null;
  for (const entry of [...successfulRefreshes.values()].reverse()) {
    if ((entry.source.connectionId || entry.source.id) !== connectionId) continue;
    const issued = { ...tokenFields(entry.source), ...Object.fromEntries(
      Object.entries(tokenFields(entry.result)).filter(([, value]) => value),
    ) };
    if (supplied.every(key => issued[key] === tokens[key])) return entry;
  }
  return null;
}

function reuseRefreshReceipt(entry) {
  let result = entry.result;
  if (Number.isFinite(entry.expiresAt)) {
    result = {
      ...result, expiresAt: new Date(entry.expiresAt).toISOString(),
      expiresIn: Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000)),
    };
    providerSpecificRefreshUpdates.set(result, entry.providerSpecificUpdates);
    receiptSources.set(result, entry);
  }
  return result;
}

function parseTimeMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toExpiresAt(expiresIn, nowMs = Date.now()) {
  if (!expiresIn) return null;
  return new Date(nowMs + expiresIn * 1000).toISOString();
}

export function getCredentialExpiryMs(credentials) {
  return parseTimeMs(credentials?.expiresAt ?? credentials?.tokenExpiresAt);
}

export function getCredentialLastRefreshMs(credentials) {
  return parseTimeMs(
    credentials?.lastRefreshAt ??
    credentials?.lastRefresh ??
    credentials?.providerSpecificData?.lastRefreshAt
  );
}

export function isCodexRefreshStale(credentials, nowMs = Date.now(), maxAgeMs = CODEX_MAX_REFRESH_AGE_MS) {
  const lastRefreshMs = getCredentialLastRefreshMs(credentials);
  return !lastRefreshMs || nowMs - lastRefreshMs >= maxAgeMs;
}

export function shouldRefreshCredentials(provider, credentials, nowMs = Date.now()) {
  if (!credentials) return false;

  const expiresAtMs = getCredentialExpiryMs(credentials);
  if (expiresAtMs !== null && expiresAtMs - nowMs < getRefreshLeadMs(provider)) {
    return true;
  }

  // Proactive stale refresh for providers declaring oauth.maxRefreshAgeMs (e.g. codex)
  const maxAgeMs = PROVIDER_OAUTH[provider]?.maxRefreshAgeMs;
  if (maxAgeMs && credentials.refreshToken && isCodexRefreshStale(credentials, nowMs, maxAgeMs)) {
    return true;
  }

  return false;
}

export function mergeProviderSpecificData(existing, next) {
  if (!next || typeof next !== "object") return existing;
  return {
    ...(existing || {}),
    ...next,
  };
}

export function mergeRefreshedCredentials(provider, currentCredentials, refreshedCredentials, nowMs = Date.now()) {
  if (!refreshedCredentials) return null;
  if (isUnrecoverableRefreshError(refreshedCredentials)) return refreshedCredentials;

  const next = {};
  const nowIso = new Date(nowMs).toISOString();

  if (refreshedCredentials.accessToken) next.accessToken = refreshedCredentials.accessToken;
  if (refreshedCredentials.apiKey) next.apiKey = refreshedCredentials.apiKey;
  if (refreshedCredentials.token) next.token = refreshedCredentials.token;

  const refreshToken = refreshedCredentials.refreshToken ?? currentCredentials?.refreshToken;
  if (refreshToken) next.refreshToken = refreshToken;

  const idToken = refreshedCredentials.idToken ?? currentCredentials?.idToken;
  if (idToken) next.idToken = idToken;

  if (refreshedCredentials.expiresIn) {
    next.expiresIn = refreshedCredentials.expiresIn;
    next.expiresAt = toExpiresAt(refreshedCredentials.expiresIn, nowMs);
  } else if (refreshedCredentials.expiresAt) {
    next.expiresAt = refreshedCredentials.expiresAt;
  }

  if (refreshedCredentials.projectId) next.projectId = refreshedCredentials.projectId;

  if (refreshedCredentials.providerSpecificData) {
    next.providerSpecificData = mergeProviderSpecificData(
      currentCredentials?.providerSpecificData,
      refreshedCredentials.providerSpecificData
    );
  }

  if (refreshedCredentials.copilotToken) next.copilotToken = refreshedCredentials.copilotToken;
  if (refreshedCredentials.copilotTokenExpiresAt) {
    next.copilotTokenExpiresAt = refreshedCredentials.copilotTokenExpiresAt;
  }

  // trackRefreshAt providers (e.g. codex) always stamp lastRefreshAt for staleness tracking
  if (
    PROVIDER_OAUTH[provider]?.trackRefreshAt ||
    next.accessToken ||
    next.apiKey ||
    next.token ||
    next.refreshToken ||
    next.copilotToken
  ) {
    next.lastRefreshAt = refreshedCredentials.lastRefreshAt || nowIso;
  }

  providerSpecificRefreshUpdates.set(next, refreshedCredentials.providerSpecificData || {});
  return next;
}

function getRefreshLockKey(provider, credentials) {
  const stableId =
    credentials?.connectionId ||
    credentials?.id ||
    credentials?.email ||
    credentials?.name ||
    credentials?.refreshToken?.slice?.(-16) ||
    "default";
  return `${provider}:${stableId}`;
}

function getRefreshGenerationKey(provider, credentials) {
  const generation = [
    credentials?.accessToken, credentials?.refreshToken, credentials?.idToken,
    credentials?.copilotToken ?? credentials?.providerSpecificData?.copilotToken,
  ];
  const digest = createHash("sha256").update(JSON.stringify(generation)).digest("hex");
  return `${getRefreshLockKey(provider, credentials)}:${digest}`;
}

function hasRotatedTokens(credentials, result) {
  if (!result || result.error) return false;
  return ["accessToken", "refreshToken", "idToken"].some(key =>
    result[key] && result[key] !== credentials?.[key])
    || (result.copilotToken && result.copilotToken !==
      (credentials?.copilotToken ?? credentials?.providerSpecificData?.copilotToken));
}

export async function withCredentialRefreshLock(provider, credentials, refreshFn) {
  const key = getRefreshGenerationKey(provider, credentials);
  // Some special executors (Codex) delegate back into this manager. The same
  // async refresh operation must never await its own pending promise.
  if (refreshContext.getStore() === key) return refreshFn();
  const existing = refreshLocks.get(key);
  if (existing) return existing;
  const receipt = successfulRefreshes.get(key);
  if (receipt?.reusable) return reuseRefreshReceipt(receipt);
  const source = {
    ...(credentials?._connection || {}), ...credentials,
    provider, authType: credentials?.authType || credentials?._connection?.authType || "oauth",
  };

  const pending = Promise.resolve()
    .then(() => refreshContext.run(key, refreshFn))
    .then(result => {
      // Keep a successful rotated result available to a caller still holding
      // this consumed generation while persistence lags. Do not cache failed
      // attempts or unchanged token pairs; those may legitimately retry.
      if (result && !result.error && Object.values(tokenFields(result)).some(Boolean)) {
        const entry = {
          result, source, reusable: hasRotatedTokens(source, result),
          providerSpecificUpdates: Object.fromEntries(
            Object.entries(getProviderSpecificRefreshUpdates(result)).filter(([key, value]) =>
              JSON.stringify(value) !== JSON.stringify(source.providerSpecificData?.[key])),
          ),
          expiresAt: getCredentialExpiryMs(result)
            ?? (Number.isFinite(Number(result.expiresIn)) && Number(result.expiresIn) > 0
              ? Date.now() + Number(result.expiresIn) * 1000 : null),
        };
        providerSpecificRefreshUpdates.set(result, entry.providerSpecificUpdates);
        receiptSources.set(result, entry);
        successfulRefreshes.delete(key);
        successfulRefreshes.set(key, entry);
        while (successfulRefreshes.size > MEMORY_CONFIG.credentialRefreshResultsMaxSize) {
          successfulRefreshes.delete(successfulRefreshes.keys().next().value);
        }
      }
      return result;
    })
    .finally(() => {
      refreshLocks.delete(key);
    });

  refreshLocks.set(key, pending);
  return pending;
}

export async function refreshProviderCredentials(provider, credentials, log, proxyOptions = null) {
  if (!credentials) return null;

  return withCredentialRefreshLock(provider, credentials, async () => {
    const refreshed = await refreshTokenByProvider(provider, credentials, log, proxyOptions);
    return mergeRefreshedCredentials(provider, credentials, refreshed);
  });
}
