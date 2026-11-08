import { getModelInfo } from "../services/model.js";
import { getProviderCredentials } from "../services/auth.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";
import { withConnectionInFlight } from "./connectionInFlight.js";
import { settleUsageStats } from "open-sse/handlers/chatCore/requestDetail.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import {
  DEFAULT_SYSTEMONE_ROUTER_MODEL,
  DEFAULT_SYSTEMONE_TIMEOUT_MS,
  extractPromptState,
  buildChoiceCriteria,
  parseSystemOneRouteAnswer,
} from "open-sse/services/systemoneRouter.js";

/**
 * Dispatch an in-process System One decision evaluation for a combo request.
 * Resolves the configured router model's provider and credentials, sends the choice
 * query with a short timeout, and returns the parsed routing decision.
 *
 * Never throws: on missing credentials, timeout, or upstream failure, returns null
 * so combo dispatch fails open to standard model ordering.
 *
 * @param {object} opts
 * @param {object} opts.body - Client request body
 * @param {string[]} opts.models - Combo model candidate array
 * @param {string} [opts.routerModel] - System One router model (defaults to oc/jev-1.13-free)
 * @param {object} [opts.log] - Logger
 * @param {number} [opts.timeoutMs=DEFAULT_SYSTEMONE_TIMEOUT_MS] - Hard ceiling for router evaluation
 * @returns {Promise<{ choice: string, confidence: number|null, probabilities: Record<string, number>|null } | null>}
 */
export async function resolveSmartChoice({
  body,
  models,
  routerModel = DEFAULT_SYSTEMONE_ROUTER_MODEL,
  log,
  timeoutMs = DEFAULT_SYSTEMONE_TIMEOUT_MS,
  clientKeyId = null,
  abortSignal,
}) {
  if (!Array.isArray(models) || models.length <= 1) return null;

  const targetModel = (typeof routerModel === "string" && routerModel.trim())
    ? routerModel.trim()
    : DEFAULT_SYSTEMONE_ROUTER_MODEL;

  const state = extractPromptState(body);
  if (!state) {
    log?.debug?.("COMBO", "smart-router: empty prompt state, skipping classification");
    return null;
  }

  const criteria = buildChoiceCriteria(models);
  if (Object.keys(criteria).length === 0) return null;

  const controller = new AbortController();
  const signal = abortSignal ? AbortSignal.any([abortSignal, controller.signal]) : controller.signal;
  const timeoutId = setTimeout(() => controller.abort(new Error("System One router timed out")), timeoutMs);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, (async () => {
      signal.throwIfAborted();
      const modelInfo = await getModelInfo(targetModel);
      if (!modelInfo?.provider) {
        log?.warn?.("COMBO", `smart-router: unrecognized router model "${targetModel}"`);
        return null;
      }

      signal.throwIfAborted();
      const { provider, model } = modelInfo;
      const credentials = await getProviderCredentials(provider, new Set(), model, { clientKeyId });
      if (!credentials || credentials.allRateLimited) {
        log?.warn?.("COMBO", `smart-router: no credentials available for router provider "${provider}"`);
        return null;
      }

      signal.throwIfAborted();
      const refreshedCredentials = await checkAndRefreshToken(provider, credentials);
      signal.throwIfAborted();
      const systemoneBody = {
        model,
        state,
        questions: {
          route: {
            type: "choice",
            instructions: "Which of these configured models is the most appropriate for this request?",
            criteria,
          },
        },
      };

      const result = await withConnectionInFlight({ provider, model, connectionId: credentials.connectionId }, () => handleSystemoneCore({
        body: systemoneBody,
        modelInfo: { provider, model },
        credentials: refreshedCredentials,
        log,
        abortSignal: signal,
      }));

      if (!result?.success || !result.response) {
        log?.warn?.("COMBO", `smart-router: evaluation failed (${result?.status || "error"})`);
        return null;
      }

      if (result.usage) {
        await settleUsageStats({ provider, model, connectionId: credentials.connectionId,
          clientKeyId, endpoint: "/v1/systemone", tokens: result.usage });
      }
      const json = await result.response.json();
      const route = parseSystemOneRouteAnswer(json);
      if (!route || !route.choice) {
        log?.warn?.("COMBO", "smart-router: response missing valid route choice");
        return null;
      }

      return route;
    })()]);
  } catch (err) {
    log?.warn?.("COMBO", `smart-router: evaluation aborted (${err?.message || String(err)})`);
    return null;
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
